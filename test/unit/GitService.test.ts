import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitRunner } from '../../src/git/GitRunner';
import { GitService } from '../../src/git/GitService';
import { layoutCommitGraph } from '../../src/graph/layoutCommitGraph';
import { extractLineHistoryContextPatch } from '../../src/git/lineHistoryContext';
import { EMPTY_LOG_FILTERS } from '../../src/git/logQuery';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: '测试作者',
      GIT_AUTHOR_EMAIL: 'author@example.com',
      GIT_COMMITTER_NAME: 'CI Bot',
      GIT_COMMITTER_EMAIL: 'ci@example.com',
    },
  });
  return result.stdout.trim();
}

async function createHistoryFixture(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), 'git-log-workbench-service-'));
  temporaryDirectories.push(repository);
  await git(repository, 'init', '-b', 'main');
  await writeFile(join(repository, 'README.md'), 'first\n');
  await git(repository, 'add', 'README.md');
  await git(repository, 'commit', '-m', '初始提交');
  await writeFile(join(repository, 'README.md'), 'first\nsecond 🚀\n');
  await git(repository, 'add', 'README.md');
  await git(repository, 'commit', '-m', '修复登录 🚀', '-m', 'Detailed body with 中文.');
  await git(repository, 'tag', 'v1.0.0');
  return repository;
}

describe('GitService', () => {
  it('lists named stashes from a real repository', async () => {
    const repository = await createHistoryFixture();
    await writeFile(join(repository, 'README.md'), 'stashed\n');
    await git(repository, 'stash', 'push', '-m', 'saved work');

    const service = new GitService(new GitRunner());
    await expect(service.getStashes(repository)).resolves.toEqual([
      expect.objectContaining({ ref: 'stash@{0}', subject: expect.stringContaining('saved work') }),
    ]);
  });

  it('resolves exact hash searches with Git 2.27-compatible arguments', async () => {
    const hash = 'a'.repeat(40);
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: Buffer.from(`${hash}\n`),
        stderr: Buffer.alloc(0),
        exitCode: 0,
        durationMs: 1,
      })
      .mockResolvedValueOnce({
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        exitCode: 0,
        durationMs: 1,
      });
    const service = new GitService({ run } as unknown as GitRunner);

    await service.getLog('/workspace/project', {
      limit: 1,
      skip: 0,
      refs: [],
      filters: { ...EMPTY_LOG_FILTERS, text: hash },
    });

    expect(run).toHaveBeenNthCalledWith(
      1,
      ['rev-parse', '--verify', `${hash}^{commit}`],
      expect.objectContaining({ cwd: '/workspace/project' }),
    );
  });

  it('loads a complete commit message with a bounded Git output', async () => {
    const run = vi.fn().mockResolvedValue({
      stdout: Buffer.from('subject\n\nbody\n\n'),
      stderr: Buffer.alloc(0),
      exitCode: 0,
      durationMs: 1,
    });
    const service = new GitService({ run } as unknown as GitRunner);
    const hash = 'a'.repeat(40);

    await expect(service.getCommitMessage('/workspace/project', hash)).resolves.toBe(
      'subject\n\nbody\n',
    );
    expect(run).toHaveBeenCalledWith(
      ['show', '--no-patch', '--format=%B', hash, '--'],
      expect.objectContaining({ maxStdoutBytes: 400_004 }),
    );
  });

  it('loads refs, paged commits, and full details from a real repository', async () => {
    const modulePath = '../../src/git/GitService';
    const serviceModule = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(serviceModule, 'GitService must exist').toBeDefined();
    if (!serviceModule) return;

    const repository = await createHistoryFixture();
    const service = new serviceModule.GitService(new GitRunner());
    const refs = await service.getRefs(repository, 'main');
    const firstPage = await service.getLog(repository, { limit: 1, skip: 0, refs });
    const secondPage = await service.getLog(repository, { limit: 1, skip: 1, refs });
    const details = await service.getCommitDetails(repository, firstPage[0].hash, refs);
    const messageFiltered = await service.getLog(repository, {
      limit: 20,
      skip: 0,
      refs,
      filters: { ...EMPTY_LOG_FILTERS, text: '登录' },
    });
    const authorTextFiltered = await service.getLog(repository, {
      limit: 20,
      skip: 0,
      refs,
      filters: { ...EMPTY_LOG_FILTERS, text: '测试作者' },
    });
    const hashFiltered = await service.getLog(repository, {
      limit: 20,
      skip: 0,
      refs,
      filters: { ...EMPTY_LOG_FILTERS, text: firstPage[0].hash.slice(0, 10) },
    });

    expect(refs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'local', shortName: 'main', isCurrent: true }),
        expect.objectContaining({ kind: 'tag', shortName: 'v1.0.0' }),
      ]),
    );
    expect(firstPage).toHaveLength(1);
    expect(firstPage[0]).toMatchObject({ subject: '修复登录 🚀', authorName: '测试作者' });
    expect(firstPage[0].refs.map((ref: { shortName: string }) => ref.shortName)).toEqual(
      expect.arrayContaining(['main', 'v1.0.0']),
    );
    expect(secondPage).toHaveLength(1);
    expect(secondPage[0].subject).toBe('初始提交');
    expect(details.body).toContain('Detailed body with 中文.');
    expect(details.committerName).toBe('CI Bot');
    expect(messageFiltered.map((commit: { subject: string }) => commit.subject)).toEqual(['修复登录 🚀']);
    expect(authorTextFiltered).toHaveLength(2);
    expect(hashFiltered.map((commit: { hash: string }) => commit.hash)).toEqual([firstPage[0].hash]);
  });

  it('peels annotated tags so they decorate the tagged commit', async () => {
    const repository = await createHistoryFixture();
    await git(repository, 'tag', '-a', 'annotated-v2', '-m', 'annotated release');
    const service = new GitService(new GitRunner());
    const head = await git(repository, 'rev-parse', 'HEAD');
    const refs = await service.getRefs(repository, 'main');
    const annotated = refs.find((ref) => ref.shortName === 'annotated-v2');
    const commits = await service.getLog(repository, { limit: 1, skip: 0, refs });

    expect(annotated?.target).toBe(head);
    expect(commits[0]?.refs.map((ref) => ref.shortName)).toContain('annotated-v2');
  });

  it('checks whether a path exists as a blob at a revision', async () => {
    const repository = await createHistoryFixture();
    const revision = await git(repository, 'rev-parse', 'HEAD');
    const service = new GitService(new GitRunner());

    await expect(service.hasFileAtRevision(repository, revision, 'README.md')).resolves.toBe(true);
    await expect(service.hasFileAtRevision(repository, revision, 'missing.txt')).resolves.toBe(false);
  });

  it('uses a bounded output limit for a webview working-file patch', async () => {
    const run = vi.fn(async (args: readonly string[]) => ({
      stdout: args.includes('ls-tree')
        ? Buffer.from('100644 blob abcdef\tapp.txt\0')
        : args.includes('--filters')
          ? Buffer.from('old\n')
          : Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      exitCode: 0,
      durationMs: 1,
    }));
    const service = new GitService({ run } as never);

    await service.getWorkingFilePatch('/repo', 'a'.repeat(40), 'app.txt', 'new\n');

    const noIndexCall = run.mock.calls.find(([args]) => args.includes('--no-index')) as
      | [readonly string[], { maxStdoutBytes?: number }]
      | undefined;
    expect(noIndexCall?.[1].maxStdoutBytes).toBe(8 * 1024 * 1024);
  });

  it('loads a file patch with bounded context for current-line history', async () => {
    const run = vi.fn().mockResolvedValue({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
    const { GitService } = await import('../../src/git/GitService');

    await new GitService({ run } as never).getFilePatch(
      '/repo',
      'a'.repeat(40),
      'b'.repeat(40),
      'app.ts',
      undefined,
      undefined,
      3,
    );

    expect(run.mock.calls[0]?.[0]).toContain('--unified=3');
  });

  it('rejects a full-context file-history patch with too many rendered lines', async () => {
    const run = vi.fn().mockResolvedValue({
      stdout: Buffer.from('+x\n'.repeat(50_001)),
      stderr: Buffer.alloc(0),
      exitCode: 0,
      durationMs: 1,
    });

    await expect(
      new GitService({ run } as never).getFilePatch(
        '/repo',
        'a'.repeat(40),
        undefined,
        'app.txt',
      ),
    ).rejects.toThrow('more than 50000 lines');
    expect(run).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ maxStdoutBytes: 8 * 1024 * 1024 }),
    );
  });

  it('rejects a working-file patch with too many rendered lines', async () => {
    const run = vi.fn(async (args: readonly string[]) => ({
      stdout: args.includes('ls-tree')
        ? Buffer.from('100644 blob abcdef\tapp.txt\0')
        : args.includes('--filters')
          ? Buffer.from('old\n')
          : Buffer.from('+x\n'.repeat(50_001)),
      stderr: Buffer.alloc(0),
      exitCode: 0,
      durationMs: 1,
    }));

    await expect(
      new GitService({ run } as never).getWorkingFilePatch(
        '/repo',
        'a'.repeat(40),
        'app.txt',
        'new\n',
      ),
    ).rejects.toThrow('more than 50000 lines');
  });

  it('loads only commits reachable from the currently checked out HEAD by default', async () => {
    const repository = await createHistoryFixture();
    await git(repository, 'switch', '-c', 'feature');
    await writeFile(join(repository, 'feature.txt'), 'feature\n');
    await git(repository, 'add', 'feature.txt');
    await git(repository, 'commit', '-m', 'feature-only commit');
    const featureHash = await git(repository, 'rev-parse', 'HEAD');

    await git(repository, 'switch', 'main');
    await writeFile(join(repository, 'main.txt'), 'main\n');
    await git(repository, 'add', 'main.txt');
    await git(repository, 'commit', '-m', 'main-only commit');
    const mainHash = await git(repository, 'rev-parse', 'HEAD');

    const service = new GitService(new GitRunner());
    const mainCommits = await service.getLog(repository, { limit: 20, skip: 0, refs: [] });
    expect(mainCommits.map((commit) => commit.hash)).toContain(mainHash);
    expect(mainCommits.map((commit) => commit.hash)).not.toContain(featureHash);

    await git(repository, 'switch', 'feature');
    const featureCommits = await service.getLog(repository, { limit: 20, skip: 0, refs: [] });
    expect(featureCommits.map((commit) => commit.hash)).toContain(featureHash);
    expect(featureCommits.map((commit) => commit.hash)).not.toContain(mainHash);
  });

  it('finds an exact commit hash even when it is outside the current HEAD history', async () => {
    const repository = await createHistoryFixture();
    await git(repository, 'switch', '-c', 'feature');
    await git(repository, 'commit', '--allow-empty', '-m', 'feature hash target');
    const featureHash = await git(repository, 'rev-parse', 'HEAD');
    await git(repository, 'switch', 'main');

    const service = new GitService(new GitRunner());
    const commits = await service.getLog(repository, {
      limit: 20,
      skip: 0,
      refs: [],
      filters: { ...EMPTY_LOG_FILTERS, text: featureHash.slice(0, 10) },
    });

    expect(commits.map((commit) => commit.hash)).toEqual([featureHash]);
    expect(commits[0]).toMatchObject({ graphParents: [] });
  });

  it('uses configured remote names when a remote name contains a slash', async () => {
    const repository = await createHistoryFixture();
    await git(repository, 'remote', 'add', 'team/origin', '.');
    await git(
      repository,
      'update-ref',
      'refs/remotes/team/origin/feature',
      await git(repository, 'rev-parse', 'HEAD'),
    );

    const refs = await new GitService(new GitRunner()).getRefs(repository, 'main');

    expect(refs).toContainEqual(
      expect.objectContaining({
        fullName: 'refs/remotes/team/origin/feature',
        shortName: 'team/origin/feature',
        remote: 'team/origin',
      }),
    );
  });

  it('leaves overlapping remote tracking namespaces unowned', async () => {
    const repository = await createHistoryFixture();
    await git(repository, 'config', 'remote.team.url', '.');
    await git(repository, 'config', 'remote.team/origin.url', '.');
    await git(
      repository,
      'update-ref',
      'refs/remotes/team/origin/feature',
      await git(repository, 'rev-parse', 'HEAD'),
    );

    const refs = await new GitService(new GitRunner()).getRefs(repository, 'main');
    const ambiguous = refs.find(
      (ref) => ref.fullName === 'refs/remotes/team/origin/feature',
    );

    expect(ambiguous).toBeDefined();
    expect(ambiguous).not.toHaveProperty('remote');
  });

  it('keeps child-before-parent topology when text matches the child message and parent author', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'git-log-workbench-skew-'));
    temporaryDirectories.push(repository);
    await git(repository, 'init', '-b', 'main');
    const commitAt = async (
      path: string,
      subject: string,
      isoDate: string,
      authorName: string,
    ): Promise<void> => {
      await writeFile(join(repository, path), `${subject}\n`);
      await git(repository, 'add', path);
      await execFileAsync('git', ['commit', '-m', subject], {
        cwd: repository,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: authorName,
          GIT_AUTHOR_EMAIL: 'clock@example.com',
          GIT_COMMITTER_NAME: authorName,
          GIT_COMMITTER_EMAIL: 'clock@example.com',
          GIT_AUTHOR_DATE: isoDate,
          GIT_COMMITTER_DATE: isoDate,
        },
      });
    };
    await commitAt('parent.txt', 'base parent', '2025-01-01T00:00:00Z', 'Needle Parent');
    await commitAt('child.txt', 'needle child', '2024-01-01T00:00:00Z', 'Child Author');

    const service = new GitService(new GitRunner());
    const filters = { ...EMPTY_LOG_FILTERS, text: 'needle' };
    const first = await service.getLog(repository, { limit: 1, skip: 0, refs: [], filters });
    const second = await service.getLog(repository, { limit: 1, skip: 1, refs: [], filters });

    expect(first.map((commit) => commit.subject)).toEqual(['needle child']);
    expect(second.map((commit) => commit.subject)).toEqual(['base parent']);
  });

  it('keeps paged text-search results in canonical child-before-ancestor order across hidden commits', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'git-log-workbench-search-pages-'));
    temporaryDirectories.push(repository);
    await git(repository, 'init', '-b', 'main');
    const commitAt = async (
      path: string,
      subject: string,
      isoDate: string,
      authorName: string,
    ): Promise<void> => {
      await writeFile(join(repository, path), `${subject}\n`);
      await git(repository, 'add', path);
      await execFileAsync('git', ['commit', '-m', subject], {
        cwd: repository,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: authorName,
          GIT_AUTHOR_EMAIL: 'search@example.com',
          GIT_COMMITTER_NAME: authorName,
          GIT_COMMITTER_EMAIL: 'search@example.com',
          GIT_AUTHOR_DATE: isoDate,
          GIT_COMMITTER_DATE: isoDate,
        },
      });
    };
    await commitAt('ancestor.txt', 'base ancestor', '2026-01-01T00:00:00Z', 'Needle Author');
    await commitAt('middle.txt', 'hidden middle', '2025-01-01T00:00:00Z', 'Middle Author');
    await commitAt('child.txt', 'needle child', '2024-01-01T00:00:00Z', 'Child Author');

    const service = new GitService(new GitRunner());
    const filters = { ...EMPTY_LOG_FILTERS, text: 'needle' };
    const first = await service.getLog(repository, { limit: 1, skip: 0, refs: [], filters });
    const second = await service.getLog(repository, { limit: 1, skip: 1, refs: [], filters });
    const combined = await service.getLog(repository, { limit: 2, skip: 0, refs: [], filters });

    expect([...first, ...second].map((commit) => commit.hash)).toEqual(
      combined.map((commit) => commit.hash),
    );
    expect(combined.map((commit) => commit.subject)).toEqual(['needle child', 'base ancestor']);
    expect(combined[0]).toMatchObject({ graphParents: [combined[1]?.hash] });
    expect(combined[1]).toMatchObject({ graphParents: [] });
  });

  it('continues a cached canonical text scan instead of rescanning earlier history pages', async () => {
    const makeBatch = (start: number, count: number): Buffer =>
      Buffer.from(
        Array.from({ length: count }, (_, offset) => {
          const index = start + offset;
          const hash = index.toString(16).padStart(40, '0');
          const parent = (index + 1).toString(16).padStart(40, '0');
          return `\x1e${hash}\x00${parent}\x00Needle Author\x00needle@example.com\x00${String(
            20_000 - index,
          )}\x00${String(20_000 - index)}\x00commit ${String(index)}\x00body\x00`;
        }).join(''),
      );
    const run = vi.fn(async (args: readonly string[]) => {
      const skip = Number.parseInt(args.find((argument) => argument.startsWith('--skip='))?.slice(7) ?? '0', 10);
      return {
        stdout: makeBatch(skip, 5000),
        stderr: Buffer.alloc(0),
        exitCode: 0,
        durationMs: 1,
      };
    });
    const service = new GitService({ run } as never);
    const filters = { ...EMPTY_LOG_FILTERS, text: 'needle' };

    const first = await service.getLog('/repository', { limit: 5000, skip: 0, refs: [], filters });
    const firstPageLastGraphParents = [...(first.at(-1)?.graphParents ?? [])];
    const second = await service.getLog('/repository', {
      limit: 5000,
      skip: 5000,
      refs: [],
      filters,
    });
    const third = await service.getLog('/repository', {
      limit: 5000,
      skip: 10_000,
      refs: [],
      filters,
    });

    expect(first).toHaveLength(5000);
    expect(second).toHaveLength(5000);
    expect(third).toHaveLength(5000);
    expect(firstPageLastGraphParents).toEqual([(5000).toString(16).padStart(40, '0')]);
    expect(run.mock.calls.map(([args]) => args)).toEqual([
      expect.arrayContaining(['--max-count=5000', '--skip=0']),
      expect.arrayContaining(['--max-count=5000', '--skip=5000']),
      expect.arrayContaining(['--max-count=5000', '--skip=10000']),
      expect.arrayContaining(['--max-count=5000', '--skip=15000']),
    ]);
    const calls = run.mock.calls as unknown as Array<
      [readonly string[], { maxStdoutBytes?: number }]
    >;
    expect(calls.every(([, options]) => options.maxStdoutBytes === 64 * 1024 * 1024)).toBe(true);
  });

  it('preserves visible merge parent order across hidden commits', async () => {
    const hashes = Object.fromEntries(
      ['merge', 'hidden-first', 'hidden-second', 'visible-first', 'visible-second'].map(
        (name, index) => [name, (index + 1).toString(16).padStart(40, '0')],
      ),
    );
    const record = (hash: string, parents: string[], subject: string): string =>
      `\x1e${hash}\x00${parents.join(' ')}\x00Author\x00author@example.com\x001\x001\x00${subject}\x00${subject}\x00`;
    const output = Buffer.from(
      [
        record(hashes.merge ?? '', [hashes['hidden-first'] ?? '', hashes['hidden-second'] ?? ''], 'needle merge'),
        record(hashes['hidden-second'] ?? '', [hashes['visible-second'] ?? ''], 'hidden second'),
        record(hashes['visible-second'] ?? '', [], 'needle second'),
        record(hashes['hidden-first'] ?? '', [hashes['visible-first'] ?? ''], 'hidden first'),
        record(hashes['visible-first'] ?? '', [], 'needle first'),
      ].join(''),
    );
    const run = vi.fn().mockResolvedValue({
      stdout: output,
      stderr: Buffer.alloc(0),
      exitCode: 0,
      durationMs: 1,
    });

    const commits = await new GitService({ run } as never).getLog('/repository', {
      limit: 20,
      skip: 0,
      refs: [],
      filters: { ...EMPTY_LOG_FILTERS, text: 'needle' },
    });

    expect(commits[0]?.graphParents).toEqual([
      hashes['visible-first'],
      hashes['visible-second'],
    ]);
  });

  it('projects hidden merge paths directly onto matching commits', async () => {
    const hashes = Object.fromEntries(
      ['visible', 'hidden-merge', 'first', 'second'].map((name, index) => [
        name,
        (index + 10).toString(16).padStart(40, '0'),
      ]),
    );
    const record = (hash: string, parents: string[], subject: string): string =>
      `\x1e${hash}\x00${parents.join(' ')}\x00Author\x00author@example.com\x001\x001\x00${subject}\x00${subject}\x00`;
    const output = Buffer.from(
      [
        record(hashes.visible ?? '', [hashes['hidden-merge'] ?? ''], 'needle visible'),
        record(
          hashes['hidden-merge'] ?? '',
          [hashes.first ?? '', hashes.second ?? ''],
          'hidden merge',
        ),
        record(hashes.second ?? '', [], 'needle second'),
        record(hashes.first ?? '', [], 'needle first'),
      ].join(''),
    );
    const run = vi.fn().mockResolvedValue({
      stdout: output,
      stderr: Buffer.alloc(0),
      exitCode: 0,
      durationMs: 1,
    });

    const commits = await new GitService({ run } as never).getLog('/repository', {
      limit: 20,
      skip: 0,
      refs: [],
      filters: { ...EMPTY_LOG_FILTERS, text: 'needle' },
    });

    expect(commits.map((commit) => commit.subject)).toEqual([
      'needle visible',
      'needle second',
      'needle first',
    ]);
    expect(commits[0]?.graphParents).toEqual([hashes.first, hashes.second]);
    expect(commits.every((commit) => commit.filterMatch !== false)).toBe(true);
  });

  it('returns only commits whose content matches the text query', async () => {
    const [top, merge, first, second] = Array.from({ length: 4 }, (_, index) =>
      (index + 20).toString(16).padStart(40, '0'),
    );
    const record = (hash: string, parents: string[], subject: string): string =>
      `\x1e${hash}\x00${parents.join(' ')}\x00Author\x00author@example.com\x001\x001\x00${subject}\x00${subject}\x00`;
    const run = vi.fn().mockResolvedValue({
      stdout: Buffer.from(
        [
          record(top ?? '', [merge ?? ''], 'needle top'),
          record(merge ?? '', [first ?? '', second ?? ''], 'unrelated merge'),
          record(first ?? '', [], 'needle first'),
          record(second ?? '', [], 'needle second'),
        ].join(''),
      ),
      stderr: Buffer.alloc(0),
      exitCode: 0,
      durationMs: 1,
    });

    const commits = await new GitService({ run } as never).getLog('/repository', {
      limit: 20,
      skip: 0,
      refs: [],
      filters: { ...EMPTY_LOG_FILTERS, text: 'needle' },
    });

    expect(commits.map((commit) => commit.subject)).toEqual([
      'needle top',
      'needle first',
      'needle second',
    ]);
    expect(commits.every((commit) => commit.filterMatch !== false)).toBe(true);
    expect(commits[0]?.graphParents).toEqual([first, second]);
  });

  it('rejoins compact visible branches at their next shared visible ancestor', async () => {
    const names = [
      'visible-top',
      'hidden-merge',
      'hidden-left',
      'visible-left',
      'hidden-right',
      'visible-right',
      'hidden-shared',
      'visible-base',
    ] as const;
    const hashes = Object.fromEntries(
      names.map((name, index) => [name, (index + 30).toString(16).padStart(40, '0')]),
    ) as Record<(typeof names)[number], string>;
    const record = (hash: string, parents: string[], subject: string): string =>
      `\x1e${hash}\x00${parents.join(' ')}\x00Author\x00author@example.com\x001\x001\x00${subject}\x00${subject}\x00`;
    const output = Buffer.from(
      [
        record(hashes['visible-top'], [hashes['hidden-merge']], 'needle top'),
        record(
          hashes['hidden-merge'],
          [hashes['hidden-left'], hashes['hidden-right']],
          'hidden merge',
        ),
        record(hashes['hidden-left'], [hashes['visible-left']], 'hidden left'),
        record(hashes['visible-left'], [hashes['hidden-shared']], 'needle left'),
        record(hashes['hidden-right'], [hashes['visible-right']], 'hidden right'),
        record(hashes['visible-right'], [hashes['hidden-shared']], 'needle right'),
        record(hashes['hidden-shared'], [hashes['visible-base']], 'hidden shared'),
        record(hashes['visible-base'], [], 'needle base'),
      ].join(''),
    );
    const run = vi.fn().mockResolvedValue({
      stdout: output,
      stderr: Buffer.alloc(0),
      exitCode: 0,
      durationMs: 1,
    });

    const commits = await new GitService({ run } as never).getLog('/repository', {
      limit: 20,
      skip: 0,
      refs: [],
      filters: { ...EMPTY_LOG_FILTERS, text: 'needle' },
    });
    const graph = layoutCommitGraph(commits);

    expect(commits.map((commit) => commit.subject)).toEqual([
      'needle top',
      'needle left',
      'needle right',
      'needle base',
    ]);
    expect(commits.map((commit) => commit.graphParents)).toEqual([
      [hashes['visible-left'], hashes['visible-right']],
      [hashes['visible-base']],
      [hashes['visible-base']],
      [],
    ]);
    expect(commits.every((commit) => commit.filterMatch !== false)).toBe(true);
    expect(graph.maxLaneCount).toBe(2);
    expect(graph.rows[2]?.connections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fromLane: 1, toLane: 0, kind: 'parent' }),
      ]),
    );
    expect(graph.continuation.lanes).toEqual([]);
  });

  it('does not return repeated hidden split-and-rejoin segments as search results', async () => {
    const diamondCount = 8;
    let nextHash = 100;
    const hash = (): string => (nextHash++).toString(16).padStart(40, '0');
    const record = (commitHash: string, parents: string[], subject: string): string =>
      `\x1e${commitHash}\x00${parents.join(' ')}\x00Author\x00author@example.com\x001\x001\x00${subject}\x00${subject}\x00`;
    const top = hash();
    const base = hash();
    const diamonds = Array.from({ length: diamondCount }, () => ({
      split: hash(),
      left: hash(),
      right: hash(),
      join: hash(),
    }));
    const output: string[] = [];
    output.push(record(top, [diamonds[0]?.split ?? base], 'needle top'));
    for (const [index, diamond] of diamonds.entries()) {
      const next = diamonds[index + 1]?.split ?? base;
      output.push(
        record(diamond.split, [diamond.left, diamond.right], `hidden split ${String(index)}`),
        record(diamond.left, [diamond.join], `hidden left ${String(index)}`),
        record(diamond.right, [diamond.join], `hidden right ${String(index)}`),
        record(diamond.join, [next], `hidden join ${String(index)}`),
      );
    }
    output.push(record(base, [], 'needle base'));
    const run = vi.fn().mockResolvedValue({
      stdout: Buffer.from(output.join('')),
      stderr: Buffer.alloc(0),
      exitCode: 0,
      durationMs: 1,
    });

    const commits = await new GitService({ run } as never).getLog('/repository', {
      limit: 20,
      skip: 0,
      refs: [],
      filters: { ...EMPTY_LOG_FILTERS, text: 'needle' },
    });
    const graph = layoutCommitGraph(commits);
    const connectionCount = graph.rows.reduce(
      (total, row) => total + row.connections.length,
      0,
    );

    expect(commits.map((commit) => commit.subject)).toEqual(['needle top', 'needle base']);
    expect(commits.every((commit) => commit.filterMatch !== false)).toBe(true);
    expect(commits[0]?.graphParents).toEqual([base]);
    expect(graph.maxLaneCount).toBe(1);
    expect(connectionCount).toBeLessThanOrEqual(commits.length * 3);
    expect(graph.continuation.lanes).toEqual([]);
  });

  it('reconnects a deep hidden merge chain to its visible parent', async () => {
    const hiddenCount = 80;
    let nextHash = 300;
    const hash = (): string => (nextHash++).toString(16).padStart(40, '0');
    const top = hash();
    const base = hash();
    const hidden = Array.from({ length: hiddenCount }, hash);
    const noise = Array.from({ length: hiddenCount }, hash);
    const sides = Array.from({ length: hiddenCount }, hash);
    const record = (commitHash: string, parents: string[], subject: string): string =>
      `\x1e${commitHash}\x00${parents.join(' ')}\x00Author\x00author@example.com\x001\x001\x00${subject}\x00${subject}\x00`;
    const output = [record(top, [hidden[0] ?? base], 'needle top')];
    for (let index = 0; index < hiddenCount; index += 1) {
      output.push(
        record(noise[index] ?? '', [], `needle unrelated ${String(index)}`),
        record(
          hidden[index] ?? '',
          [hidden[index + 1] ?? base, sides[index] ?? ''],
          `hidden merge ${String(index)}`,
        ),
      );
    }
    output.push(record(base, [], 'needle base'));
    const run = vi.fn().mockResolvedValue({
      stdout: Buffer.from(output.join('')),
      stderr: Buffer.alloc(0),
      exitCode: 0,
      durationMs: 1,
    });

    const commits = await new GitService({ run } as never).getLog('/repository', {
      limit: 200,
      skip: 0,
      refs: [],
      filters: { ...EMPTY_LOG_FILTERS, text: 'needle' },
    });

    expect(commits).toHaveLength(hiddenCount + 2);
    expect(commits.every((commit) => commit.filterMatch !== false)).toBe(true);
    expect(commits[0]?.graphParents).toEqual([base]);
    expect(layoutCommitGraph(commits).continuation.lanes).toEqual([]);
  });

  it('caps structural graph rows and closes routes that exceed the render budget', async () => {
    let nextHash = 500;
    const hash = (): string => (nextHash++).toString(16).padStart(40, '0');
    const record = (commitHash: string, parents: string[], subject: string): string =>
      `\x1e${commitHash}\x00${parents.join(' ')}\x00Author\x00author@example.com\x001\x001\x00${subject}\x00${subject}\x00`;
    const top = hash();
    const base = hash();
    const diamonds = Array.from({ length: 20 }, () => ({
      split: hash(),
      left: hash(),
      right: hash(),
      join: hash(),
    }));
    const output = [record(top, [diamonds[0]?.split ?? base], 'needle top')];
    for (const [index, diamond] of diamonds.entries()) {
      output.push(
        record(diamond.split, [diamond.left, diamond.right], `hidden split ${String(index)}`),
        record(diamond.left, [diamond.join], `hidden left ${String(index)}`),
        record(diamond.right, [diamond.join], `hidden right ${String(index)}`),
        record(
          diamond.join,
          [diamonds[index + 1]?.split ?? base],
          `hidden join ${String(index)}`,
        ),
      );
    }
    output.push(record(base, [], 'needle base'));
    const run = vi.fn().mockResolvedValue({
      stdout: Buffer.from(output.join('')),
      stderr: Buffer.alloc(0),
      exitCode: 0,
      durationMs: 1,
    });

    const commits = await new GitService({ run } as never).getLog('/repository', {
      limit: 2,
      skip: 0,
      refs: [],
      filters: { ...EMPTY_LOG_FILTERS, text: 'needle' },
      maxGraphRows: 10,
    });
    const returnedHashes = new Set(commits.map((commit) => commit.hash));

    expect(commits.length).toBeLessThanOrEqual(10);
    expect(commits.filter((commit) => commit.filterMatch !== false)).toHaveLength(2);
    expect(
      commits.every((commit) =>
        (commit.graphParents ?? commit.parents).every((parent) => returnedHashes.has(parent)),
      ),
    ).toBe(true);
    expect(layoutCommitGraph(commits).continuation.lanes).toEqual([]);
  });

  it('does not leave a cross-page route to structural context omitted by the next page', async () => {
    const [first, second, context, left, right] = Array.from({ length: 5 }, (_, index) =>
      (index + 800).toString(16).padStart(40, '0'),
    );
    const record = (commitHash: string, parents: string[], subject: string): string =>
      `\x1e${commitHash}\x00${parents.join(' ')}\x00Author\x00author@example.com\x001\x001\x00${subject}\x00${subject}\x00`;
    const run = vi.fn().mockResolvedValue({
      stdout: Buffer.from(
        [
          record(first ?? '', [context ?? ''], 'needle first'),
          record(second ?? '', [], 'needle second'),
          record(context ?? '', [left ?? '', right ?? ''], 'hidden context'),
          record(left ?? '', [], 'hidden left'),
          record(right ?? '', [], 'hidden right'),
        ].join(''),
      ),
      stderr: Buffer.alloc(0),
      exitCode: 0,
      durationMs: 1,
    });
    const service = new GitService({ run } as never);
    const filters = { ...EMPTY_LOG_FILTERS, text: 'needle' };

    const firstPage = await service.getLog('/repository', {
      limit: 1,
      skip: 0,
      refs: [],
      filters,
      maxGraphRows: 1,
    });
    const secondPage = await service.getLog('/repository', {
      limit: 1,
      skip: 1,
      refs: [],
      filters,
      maxGraphRows: 1,
    });
    const firstGraph = layoutCommitGraph(firstPage);
    const secondGraph = layoutCommitGraph(secondPage, firstGraph.continuation);

    expect(firstPage[0]?.graphParents).toEqual([]);
    expect(secondPage.map((commit) => commit.subject)).toEqual(['needle second']);
    expect(secondGraph.continuation.lanes).toEqual([]);
  });

  it('keeps cached graph projection stable when a later request has a larger row budget', async () => {
    let nextHash = 850;
    const hash = (): string => (nextHash++).toString(16).padStart(40, '0');
    const [top, split, left, right, join, base] = Array.from({ length: 6 }, hash);
    const record = (commitHash: string, parents: string[], subject: string): string =>
      `\x1e${commitHash}\x00${parents.join(' ')}\x00Author\x00author@example.com\x001\x001\x00${subject}\x00${subject}\x00`;
    const run = vi.fn().mockResolvedValue({
      stdout: Buffer.from(
        [
          record(top ?? '', [split ?? ''], 'needle top'),
          record(split ?? '', [left ?? '', right ?? ''], 'hidden split'),
          record(left ?? '', [join ?? ''], 'hidden left'),
          record(right ?? '', [join ?? ''], 'hidden right'),
          record(join ?? '', [base ?? ''], 'hidden join'),
          record(base ?? '', [], 'needle base'),
        ].join(''),
      ),
      stderr: Buffer.alloc(0),
      exitCode: 0,
      durationMs: 1,
    });
    const service = new GitService({ run } as never);
    const filters = { ...EMPTY_LOG_FILTERS, text: 'needle' };

    const compact = await service.getLog('/repository', {
      limit: 1,
      skip: 0,
      refs: [],
      filters,
      maxGraphRows: 1,
    });
    const expanded = await service.getLog('/repository', {
      limit: 2,
      skip: 0,
      refs: [],
      filters,
      maxGraphRows: 5,
    });

    expect(compact).toHaveLength(1);
    expect(expanded).toHaveLength(2);
    expect(expanded.every((commit) => commit.filterMatch !== false)).toBe(true);
    expect(expanded[0]?.graphParents).toEqual([base]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('keeps a branch anchor when the preferred hidden path rejoins a direct parent', async () => {
    const [top, split, hidden, join, base] = Array.from({ length: 5 }, (_, index) =>
      (index + 900).toString(16).padStart(40, '0'),
    );
    const record = (commitHash: string, parents: string[], subject: string): string =>
      `\x1e${commitHash}\x00${parents.join(' ')}\x00Author\x00author@example.com\x001\x001\x00${subject}\x00${subject}\x00`;
    const run = vi.fn().mockResolvedValue({
      stdout: Buffer.from(
        [
          record(top ?? '', [split ?? ''], 'needle top'),
          record(split ?? '', [hidden ?? '', join ?? ''], 'hidden split'),
          record(hidden ?? '', [join ?? ''], 'hidden branch'),
          record(join ?? '', [base ?? ''], 'hidden join'),
          record(base ?? '', [], 'needle base'),
        ].join(''),
      ),
      stderr: Buffer.alloc(0),
      exitCode: 0,
      durationMs: 1,
    });

    const commits = await new GitService({ run } as never).getLog('/repository', {
      limit: 2,
      skip: 0,
      refs: [],
      filters: { ...EMPTY_LOG_FILTERS, text: 'needle' },
    });
    const graph = layoutCommitGraph(commits);

    expect(commits.map((commit) => commit.subject)).toEqual([
      'needle top',
      'needle base',
    ]);
    expect(commits[0]?.graphParents).toEqual([base]);
    expect(graph.maxLaneCount).toBe(1);
    expect(graph.continuation.lanes).toEqual([]);
  });

  it('does not revise a returned graph frontier when lookahead matches another branch', async () => {
    const sourceHash = 'a'.repeat(40);
    const unrelatedHash = 'b'.repeat(40);
    const delayedParentHash = 'c'.repeat(40);
    const record = (hash: string, parents: string[], subject: string): string =>
      `\x1e${hash}\x00${parents.join(' ')}\x00Author\x00author@example.com\x001\x001\x00${subject}\x00${subject}\x00`;
    const firstBatch = Buffer.from(
      [
        record(sourceHash, [delayedParentHash], 'needle source'),
        record(unrelatedHash, [], 'needle unrelated'),
        ...Array.from({ length: 4998 }, (_, index) =>
          record((index + 100).toString(16).padStart(40, '0'), [], 'hidden'),
        ),
      ].join(''),
    );
    const noMatchBatch = Buffer.from(
      Array.from({ length: 5000 }, (_, index) =>
        record((index + 6000).toString(16).padStart(40, '0'), [], 'hidden'),
      ).join(''),
    );
    const delayedParentBatch = Buffer.from(
      record(delayedParentHash, [], 'needle delayed parent'),
    );
    const run = vi.fn(async (args: readonly string[]) => {
      const skip = args.find((argument) => argument.startsWith('--skip='));
      return {
        stdout:
          skip === '--skip=0'
            ? firstBatch
            : skip === '--skip=5000'
              ? noMatchBatch
              : delayedParentBatch,
        stderr: Buffer.alloc(0),
        exitCode: 0,
        durationMs: 1,
      };
    });
    const service = new GitService({ run } as never);
    const filters = { ...EMPTY_LOG_FILTERS, text: 'needle' };

    const first = await service.getLog('/repository', {
      limit: 1,
      skip: 0,
      refs: [],
      filters,
    });
    expect(first[0]?.graphParents).toEqual([]);

    await service.getLog('/repository', { limit: 2, skip: 1, refs: [], filters });
    const repeated = await service.getLog('/repository', {
      limit: 1,
      skip: 0,
      refs: [],
      filters,
    });

    expect(first[0]?.graphParents).toEqual([]);
    expect(repeated[0]?.graphParents).toEqual([]);
  });

  it('bounds graph lookahead when a full page has no later matches', async () => {
    const limit = 20;
    const delayedParentHash = 'f'.repeat(40);
    const record = (hash: string, parents: string[], subject: string): string =>
      `\x1e${hash}\x00${parents.join(' ')}\x00Author\x00author@example.com\x001\x001\x00${subject}\x00${subject}\x00`;
    const firstBatch = Buffer.from(
      Array.from({ length: 5000 }, (_, index) =>
        record(
          (index + 1).toString(16).padStart(40, '0'),
          index === limit - 1 ? [delayedParentHash] : [],
          index < limit ? `needle ${String(index)}` : 'hidden',
        ),
      ).join(''),
    );
    const noMatchBatch = Buffer.from(
      Array.from({ length: 5000 }, (_, index) =>
        record((index + 6000).toString(16).padStart(40, '0'), [], 'hidden'),
      ).join(''),
    );
    const run = vi.fn(async (args: readonly string[]) => {
      const skip = args.find((argument) => argument.startsWith('--skip='));
      if (skip === '--skip=0') {
        return { stdout: firstBatch, stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
      }
      if (skip === '--skip=5000') {
        return { stdout: noMatchBatch, stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
      }
      throw new Error(`Unexpected unbounded lookahead at ${skip ?? 'unknown offset'}`);
    });

    const commits = await new GitService({ run } as never).getLog('/repository', {
      limit,
      skip: 0,
      refs: [],
      filters: { ...EMPTY_LOG_FILTERS, text: 'needle' },
    });

    expect(commits).toHaveLength(limit);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('allows ordinary non-text history pages beyond fifty thousand commits', async () => {
    const run = vi.fn().mockResolvedValue({
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      exitCode: 0,
      durationMs: 1,
    });
    const service = new GitService({ run } as never);

    await expect(service.getLog('/repository', { limit: 500, skip: 100_000, refs: [] })).resolves.toEqual([]);
    expect(run).toHaveBeenCalledWith(
      expect.arrayContaining(['--max-count=500', '--skip=100000']),
      expect.any(Object),
    );
  });

  it('matches text in the full commit body while preserving canonical Git order', async () => {
    const repository = await createHistoryFixture();
    const service = new GitService(new GitRunner());

    const commits = await service.getLog(repository, {
      limit: 20,
      skip: 0,
      refs: [],
      filters: { ...EMPTY_LOG_FILTERS, text: 'Detailed body' },
    });

    expect(commits.map((commit) => commit.subject)).toEqual(['修复登录 🚀']);
  });

  it('falls back to message search when hexadecimal-looking text is not a commit hash', async () => {
    const repository = await createHistoryFixture();
    await writeFile(join(repository, 'numeric.txt'), 'numeric search\n');
    await git(repository, 'add', 'numeric.txt');
    await git(repository, 'commit', '-m', 'fix(pages): 3333311111231调整资产');
    const service = new GitService(new GitRunner());

    const commits = await service.getLog(repository, {
      limit: 20,
      skip: 0,
      refs: [],
      filters: { ...EMPTY_LOG_FILTERS, text: '33333' },
    });

    expect(commits.map((commit) => commit.subject)).toEqual([
      'fix(pages): 3333311111231调整资产',
    ]);
  });

  it('invalidates exhausted text-search caches when repository state changes', async () => {
    let output = Buffer.alloc(0);
    const run = vi.fn().mockImplementation(() =>
      Promise.resolve({ stdout: output, stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 }),
    );
    const service = new GitService({ run } as never);
    const query = {
      limit: 20,
      skip: 0,
      refs: [],
      filters: { ...EMPTY_LOG_FILTERS, text: 'needle' },
    };

    await expect(service.getLog('/repository', query)).resolves.toEqual([]);
    output = Buffer.from(
      `\x1e${'a'.repeat(40)}\x00\x00Alice\x00alice@example.com\x001\x001\x00needle\x00needle\x00`,
    );
    await expect(service.getLog('/repository', query)).resolves.toEqual([]);
    service.invalidateLogCache('/repository');
    await expect(service.getLog('/repository', query)).resolves.toEqual([
      expect.objectContaining({ subject: 'needle' }),
    ]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('rejects branch filters that are not present in the repository ref snapshot', async () => {
    const run = vi.fn();
    const service = new GitService({ run } as never);
    await expect(
      service.getLog('/repository', {
        limit: 20,
        skip: 0,
        refs: [
          {
            fullName: 'refs/heads/main',
            shortName: 'main',
            kind: 'local',
            target: 'a'.repeat(40),
            ahead: 0,
            behind: 0,
            isCurrent: true,
          },
        ],
        filters: { ...EMPTY_LOG_FILTERS, branches: ['refs/heads/not-present'] },
      }),
    ).rejects.toThrow('Unknown branch filter');
    expect(run).not.toHaveBeenCalled();
  });

  it('returns an empty log for a repository without commits', async () => {
    const modulePath = '../../src/git/GitService';
    const serviceModule = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(serviceModule, 'GitService must exist').toBeDefined();
    if (!serviceModule) return;

    const repository = await mkdtemp(join(tmpdir(), 'git-log-workbench-service-'));
    temporaryDirectories.push(repository);
    await git(repository, 'init', '-b', 'main');

    const service = new serviceModule.GitService(new GitRunner());

    await expect(service.getLog(repository, { limit: 200, skip: 0, refs: [] })).resolves.toEqual([]);
  });

  it('rejects a revision that could be interpreted as a Git option', async () => {
    const modulePath = '../../src/git/GitService';
    const serviceModule = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(serviceModule, 'GitService must exist').toBeDefined();
    if (!serviceModule) return;

    const repository = await createHistoryFixture();
    const service = new serviceModule.GitService(new GitRunner());

    await expect(service.getCommitDetails(repository, '--output=/tmp/unsafe', [])).rejects.toThrow(
      'Invalid commit hash',
    );
  });

  it('returns every parent of a merge commit', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'git-log-workbench-service-'));
    temporaryDirectories.push(repository);
    await git(repository, 'init', '-b', 'main');
    await writeFile(join(repository, 'base.txt'), 'base\n');
    await git(repository, 'add', 'base.txt');
    await git(repository, 'commit', '-m', 'base');
    await git(repository, 'checkout', '-b', 'feature');
    await writeFile(join(repository, 'feature.txt'), 'feature\n');
    await git(repository, 'add', 'feature.txt');
    await git(repository, 'commit', '-m', 'feature');
    await git(repository, 'checkout', 'main');
    await writeFile(join(repository, 'main.txt'), 'main\n');
    await git(repository, 'add', 'main.txt');
    await git(repository, 'commit', '-m', 'main');
    await git(repository, 'merge', '--no-ff', 'feature', '-m', 'merge feature');

    const service = new GitService(new GitRunner());
    const commits = await service.getLog(repository, { limit: 10, skip: 0, refs: [] });

    expect(commits[0]).toMatchObject({ subject: 'merge feature' });
    expect(commits[0]?.parents).toHaveLength(2);
  });

  it('loads added, modified, deleted, renamed, and binary changed files', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'git-log-workbench-service-'));
    temporaryDirectories.push(repository);
    await git(repository, 'init', '-b', 'main');
    await writeFile(join(repository, 'modify.txt'), 'before\n');
    await writeFile(join(repository, 'delete.txt'), 'delete me\n');
    await writeFile(join(repository, 'rename-before.txt'), 'rename content\n');
    await git(repository, 'add', '.');
    await git(repository, 'commit', '-m', 'base files');
    await writeFile(join(repository, 'modify.txt'), 'before\nafter\n');
    await unlink(join(repository, 'delete.txt'));
    await git(repository, 'mv', 'rename-before.txt', 'rename-after.txt');
    await writeFile(join(repository, 'added 中文.txt'), 'new file\n');
    await writeFile(join(repository, 'logo.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
    await git(repository, 'add', '-A');
    await git(repository, 'commit', '-m', 'all change kinds');

    const service = new GitService(new GitRunner());
    const commits = await service.getLog(repository, { limit: 2, skip: 0, refs: [] });
    const changedFiles = await service.getChangedFiles(repository, commits[0]?.hash ?? '');

    expect(changedFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'M', path: 'modify.txt', additions: 1, binary: false }),
        expect.objectContaining({ status: 'D', path: 'delete.txt' }),
        expect.objectContaining({ status: 'R', oldPath: 'rename-before.txt', path: 'rename-after.txt' }),
        expect.objectContaining({ status: 'A', path: 'added 中文.txt' }),
        expect.objectContaining({ status: 'A', path: 'logo.bin', binary: true }),
      ]),
    );
    const textContent = await service.getFileContent(
      repository,
      commits[0]?.hash ?? '',
      'added 中文.txt',
    );
    expect(textContent.toString('utf8')).toBe('new file\n');
  });

  it('detects a copied file even when the source is unchanged', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'git-log-workbench-copy-'));
    temporaryDirectories.push(repository);
    await git(repository, 'init', '-b', 'main');
    await writeFile(join(repository, 'source.txt'), 'copy this content\n');
    await git(repository, 'add', 'source.txt');
    await git(repository, 'commit', '-m', 'source');
    await writeFile(join(repository, 'copied.txt'), 'copy this content\n');
    await git(repository, 'add', 'copied.txt');
    await git(repository, 'commit', '-m', 'copy source');

    const service = new GitService(new GitRunner());
    const [latest] = await service.getLog(repository, { limit: 1, skip: 0, refs: [] });
    const changedFiles = await service.getChangedFiles(repository, latest?.hash ?? '');

    expect(changedFiles).toContainEqual(
      expect.objectContaining({ status: 'C', oldPath: 'source.txt', path: 'copied.txt' }),
    );
  });

  it('runs exhaustive copy detection only for file status and caps its candidate search', async () => {
    const hash = 'a'.repeat(40);
    const parent = 'b'.repeat(40);
    const run = vi.fn(async (args: readonly string[]) => ({
      stdout: args.includes('--name-status')
        ? Buffer.from('C100\0source.txt\0copied.txt\0')
        : args.includes('--numstat')
          ? Buffer.from('1\t0\tcopied.txt\0')
          : Buffer.from(
              [hash, parent, 'Alice', 'alice@example.com', '1', 'Alice', 'alice@example.com', '1', 'subject', 'G'].join('\0'),
            ),
      stderr: Buffer.alloc(0),
      exitCode: 0,
      durationMs: 1,
    }));
    const service = new GitService({ run } as unknown as GitRunner);

    const files = await service.getChangedFiles('/repo', hash, parent);

    expect(files).toEqual([
      expect.objectContaining({
        status: 'C',
        oldPath: 'source.txt',
        path: 'copied.txt',
        additions: 1,
      }),
    ]);
    const statusArgs = run.mock.calls.find(([args]) => args.includes('--name-status'))?.[0];
    const numstatArgs = run.mock.calls.find(([args]) => args.includes('--numstat'))?.[0];
    expect(statusArgs).toContain('--find-copies-harder');
    expect(statusArgs).toContain('-l1000');
    expect(numstatArgs).not.toContain('--find-copies-harder');
    expect(numstatArgs).not.toContain('-C');
  });

  it('indexes refs by target once when decorating a log page', async () => {
    const commitCount = 50;
    const refsCount = 80;
    let targetReads = 0;
    const refs = Array.from({ length: refsCount }, (_, index) => {
      const target = index < commitCount ? index.toString(16).padStart(40, '0') : 'f'.repeat(40);
      return {
        fullName: `refs/tags/tag-${String(index)}`,
        shortName: `tag-${String(index)}`,
        kind: 'tag' as const,
        get target() {
          targetReads += 1;
          return target;
        },
        ahead: 0,
        behind: 0,
        isCurrent: false,
      };
    });
    const output = Array.from({ length: commitCount }, (_, index) =>
      `\x1e${index.toString(16).padStart(40, '0')}\x00\x00Alice\x00alice@example.com\x001\x001\x00commit ${String(index)}\x00`,
    ).join('');
    const run = vi.fn().mockResolvedValue({
      stdout: Buffer.from(output),
      stderr: Buffer.alloc(0),
      exitCode: 0,
      durationMs: 1,
    });

    const commits = await new GitService({ run } as unknown as GitRunner).getLog('/repo', {
      limit: commitCount,
      skip: 0,
      refs,
    });

    expect(commits).toHaveLength(commitCount);
    expect(targetReads).toBeLessThanOrEqual(refsCount + commitCount);
  });

  it('loads an inline patch for one file from root and ordinary commits', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'git-log-workbench-file-patch-'));
    temporaryDirectories.push(repository);
    await git(repository, 'init', '-b', 'main');
    await writeFile(join(repository, 'app.txt'), 'old line\n');
    await writeFile(join(repository, 'other.txt'), 'unrelated\n');
    await git(repository, 'add', '.');
    await git(repository, 'commit', '-m', 'root files');
    const rootHash = await git(repository, 'rev-parse', 'HEAD');
    await writeFile(join(repository, 'app.txt'), 'new line\n');
    await git(repository, 'add', 'app.txt');
    await git(repository, 'commit', '-m', 'update app');
    const updateHash = await git(repository, 'rev-parse', 'HEAD');
    const service = new GitService(new GitRunner());

    const rootPatch = await service.getFilePatch(repository, rootHash, undefined, 'app.txt');
    const updatePatch = await service.getFilePatch(repository, updateHash, rootHash, 'app.txt');

    expect(rootPatch).toContain('+++ b/app.txt');
    expect(rootPatch).toContain('+old line');
    expect(rootPatch).not.toContain('other.txt');
    expect(updatePatch).toContain('-old line');
    expect(updatePatch).toContain('+new line');
    expect(updatePatch).not.toContain('other.txt');
  });

  it('keeps the entire file context in a commit file patch', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'git-log-workbench-full-file-patch-'));
    temporaryDirectories.push(repository);
    await git(repository, 'init', '-b', 'main');
    const original = Array.from({ length: 14 }, (_, index) => `line ${String(index + 1)}`);
    await writeFile(join(repository, 'app.txt'), `${original.join('\n')}\n`);
    await git(repository, 'add', 'app.txt');
    await git(repository, 'commit', '-m', 'add app');
    const parent = await git(repository, 'rev-parse', 'HEAD');
    original[7] = 'changed line 8';
    await writeFile(join(repository, 'app.txt'), `${original.join('\n')}\n`);
    await git(repository, 'add', 'app.txt');
    await git(repository, 'commit', '-m', 'change middle line');
    const revision = await git(repository, 'rev-parse', 'HEAD');

    const patch = await new GitService(new GitRunner()).getFilePatch(
      repository,
      revision,
      parent,
      'app.txt',
    );

    expect(patch).toContain(' line 1');
    expect(patch).toContain(' line 14');
    expect(patch).toContain('+changed line 8');
  });

  it('loads and extracts real Git context around a tracked line', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'git-log-workbench-line-context-'));
    temporaryDirectories.push(repository);
    await git(repository, 'init', '-b', 'main');
    const lines = Array.from({ length: 14 }, (_, index) => `line ${String(index + 1)}`);
    await writeFile(join(repository, 'app.txt'), `${lines.join('\n')}\n`);
    await git(repository, 'add', 'app.txt');
    await git(repository, 'commit', '-m', 'add app');
    const parent = await git(repository, 'rev-parse', 'HEAD');
    lines[7] = 'changed line 8';
    await writeFile(join(repository, 'app.txt'), `${lines.join('\n')}\n`);
    await git(repository, 'add', 'app.txt');
    await git(repository, 'commit', '-m', 'change line 8');
    const revision = await git(repository, 'rev-parse', 'HEAD');

    const patch = await new GitService(new GitRunner()).getFilePatch(
      repository,
      revision,
      parent,
      'app.txt',
      undefined,
      undefined,
      3,
    );
    const extracted = extractLineHistoryContextPatch(patch, {
      oldStartLine: 8,
      oldLineCount: 1,
      newStartLine: 8,
      newLineCount: 1,
    }, 3);

    expect(extracted).toContain(' line 5');
    expect(extracted).toContain('-line 8');
    expect(extracted).toContain('+changed line 8');
    expect(extracted).toContain(' line 11');
    expect(extracted).not.toContain('\n line 4\n');
    expect(extracted).not.toContain('\n line 12\n');
  });

  it('loads an inline patch between a revision and the working file', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'git-log-workbench-working-patch-'));
    temporaryDirectories.push(repository);
    await git(repository, 'init', '-b', 'main');
    await writeFile(join(repository, 'app.txt'), 'old line\n');
    await git(repository, 'add', 'app.txt');
    await git(repository, 'commit', '-m', 'add app');
    const revision = await git(repository, 'rev-parse', 'HEAD');
    await writeFile(join(repository, 'app.txt'), 'working line\n');

    const patch = await new GitService(new GitRunner()).getWorkingFilePatch(
      repository,
      revision,
      'app.txt',
    );

    expect(patch).toContain('-old line');
    expect(patch).toContain('+working line');
  });

  it('keeps the entire file context in a branch or tag working-file patch', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'git-log-workbench-full-working-patch-'));
    temporaryDirectories.push(repository);
    await git(repository, 'init', '-b', 'main');
    const lines = Array.from({ length: 14 }, (_, index) => `line ${String(index + 1)}`);
    await writeFile(join(repository, 'app.txt'), `${lines.join('\n')}\n`);
    await git(repository, 'add', 'app.txt');
    await git(repository, 'commit', '-m', 'add app');
    const revision = await git(repository, 'rev-parse', 'HEAD');
    lines[7] = 'changed line 8';
    await writeFile(join(repository, 'app.txt'), `${lines.join('\n')}\n`);

    const patch = await new GitService(new GitRunner()).getWorkingFilePatch(
      repository,
      revision,
      'app.txt',
    );

    expect(patch).toContain(' line 1');
    expect(patch).toContain(' line 14');
    expect(patch).toContain('+changed line 8');
  });

  it('uses unsaved editor content when loading a working-file patch', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'git-log-workbench-editor-patch-'));
    temporaryDirectories.push(repository);
    await git(repository, 'init', '-b', 'main');
    await writeFile(join(repository, 'app.txt'), 'old line\n');
    await git(repository, 'add', 'app.txt');
    await git(repository, 'commit', '-m', 'add app');
    const revision = await git(repository, 'rev-parse', 'HEAD');
    await writeFile(join(repository, 'app.txt'), 'saved working line\n');

    const patch = await new GitService(new GitRunner()).getWorkingFilePatch(
      repository,
      revision,
      'app.txt',
      'unsaved editor line\n',
    );

    expect(patch).toContain('-old line');
    expect(patch).toContain('+unsaved editor line');
    expect(patch).not.toContain('saved working line');
  });

  it('compares a saved untracked file against an empty ref side', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'git-log-workbench-untracked-patch-'));
    temporaryDirectories.push(repository);
    await git(repository, 'init', '-b', 'main');
    await writeFile(join(repository, 'tracked.txt'), 'tracked\n');
    await git(repository, 'add', 'tracked.txt');
    await git(repository, 'commit', '-m', 'base');
    const revision = await git(repository, 'rev-parse', 'HEAD');
    await writeFile(join(repository, 'new.txt'), 'saved untracked line\n');

    const patch = await new GitService(new GitRunner()).getWorkingFilePatch(
      repository,
      revision,
      'new.txt',
    );

    expect(patch).toContain('+saved untracked line');
  });

  it('does not report a clean CRLF working file as an entire-file change', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'git-log-workbench-crlf-patch-'));
    temporaryDirectories.push(repository);
    await git(repository, 'init', '-b', 'main');
    await writeFile(join(repository, '.gitattributes'), 'app.txt text eol=crlf\n');
    await writeFile(join(repository, 'app.txt'), 'first line\nsecond line\n');
    await git(repository, 'add', '.gitattributes', 'app.txt');
    await git(repository, 'commit', '-m', 'add CRLF app');
    const revision = await git(repository, 'rev-parse', 'HEAD');
    await unlink(join(repository, 'app.txt'));
    await git(repository, 'checkout', '--', 'app.txt');

    const patch = await new GitService(new GitRunner()).getWorkingFilePatch(
      repository,
      revision,
      'app.txt',
    );

    expect(patch).toBe('');
  });

  it('surfaces a required working-tree filter failure instead of treating the ref side as empty', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'git-log-workbench-filter-patch-'));
    temporaryDirectories.push(repository);
    await git(repository, 'init', '-b', 'main');
    await writeFile(join(repository, '.gitattributes'), 'app.txt filter=broken\n');
    await writeFile(join(repository, 'app.txt'), 'tracked content\n');
    await git(repository, 'add', '.gitattributes', 'app.txt');
    await git(repository, 'commit', '-m', 'add filtered app');
    const revision = await git(repository, 'rev-parse', 'HEAD');
    await git(repository, 'config', 'filter.broken.smudge', 'false');
    await git(repository, 'config', 'filter.broken.required', 'true');

    await expect(
      new GitService(new GitRunner()).getWorkingFilePatch(repository, revision, 'app.txt'),
    ).rejects.toThrow('Git command exited with code');
  });

  it('treats a directory at the ref path as an empty file side', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'git-log-workbench-tree-patch-'));
    temporaryDirectories.push(repository);
    await git(repository, 'init', '-b', 'main');
    await writeFile(join(repository, 'target.txt'), 'base\n');
    await git(repository, 'add', 'target.txt');
    await git(repository, 'commit', '-m', 'base');
    await unlink(join(repository, 'target.txt'));
    await mkdir(join(repository, 'target.txt'));
    await writeFile(join(repository, 'target.txt', 'child.txt'), 'child\n');
    await git(repository, 'add', '-A');
    await git(repository, 'commit', '-m', 'replace file with directory');
    const revision = await git(repository, 'rev-parse', 'HEAD');
    await rm(join(repository, 'target.txt'), { recursive: true });
    await writeFile(join(repository, 'target.txt'), 'working file\n');

    const patch = await new GitService(new GitRunner()).getWorkingFilePatch(
      repository,
      revision,
      'target.txt',
    );

    expect(patch).toContain('+working file');
    expect(patch).not.toContain('Binary files');
  });

  it('honors a binary Git attribute for text-looking file content', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'git-log-workbench-binary-attr-patch-'));
    temporaryDirectories.push(repository);
    await git(repository, 'init', '-b', 'main');
    await writeFile(join(repository, '.gitattributes'), '*.dat binary\n');
    await writeFile(join(repository, 'data.dat'), 'old ASCII content\n');
    await git(repository, 'add', '.gitattributes', 'data.dat');
    await git(repository, 'commit', '-m', 'add binary-attributed data');
    const revision = await git(repository, 'rev-parse', 'HEAD');
    await writeFile(join(repository, 'data.dat'), 'new ASCII content\n');

    const patch = await new GitService(new GitRunner()).getWorkingFilePatch(
      repository,
      revision,
      'data.dat',
    );

    expect(patch).toBe('Binary files data.dat differ\n');
  });

  it('treats a file patch path as a literal Git pathspec', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'git-log-workbench-literal-patch-'));
    temporaryDirectories.push(repository);
    const path = ':(exclude)other.txt';
    await git(repository, 'init', '-b', 'main');
    await writeFile(join(repository, path), 'old target\n');
    await writeFile(join(repository, 'secret.txt'), 'old secret\n');
    await git(repository, 'add', '.');
    await git(repository, 'commit', '-m', 'root files');
    const parent = await git(repository, 'rev-parse', 'HEAD');
    await writeFile(join(repository, path), 'new target\n');
    await writeFile(join(repository, 'secret.txt'), 'new secret\n');
    await git(repository, 'add', '.');
    await git(repository, 'commit', '-m', 'update files');
    const hash = await git(repository, 'rev-parse', 'HEAD');

    const patch = await new GitService(new GitRunner()).getFilePatch(
      repository,
      hash,
      parent,
      path,
    );

    expect(patch).toContain(`+++ b/${path}`);
    expect(patch).toContain('+new target');
    expect(patch).not.toContain('secret.txt');
    expect(patch).not.toContain('new secret');
  });

  it('combines branch, author, date, and path filters against a real repository', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'git-log-workbench-filters-'));
    temporaryDirectories.push(repository);
    await git(repository, 'init', '-b', 'main');

    const commit = async (
      path: string,
      subject: string,
      authorName: string,
      isoDate: string,
    ): Promise<void> => {
      await writeFile(join(repository, path), `${subject}\n`, { flag: 'a' });
      await git(repository, 'add', path);
      await execFileAsync('git', ['commit', '-m', subject], {
        cwd: repository,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: authorName,
          GIT_AUTHOR_EMAIL: `${authorName.toLowerCase()}@example.com`,
          GIT_COMMITTER_NAME: authorName,
          GIT_COMMITTER_EMAIL: `${authorName.toLowerCase()}@example.com`,
          GIT_AUTHOR_DATE: isoDate,
          GIT_COMMITTER_DATE: isoDate,
        },
      });
    };

    await commit('shared.txt', 'base by Alice', 'Alice', '2024-01-01T12:00:00Z');
    await git(repository, 'checkout', '-b', 'feature');
    await commit('feature.txt', 'feature by Bob', 'Bob', '2024-02-01T12:00:00Z');
    await git(repository, 'checkout', 'main');
    await commit('main.txt', 'main by Carol', 'Carol', '2024-03-01T12:00:00Z');

    const service = new GitService(new GitRunner());
    const refs = await service.getRefs(repository, 'main');
    const commits = await service.getLog(repository, {
      limit: 20,
      skip: 0,
      refs,
      filters: {
        text: '',
        branches: ['refs/heads/feature'],
        authors: ['Bob'],
        dateFrom: Math.floor(Date.parse('2024-01-15T00:00:00Z') / 1000),
        dateTo: Math.floor(Date.parse('2024-02-15T00:00:00Z') / 1000),
        paths: ['feature.txt'],
      },
    });

    expect(commits.map((entry) => entry.subject)).toEqual(['feature by Bob']);
    expect(commits[0]).toMatchObject({ graphParents: [] });

    const mainHash = await git(repository, 'rev-parse', 'main');
    const hashOutsideBranch = await service.getLog(repository, {
      limit: 20,
      skip: 0,
      refs,
      filters: {
        ...EMPTY_LOG_FILTERS,
        text: mainHash.slice(0, 10),
        branches: ['refs/heads/feature'],
      },
    });
    expect(hashOutsideBranch).toEqual([]);
  });
});
