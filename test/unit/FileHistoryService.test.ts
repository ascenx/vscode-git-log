import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitRunner } from '../../src/git/GitRunner';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const environment = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Alice',
  GIT_AUTHOR_EMAIL: 'alice@example.com',
  GIT_COMMITTER_NAME: 'Alice',
  GIT_COMMITTER_EMAIL: 'alice@example.com',
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe('FileHistoryService', () => {
  it('scans past filtered metadata records without truncating ordinary commit pagination', async () => {
    const head = 'f'.repeat(40);
    const metadata = (hash: string, parents: string, subject: string) =>
      [hash, parents, 'Alice', 'alice@example.com', '1', '2', subject, ''].join('\0');
    const mergeOnly = `\x1e${metadata('c'.repeat(40), `${'a'.repeat(40)} ${'b'.repeat(40)}`, 'merge')}\0`;
    const latest = `\x1e${metadata('b'.repeat(40), 'a'.repeat(40), 'latest')}\0\n1\t0\tapp.txt\0`;
    const older = `\x1e${metadata('a'.repeat(40), '', 'older')}\0\n1\t0\tapp.txt\0`;
    const run = vi.fn(async (args: readonly string[]) => {
      if (args.includes('rev-parse')) {
        return { stdout: Buffer.from(`${head}\n`), stderr: Buffer.alloc(0) };
      }
      const maxCount = args.find((argument) => argument.startsWith('--max-count='));
      return {
        stdout: Buffer.from(maxCount === '--max-count=2' ? mergeOnly + latest : mergeOnly + latest + older),
        stderr: Buffer.alloc(0),
      };
    });
    const { FileHistoryService } = await import('../../src/git/FileHistoryService');

    const entries = await new FileHistoryService({ run } as unknown as GitRunner).getFileHistory(
      '/repo',
      'app.txt',
      [],
      { limit: 2, skip: 0 },
    );

    expect(entries.map((entry) => entry.subject)).toEqual(['latest', 'older']);
    const logCalls = run.mock.calls.filter(([args]) => args.includes('log'));
    expect(logCalls).toHaveLength(2);
    expect(logCalls.every(([args]) => args.includes('--no-merges'))).toBe(true);
  });

  it('scans past metadata-only line-history records before applying the 500-entry limit', async () => {
    const metadataRecord = (hash: string) =>
      `\x1e${hash}\x00\x00Alice\x00alice@example.com\x001\x002\x00metadata only\x00\n`;
    const changedRecord = (index: number) => {
      const hash = index.toString(16).padStart(40, '0');
      return (
        `\x1e${hash}\x00\x00Alice\x00alice@example.com\x001\x002\x00change ${String(index)}\x00\n\n` +
        'diff --git a/app.txt b/app.txt\n' +
        '--- a/app.txt\n' +
        '+++ b/app.txt\n' +
        '@@ -1 +1 @@\n' +
        '-old\n' +
        '+new\n'
      );
    };
    const metadata = metadataRecord('a'.repeat(40)) + metadataRecord('b'.repeat(40));
    const changed = Array.from({ length: 501 }, (_, index) => changedRecord(index + 1));
    const run = vi.fn(async (args: readonly string[]) => ({
      stdout: Buffer.from(
        args.includes('--max-count=501')
          ? metadata + changed.slice(0, 499).join('')
          : metadata + changed.join(''),
      ),
      stderr: Buffer.alloc(0),
    }));
    const { FileHistoryService } = await import('../../src/git/FileHistoryService');

    const result = await new FileHistoryService({ run } as unknown as GitRunner).getLineHistory(
      '/repo',
      'app.txt',
      1,
      1,
      [],
    );

    expect(result.entries).toHaveLength(500);
    expect(result.truncated).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toContain('--max-count=1002');
  });

  it('requests enough unified context to keep a selected line range visible', async () => {
    const run = vi.fn().mockResolvedValue({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
    const { FileHistoryService } = await import('../../src/git/FileHistoryService');

    await new FileHistoryService({ run } as unknown as GitRunner).getLineHistory(
      '/repo',
      'app.txt',
      37,
      55,
      [],
    );

    expect(run.mock.calls[0]?.[0]).toContain('--unified=18');
  });

  it('lets Git track a selected range to its older line coordinates', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'git-log-shifted-selection-history-'));
    temporaryDirectories.push(repository);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repository });
    const baseLines = Array.from({ length: 70 }, (_, index) => `line ${String(index + 1)}`);
    await writeFile(join(repository, 'app.txt'), `${baseLines.join('\n')}\n`);
    await execFileAsync('git', ['add', 'app.txt'], { cwd: repository });
    await execFileAsync('git', ['commit', '-m', 'base'], { cwd: repository, env: environment });
    baseLines[24] = 'line 25 modified';
    await writeFile(join(repository, 'app.txt'), `${baseLines.join('\n')}\n`);
    await execFileAsync('git', ['add', 'app.txt'], { cwd: repository });
    await execFileAsync('git', ['commit', '-m', 'modify 25'], { cwd: repository, env: environment });
    const inserted = Array.from({ length: 20 }, (_, index) => `inserted ${String(index + 1)}`);
    await writeFile(join(repository, 'app.txt'), `${[...inserted, ...baseLines].join('\n')}\n`);
    await execFileAsync('git', ['add', 'app.txt'], { cwd: repository });
    await execFileAsync('git', ['commit', '-m', 'insert before range'], {
      cwd: repository,
      env: environment,
    });
    const { FileHistoryService } = await import('../../src/git/FileHistoryService');

    const result = await new FileHistoryService(new GitRunner()).getLineHistory(
      repository,
      'app.txt',
      37,
      55,
      [],
    );

    expect(result.entries.map((entry) => entry.subject)).toEqual(['modify 25', 'base']);
    expect(result.entries[0]?.linePatch).toContain('@@ -17,19 +17,19 @@');
    expect(result.entries[0]?.linePatch).toContain(' line 17');
    expect(result.entries[0]?.linePatch).toContain(' line 35');
  });

  it('keeps lines restored by reversing a deletion inside the selected range', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'git-log-deleted-selection-history-'));
    temporaryDirectories.push(repository);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repository });
    const baseLines = Array.from({ length: 70 }, (_, index) => `line ${String(index + 1)}`);
    await writeFile(join(repository, 'app.txt'), `${baseLines.join('\n')}\n`);
    await execFileAsync('git', ['add', 'app.txt'], { cwd: repository });
    await execFileAsync('git', ['commit', '-m', 'base'], { cwd: repository, env: environment });
    baseLines.splice(44, 5);
    await writeFile(join(repository, 'app.txt'), `${baseLines.join('\n')}\n`);
    await execFileAsync('git', ['add', 'app.txt'], { cwd: repository });
    await execFileAsync('git', ['commit', '-m', 'delete inside range'], {
      cwd: repository,
      env: environment,
    });
    const { FileHistoryService } = await import('../../src/git/FileHistoryService');

    const result = await new FileHistoryService(new GitRunner()).getLineHistory(
      repository,
      'app.txt',
      37,
      55,
      [],
    );

    expect(result.entries[0]?.linePatch).toContain('@@ -37,24 +37,19 @@');
    expect(result.entries[0]?.linePatch).toContain(' line 60');
    expect(result.entries[1]?.linePatch).toContain('+line 60');
  });

  it('loads file-level statistics across a rename from a real repository', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'git-log-file-history-'));
    temporaryDirectories.push(repository);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repository });
    await writeFile(join(repository, 'old.txt'), 'one\ntwo\n');
    await execFileAsync('git', ['add', '.'], { cwd: repository });
    await execFileAsync('git', ['commit', '-m', 'add old'], { cwd: repository, env: environment });
    await rename(join(repository, 'old.txt'), join(repository, 'new.txt'));
    await writeFile(join(repository, 'new.txt'), 'one\ntwo\nthree\n');
    await execFileAsync('git', ['add', '-A'], { cwd: repository });
    await execFileAsync('git', ['commit', '-m', 'rename new'], { cwd: repository, env: environment });

    const modulePath = '../../src/git/FileHistoryService';
    const serviceModule = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(serviceModule, 'FileHistoryService must exist').toBeDefined();
    if (!serviceModule) return;

    const entries = await new serviceModule.FileHistoryService(new GitRunner()).getFileHistory(
      repository,
      'new.txt',
      [],
      { limit: 20, skip: 0 },
    );

    expect(entries.map((entry: { subject: string }) => entry.subject)).toEqual([
      'rename new',
      'add old',
    ]);
    expect(entries[0]).toMatchObject({ path: 'new.txt', additions: 1, deletions: 0 });
    expect(entries[1]).toMatchObject({ path: 'old.txt', additions: 2, deletions: 0 });

    const firstPage = await new serviceModule.FileHistoryService(new GitRunner()).getFileHistory(
      repository,
      'new.txt',
      [],
      { limit: 1, skip: 0 },
    );
    const secondPage = await new serviceModule.FileHistoryService(new GitRunner()).getFileHistory(
      repository,
      'new.txt',
      [],
      { limit: 1, skip: 1 },
    );
    expect(firstPage[0]).toMatchObject({ subject: 'rename new', path: 'new.txt' });
    expect(secondPage[0]).toMatchObject({ subject: 'add old', path: 'old.txt' });

    const lineHistory = await new serviceModule.FileHistoryService(new GitRunner()).getLineHistory(
      repository,
      'new.txt',
      1,
      1,
      [],
    );
    expect(lineHistory.entries.map((entry: { subject: string }) => entry.subject)).toEqual(['add old']);
    expect(lineHistory.entries[0]).toMatchObject({ path: 'old.txt', additions: 1 });
  });

  it('follows the commits that changed the file without synthesizing a merge entry', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'git-log-file-history-merge-'));
    temporaryDirectories.push(repository);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repository });
    await writeFile(join(repository, 'app.txt'), 'base\n');
    await execFileAsync('git', ['add', 'app.txt'], { cwd: repository });
    await execFileAsync('git', ['commit', '-m', 'base'], { cwd: repository, env: environment });
    await execFileAsync('git', ['switch', '-c', 'feature'], { cwd: repository });
    await writeFile(join(repository, 'app.txt'), 'feature\n');
    await execFileAsync('git', ['add', 'app.txt'], { cwd: repository });
    await execFileAsync('git', ['commit', '-m', 'feature app'], {
      cwd: repository,
      env: environment,
    });
    await execFileAsync('git', ['switch', 'main'], { cwd: repository });
    await writeFile(join(repository, 'main.txt'), 'main\n');
    await execFileAsync('git', ['add', 'main.txt'], { cwd: repository });
    await execFileAsync('git', ['commit', '-m', 'main work'], { cwd: repository, env: environment });
    await execFileAsync('git', ['merge', '--no-ff', 'feature', '-m', 'merge feature'], {
      cwd: repository,
      env: environment,
    });
    const { FileHistoryService } = await import('../../src/git/FileHistoryService');

    const entries = await new FileHistoryService(new GitRunner()).getFileHistory(
      repository,
      'app.txt',
      [],
      { limit: 20, skip: 0 },
    );

    expect(entries.map((entry) => entry.subject)).toEqual(['feature app', 'base']);
    expect(entries.every((entry) => entry.parents.length < 2)).toBe(true);
  });

  it('does not replace conflicting branch commits with the conflict-resolution merge', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'git-log-file-history-merge-parents-'));
    temporaryDirectories.push(repository);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repository });
    await writeFile(join(repository, 'app.txt'), 'base\n');
    await execFileAsync('git', ['add', 'app.txt'], { cwd: repository });
    await execFileAsync('git', ['commit', '-m', 'base'], { cwd: repository, env: environment });
    await execFileAsync('git', ['switch', '-c', 'feature'], { cwd: repository });
    await writeFile(join(repository, 'app.txt'), 'feature one\nfeature two\nfeature three\n');
    await execFileAsync('git', ['add', 'app.txt'], { cwd: repository });
    await execFileAsync('git', ['commit', '-m', 'feature app'], {
      cwd: repository,
      env: environment,
    });
    await execFileAsync('git', ['switch', 'main'], { cwd: repository });
    await writeFile(join(repository, 'app.txt'), 'main\n');
    await execFileAsync('git', ['add', 'app.txt'], { cwd: repository });
    await execFileAsync('git', ['commit', '-m', 'main app'], { cwd: repository, env: environment });
    await expect(
      execFileAsync('git', ['merge', '--no-ff', 'feature', '-m', 'merge conflict'], {
        cwd: repository,
        env: environment,
      }),
    ).rejects.toBeDefined();
    await writeFile(join(repository, 'app.txt'), 'resolved one\nresolved two\n');
    await execFileAsync('git', ['add', 'app.txt'], { cwd: repository });
    await execFileAsync('git', ['commit', '--no-edit'], { cwd: repository, env: environment });
    const { FileHistoryService } = await import('../../src/git/FileHistoryService');

    const entries = await new FileHistoryService(new GitRunner()).getFileHistory(
      repository,
      'app.txt',
      [],
      { limit: 20, skip: 0 },
    );
    expect(entries.some((entry) => entry.subject === 'merge conflict')).toBe(false);
    expect(entries.map((entry) => entry.subject)).toEqual(
      expect.arrayContaining(['main app', 'feature app', 'base']),
    );
  });

  it('maps a worktree line to HEAD and loads its line history from a real repository', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'git-log-line-history-'));
    temporaryDirectories.push(repository);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repository });
    await writeFile(join(repository, 'app.txt'), 'first\nold target\nlast\n');
    await execFileAsync('git', ['add', 'app.txt'], { cwd: repository });
    await execFileAsync('git', ['commit', '-m', 'add target'], { cwd: repository, env: environment });
    await writeFile(join(repository, 'app.txt'), 'first\nnew target\nlast\n');
    await execFileAsync('git', ['add', 'app.txt'], { cwd: repository });
    await execFileAsync('git', ['commit', '-m', 'update target'], { cwd: repository, env: environment });
    await writeFile(
      join(repository, 'app.txt'),
      'inserted one\ninserted two\nfirst\nnew target\nlast\n',
    );
    const { FileHistoryService } = await import('../../src/git/FileHistoryService');
    const service = new FileHistoryService(new GitRunner());

    const mapping = await service.resolveHeadLineRange(repository, 'app.txt', 4, 4);

    expect(mapping).toEqual({
      status: 'mapped',
      startLine: 2,
      endLine: 2,
      partiallyUncommitted: false,
    });
    if (mapping.status !== 'mapped') return;
    const result = await service.getLineHistory(
      repository,
      'app.txt',
      mapping.startLine,
      mapping.endLine,
      [],
    );
    expect(result.truncated).toBe(false);
    expect(result.entries.map((entry) => entry.subject)).toEqual(['update target', 'add target']);
    expect(result.entries[0]).toMatchObject({ additions: 1, deletions: 1, path: 'app.txt' });
    expect(result.entries[1]).toMatchObject({ additions: 1, deletions: 0, path: 'app.txt' });
  });

  it('maps an unsaved editor line snapshot to HEAD without changing the working file', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'git-log-unsaved-line-history-'));
    temporaryDirectories.push(repository);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repository });
    await writeFile(join(repository, 'app.txt'), 'first\ntarget\nlast\n');
    await execFileAsync('git', ['add', 'app.txt'], { cwd: repository });
    await execFileAsync('git', ['commit', '-m', 'add target'], {
      cwd: repository,
      env: environment,
    });
    const { FileHistoryService } = await import('../../src/git/FileHistoryService');
    const service = new FileHistoryService(new GitRunner());

    const mapping = await service.resolveHeadLineRange(
      repository,
      'app.txt',
      3,
      3,
      undefined,
      'inserted\nfirst\ntarget\nlast\n',
    );

    expect(mapping).toEqual({
      status: 'mapped',
      startLine: 2,
      endLine: 2,
      partiallyUncommitted: false,
    });
    await expect(readFile(join(repository, 'app.txt'), 'utf8')).resolves.toBe(
      'first\ntarget\nlast\n',
    );
  });

  it('maps a dirty CRLF editor snapshot using working-tree filters', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'git-log-crlf-line-history-'));
    temporaryDirectories.push(repository);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repository });
    await writeFile(join(repository, '.gitattributes'), '*.txt text eol=crlf\n');
    await writeFile(join(repository, 'app.txt'), 'first\nold target\nlast\n');
    await execFileAsync('git', ['add', '.gitattributes', 'app.txt'], { cwd: repository });
    await execFileAsync('git', ['commit', '-m', 'add crlf file'], { cwd: repository, env: environment });
    const { FileHistoryService } = await import('../../src/git/FileHistoryService');

    const mapping = await new FileHistoryService(new GitRunner()).resolveHeadLineRange(
      repository,
      'app.txt',
      3,
      3,
      undefined,
      'inserted\r\nfirst\r\nold target\r\nlast\r\n',
    );

    expect(mapping).toEqual({
      status: 'mapped',
      startLine: 2,
      endLine: 2,
      partiallyUncommitted: false,
    });
  });

  it('maps a dirty working-tree-encoded editor snapshot as logical text', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'git-log-encoded-line-history-'));
    temporaryDirectories.push(repository);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repository });
    await writeFile(
      join(repository, '.gitattributes'),
      '*.txt text working-tree-encoding=UTF-16LE-BOM eol=crlf\n',
    );
    await writeFile(
      join(repository, 'app.txt'),
      Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from('first\r\nold target\r\nlast\r\n', 'utf16le'),
      ]),
    );
    await execFileAsync('git', ['add', '.gitattributes', 'app.txt'], { cwd: repository });
    await execFileAsync('git', ['commit', '-m', 'add encoded file'], {
      cwd: repository,
      env: environment,
    });
    const { FileHistoryService } = await import('../../src/git/FileHistoryService');

    const mapping = await new FileHistoryService(new GitRunner()).resolveHeadLineRange(
      repository,
      'app.txt',
      3,
      3,
      undefined,
      'inserted\r\nfirst\r\nold target\r\nlast\r\n',
    );

    expect(mapping).toEqual({
      status: 'mapped',
      startLine: 2,
      endLine: 2,
      partiallyUncommitted: false,
    });
  });

  it('reports a purely uncommitted line and a file absent from HEAD', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'git-log-uncommitted-line-'));
    temporaryDirectories.push(repository);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repository });
    await writeFile(join(repository, 'tracked.txt'), 'first\nsecond\n');
    await execFileAsync('git', ['add', 'tracked.txt'], { cwd: repository });
    await execFileAsync('git', ['commit', '-m', 'add tracked'], { cwd: repository, env: environment });
    await writeFile(join(repository, 'tracked.txt'), 'first\ninserted\nsecond\n');
    await writeFile(join(repository, 'untracked.txt'), 'only new\n');
    const { FileHistoryService } = await import('../../src/git/FileHistoryService');
    const service = new FileHistoryService(new GitRunner());

    await expect(service.resolveHeadLineRange(repository, 'tracked.txt', 2, 2)).resolves.toEqual({
      status: 'uncommitted-only',
    });
    await expect(service.resolveHeadLineRange(repository, 'untracked.txt', 1, 1)).resolves.toEqual({
      status: 'file-not-in-head',
      hasHistory: false,
    });
  });

  it('distinguishes a deleted historical file from an untracked file absent from HEAD', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'git-log-deleted-line-history-'));
    temporaryDirectories.push(repository);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repository });
    await writeFile(join(repository, 'deleted.txt'), 'historical line\n');
    await execFileAsync('git', ['add', 'deleted.txt'], { cwd: repository });
    await execFileAsync('git', ['commit', '-m', 'add deleted file'], {
      cwd: repository,
      env: environment,
    });
    await rm(join(repository, 'deleted.txt'));
    await execFileAsync('git', ['add', '-A'], { cwd: repository });
    await execFileAsync('git', ['commit', '-m', 'delete file'], {
      cwd: repository,
      env: environment,
    });
    const { FileHistoryService } = await import('../../src/git/FileHistoryService');

    await expect(
      new FileHistoryService(new GitRunner()).resolveHeadLineRange(
        repository,
        'deleted.txt',
        1,
        1,
      ),
    ).resolves.toEqual({ status: 'file-not-in-head', hasHistory: true });
  });

  it('supports option-like Unicode and emoji paths in line history', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'git-log-special-line-path-'));
    temporaryDirectories.push(repository);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repository });
    const path = '-中文 😀.txt';
    await writeFile(join(repository, path), 'old\n');
    await execFileAsync('git', ['add', '--', path], { cwd: repository });
    await execFileAsync('git', ['commit', '-m', 'add special path'], { cwd: repository, env: environment });
    await writeFile(join(repository, path), 'new\n');
    await execFileAsync('git', ['add', '--', path], { cwd: repository });
    await execFileAsync('git', ['commit', '-m', 'update special path'], { cwd: repository, env: environment });
    const { FileHistoryService } = await import('../../src/git/FileHistoryService');

    const result = await new FileHistoryService(new GitRunner()).getLineHistory(
      repository,
      path,
      1,
      1,
      [],
    );

    expect(result.entries.map((entry) => entry.subject)).toEqual([
      'update special path',
      'add special path',
    ]);
    expect(result.entries.every((entry) => entry.path === path)).toBe(true);
  });

  it('supports newline paths in file history while keeping shell execution disabled', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'git-log-newline-file-path-'));
    temporaryDirectories.push(repository);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repository });
    const path = 'line\nbreak.txt';
    await writeFile(join(repository, path), 'first\n');
    await execFileAsync('git', ['add', '--', path], { cwd: repository });
    await execFileAsync('git', ['commit', '-m', 'add newline path'], {
      cwd: repository,
      env: environment,
    });
    const { FileHistoryService } = await import('../../src/git/FileHistoryService');

    const entries = await new FileHistoryService(new GitRunner()).getFileHistory(
      repository,
      path,
      [],
      { limit: 20, skip: 0 },
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ path, subject: 'add newline path', additions: 1 });
    await expect(
      new FileHistoryService(new GitRunner()).getLineHistory(repository, path, 1, 1, []),
    ).rejects.toThrow('Line history does not support paths containing line breaks.');
  });

  it('treats a file history path as a literal Git pathspec', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'git-log-literal-file-history-'));
    temporaryDirectories.push(repository);
    const path = ':(exclude)other.txt';
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repository });
    await writeFile(join(repository, path), 'target\n');
    await writeFile(join(repository, 'secret.txt'), 'old secret\n');
    await execFileAsync('git', ['add', '.'], { cwd: repository });
    await execFileAsync('git', ['commit', '-m', 'add target'], {
      cwd: repository,
      env: environment,
    });
    await writeFile(join(repository, 'secret.txt'), 'new secret\n');
    await execFileAsync('git', ['add', 'secret.txt'], { cwd: repository });
    await execFileAsync('git', ['commit', '-m', 'update secret'], {
      cwd: repository,
      env: environment,
    });
    const { FileHistoryService } = await import('../../src/git/FileHistoryService');

    const entries = await new FileHistoryService(new GitRunner()).getFileHistory(
      repository,
      path,
      [],
      { limit: 20, skip: 0 },
    );

    expect(entries.map((entry) => entry.subject)).toEqual(['add target']);
    expect(entries[0]).toMatchObject({ path, additions: 1 });
  });

  it('loads file history while HEAD is detached', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'git-log-detached-file-history-'));
    temporaryDirectories.push(repository);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repository });
    await writeFile(join(repository, 'app.txt'), 'first\n');
    await execFileAsync('git', ['add', 'app.txt'], { cwd: repository });
    await execFileAsync('git', ['commit', '-m', 'detached base'], {
      cwd: repository,
      env: environment,
    });
    await execFileAsync('git', ['switch', '--detach', 'HEAD'], { cwd: repository });
    const { FileHistoryService } = await import('../../src/git/FileHistoryService');

    const entries = await new FileHistoryService(new GitRunner()).getFileHistory(
      repository,
      'app.txt',
      [],
      { limit: 20, skip: 0 },
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ subject: 'detached base', path: 'app.txt' });
  });

  it('reuses a bounded file-history scan for the same HEAD and invalidates it when HEAD changes', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'git-log-file-history-cache-'));
    temporaryDirectories.push(repository);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repository });
    await writeFile(join(repository, 'app.txt'), 'one\n');
    await execFileAsync('git', ['add', 'app.txt'], { cwd: repository });
    await execFileAsync('git', ['commit', '-m', 'first'], { cwd: repository, env: environment });
    await writeFile(join(repository, 'app.txt'), 'one\ntwo\n');
    await execFileAsync('git', ['add', 'app.txt'], { cwd: repository });
    await execFileAsync('git', ['commit', '-m', 'second'], { cwd: repository, env: environment });
    const runner = new GitRunner();
    const run = vi.spyOn(runner, 'run');
    const { FileHistoryService } = await import('../../src/git/FileHistoryService');
    const service = new FileHistoryService(runner);

    await service.getFileHistory(repository, 'app.txt', [], { limit: 2, skip: 0 });
    await service.getFileHistory(repository, 'app.txt', [], { limit: 1, skip: 1 });
    expect(run.mock.calls.filter(([args]) => args.includes('log'))).toHaveLength(1);

    await writeFile(join(repository, 'app.txt'), 'one\ntwo\nthree\n');
    await execFileAsync('git', ['add', 'app.txt'], { cwd: repository });
    await execFileAsync('git', ['commit', '-m', 'third'], { cwd: repository, env: environment });
    await service.getFileHistory(repository, 'app.txt', [], { limit: 2, skip: 0 });

    expect(run.mock.calls.filter(([args]) => args.includes('log'))).toHaveLength(2);
  });
});
