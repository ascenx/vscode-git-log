import { execFile } from 'node:child_process';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitCommandError, type GitRunner } from '../../src/git/GitRunner';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const gitEnvironment = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test User',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test User',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

const PORCELAIN = [
  `${'a'.repeat(40)} 8 8 1`,
  'author Ryan Zhang',
  'author-mail <ryan@example.com>',
  'author-time 1777016520',
  'author-tz +0800',
  'committer Ryan Zhang',
  'committer-mail <ryan@example.com>',
  'committer-time 1777016520',
  'committer-tz +0800',
  'summary feat(spot): add activity banner',
  'filename lib/activity.dart',
  '\tfinal double width;',
  '',
].join('\n');

describe('LineBlameService', () => {
  it('loads author, time, commit, and summary for one line', async () => {
    const modulePath = '../../src/git/LineBlameService';
    const serviceModule = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(serviceModule, 'LineBlameService must exist').toBeDefined();
    if (!serviceModule) return;

    const run = vi.fn().mockResolvedValue({
      stdout: Buffer.from(PORCELAIN),
      stderr: Buffer.alloc(0),
      exitCode: 0,
      durationMs: 1,
    });
    const service = new serviceModule.LineBlameService({
      run,
    } as unknown as GitRunner);

    await expect(service.getLineBlame('/repo', 'lib/activity.dart', 8)).resolves.toEqual({
      hash: 'a'.repeat(40),
      authorName: 'Ryan Zhang',
      authorEmail: 'ryan@example.com',
      authorTime: 1777016520,
      subject: 'feat(spot): add activity banner',
      committed: true,
    });
    expect(run).toHaveBeenCalledWith(
      ['blame', '--line-porcelain', '-L', '8,8', '--', 'lib/activity.dart'],
      expect.objectContaining({ cwd: '/repo' }),
    );
  });

  it('blames the unsaved editor contents through stdin', async () => {
    const { LineBlameService } = await import('../../src/git/LineBlameService');
    const run = vi.fn().mockResolvedValue({
      stdout: Buffer.from(PORCELAIN),
      stderr: Buffer.alloc(0),
      exitCode: 0,
      durationMs: 1,
    });
    const service = new LineBlameService({ run } as unknown as GitRunner);

    await service.getLineBlame('/repo', 'lib/activity.dart', 3, {
      content: 'one\ntwo\nthree\n',
    });

    expect(run).toHaveBeenCalledWith(
      ['blame', '--line-porcelain', '--contents', '-', '-L', '3,3', '--', 'lib/activity.dart'],
      expect.objectContaining({ input: 'one\ntwo\nthree\n' }),
    );
  });

  it('marks the all-zero pseudo commit as an uncommitted line', async () => {
    const { LineBlameService } = await import('../../src/git/LineBlameService');
    const run = vi.fn().mockResolvedValue({
      stdout: Buffer.from(
        PORCELAIN.replace('a'.repeat(40), '0'.repeat(40))
          .replace('author-time 1777016520', 'author-time 1777017000')
          .replace('summary feat(spot): add activity banner', 'summary Not Committed Yet'),
      ),
      stderr: Buffer.alloc(0),
      exitCode: 0,
      durationMs: 1,
    });

    const blame = await new LineBlameService({
      run,
    } as unknown as GitRunner).getLineBlame('/repo', 'lib/activity.dart', 8);

    expect(blame).toMatchObject({ committed: false, hash: '0'.repeat(40) });
  });

  it('treats a path missing from HEAD as an uncommitted new file', async () => {
    const { LineBlameService } = await import('../../src/git/LineBlameService');
    const run = vi
      .fn()
      .mockRejectedValueOnce(
        new GitCommandError(
          'Git command exited with code 128.',
          ['blame'],
          '/repo',
          128,
          Buffer.alloc(0),
          Buffer.from("fatal: no such path 'new-file.ts' in HEAD"),
          false,
          false,
        ),
      )
      .mockResolvedValueOnce({
        stdout: Buffer.alloc(0),
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

    await expect(
      new LineBlameService({ run } as unknown as GitRunner).getLineBlame('/repo', 'new-file.ts', 1),
    ).resolves.toMatchObject({ committed: false, hash: '0'.repeat(40) });
  });

  it('treats a file in a repository without HEAD as uncommitted', async () => {
    const { LineBlameService } = await import('../../src/git/LineBlameService');
    const run = vi
      .fn()
      .mockRejectedValue(
        new GitCommandError(
          'Git command exited with code 128.',
          ['blame'],
          '/repo',
          128,
          Buffer.alloc(0),
          Buffer.from('fatal: no such ref: HEAD'),
          false,
          false,
        ),
      );

    await expect(
      new LineBlameService({ run } as unknown as GitRunner).getLineBlame('/repo', 'first.ts', 1),
    ).resolves.toMatchObject({ committed: false, hash: '0'.repeat(40) });
  });

  it('follows a working-tree rename back to the committed path', async () => {
    const { LineBlameService } = await import('../../src/git/LineBlameService');
    const missingPath = new GitCommandError(
      'Git command exited with code 128.',
      ['blame'],
      '/repo',
      128,
      Buffer.alloc(0),
      Buffer.from("fatal: no such path 'new-name.ts' in HEAD"),
      false,
      false,
    );
    const run = vi
      .fn()
      .mockRejectedValueOnce(missingPath)
      .mockResolvedValueOnce({
        stdout: Buffer.from('R100\0old-name.ts\0new-name.ts\0'),
        stderr: Buffer.alloc(0),
        exitCode: 0,
        durationMs: 1,
      })
      .mockResolvedValueOnce({
        stdout: Buffer.from(PORCELAIN.replace('lib/activity.dart', 'old-name.ts')),
        stderr: Buffer.alloc(0),
        exitCode: 0,
        durationMs: 1,
      });
    const service = new LineBlameService({ run } as unknown as GitRunner);

    await expect(service.getLineBlame('/repo', 'new-name.ts', 8)).resolves.toMatchObject({
      committed: true,
      subject: 'feat(spot): add activity banner',
    });
    expect(run).toHaveBeenNthCalledWith(
      2,
      ['diff', '--name-status', '-z', '--find-renames', 'HEAD', '--'],
      expect.objectContaining({ cwd: '/repo' }),
    );
    expect(run).toHaveBeenNthCalledWith(
      3,
      ['blame', '--line-porcelain', '--contents', 'new-name.ts', '-L', '8,8', '--', 'old-name.ts'],
      expect.objectContaining({ cwd: '/repo' }),
    );
  });

  it('follows an unstaged filesystem rename in a real repository', async () => {
    const { GitRunner } = await import('../../src/git/GitRunner');
    const { LineBlameService } = await import('../../src/git/LineBlameService');
    const repository = await mkdtemp(join(tmpdir(), 'git-log-line-blame-rename-'));
    temporaryDirectories.push(repository);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repository });
    await writeFile(join(repository, 'old-name.ts'), 'const answer = 42;\n');
    await execFileAsync('git', ['add', 'old-name.ts'], { cwd: repository });
    await execFileAsync('git', ['commit', '-m', 'add original file'], {
      cwd: repository,
      env: gitEnvironment,
    });
    await rename(join(repository, 'old-name.ts'), join(repository, 'new-name.ts'));

    const blameResult = await new LineBlameService(new GitRunner()).getLineBlame(
      repository,
      'new-name.ts',
      1,
    );

    expect(blameResult).toMatchObject({
      committed: true,
      subject: 'add original file',
    });
  });

  it('preserves blame for unchanged lines after an unstaged rename is edited', async () => {
    const { GitRunner } = await import('../../src/git/GitRunner');
    const { LineBlameService } = await import('../../src/git/LineBlameService');
    const repository = await mkdtemp(join(tmpdir(), 'git-log-line-blame-edited-rename-'));
    temporaryDirectories.push(repository);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repository });
    await writeFile(join(repository, 'old-name.ts'), 'first\nsecond\nthird\nfourth\n');
    await execFileAsync('git', ['add', 'old-name.ts'], { cwd: repository });
    await execFileAsync('git', ['commit', '-m', 'add original file'], {
      cwd: repository,
      env: gitEnvironment,
    });
    await rename(join(repository, 'old-name.ts'), join(repository, 'new-name.ts'));
    await writeFile(join(repository, 'new-name.ts'), 'first\nchanged\nthird\nfourth\n');

    const service = new LineBlameService(new GitRunner());

    await expect(service.getLineBlame(repository, 'new-name.ts', 3)).resolves.toMatchObject({
      committed: true,
      subject: 'add original file',
    });
    await expect(service.getLineBlame(repository, 'new-name.ts', 2)).resolves.toMatchObject({
      committed: false,
    });
  });

  it('follows a case-only filesystem rename when core.ignorecase is enabled', async () => {
    const { GitRunner } = await import('../../src/git/GitRunner');
    const { LineBlameService } = await import('../../src/git/LineBlameService');
    const repository = await mkdtemp(join(tmpdir(), 'git-log-line-blame-case-rename-'));
    temporaryDirectories.push(repository);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repository });
    await execFileAsync('git', ['config', 'core.ignorecase', 'true'], { cwd: repository });
    await writeFile(join(repository, 'lower-name.ts'), 'const answer = 42;\n');
    await execFileAsync('git', ['add', 'lower-name.ts'], { cwd: repository });
    await execFileAsync('git', ['commit', '-m', 'add lowercase file'], {
      cwd: repository,
      env: gitEnvironment,
    });
    await writeFile(join(repository, 'unrelated.ts'), 'const answer = 42;\n');
    await execFileAsync('git', ['add', 'unrelated.ts'], { cwd: repository });
    await execFileAsync('git', ['commit', '-m', 'add unrelated file'], {
      cwd: repository,
      env: gitEnvironment,
    });
    await rename(join(repository, 'lower-name.ts'), join(repository, 'Lower-Name.ts'));
    await rm(join(repository, 'unrelated.ts'));

    await expect(
      new LineBlameService(new GitRunner()).getLineBlame(repository, 'Lower-Name.ts', 1),
    ).resolves.toMatchObject({
      committed: true,
      subject: 'add lowercase file',
    });
  });

  it('does not infer a rename from only a few common lines', async () => {
    const { GitRunner } = await import('../../src/git/GitRunner');
    const { LineBlameService } = await import('../../src/git/LineBlameService');
    const repository = await mkdtemp(join(tmpdir(), 'git-log-line-blame-not-rename-'));
    temporaryDirectories.push(repository);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repository });
    await writeFile(join(repository, 'deleted.ts'), 'shared-a\nshared-b\nold-one\nold-two\n');
    await execFileAsync('git', ['add', 'deleted.ts'], { cwd: repository });
    await execFileAsync('git', ['commit', '-m', 'add deleted file'], {
      cwd: repository,
      env: gitEnvironment,
    });
    await rm(join(repository, 'deleted.ts'));
    await writeFile(join(repository, 'new-file.ts'), 'shared-a\nshared-b\nnew-one\nnew-two\n');

    await expect(
      new LineBlameService(new GitRunner()).getLineBlame(repository, 'new-file.ts', 1),
    ).resolves.toMatchObject({ committed: false });
  });

  it('follows a modified rename when preserved lines are reordered around a duplicate', async () => {
    const { GitRunner } = await import('../../src/git/GitRunner');
    const { LineBlameService } = await import('../../src/git/LineBlameService');
    const repository = await mkdtemp(join(tmpdir(), 'git-log-line-blame-reordered-rename-'));
    temporaryDirectories.push(repository);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repository });
    await writeFile(join(repository, 'old-name.ts'), 'A\nB\nC\n');
    await execFileAsync('git', ['add', 'old-name.ts'], { cwd: repository });
    await execFileAsync('git', ['commit', '-m', 'add ordered file'], {
      cwd: repository,
      env: gitEnvironment,
    });
    await rename(join(repository, 'old-name.ts'), join(repository, 'new-name.ts'));
    await writeFile(join(repository, 'new-name.ts'), 'B\nA\nB\nC\n');

    await expect(
      new LineBlameService(new GitRunner()).getLineBlame(repository, 'new-name.ts', 4),
    ).resolves.toMatchObject({
      committed: true,
      subject: 'add ordered file',
    });
  });

  it('does not infer a rename when any shortlisted candidate cannot be evaluated', async () => {
    const { GitRunner } = await import('../../src/git/GitRunner');
    const { LineBlameService } = await import('../../src/git/LineBlameService');
    const repository = await mkdtemp(join(tmpdir(), 'git-log-line-blame-incomplete-rename-'));
    temporaryDirectories.push(repository);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repository });
    await writeFile(join(repository, 'large.ts'), `${'large-line\n'.repeat(220_000)}tail\n`);
    await writeFile(join(repository, 'similar.ts'), 'shared-a\nshared-b\nshared-c\nold\n');
    await execFileAsync('git', ['add', 'large.ts', 'similar.ts'], { cwd: repository });
    await execFileAsync('git', ['commit', '-m', 'add candidate files'], {
      cwd: repository,
      env: gitEnvironment,
    });
    await rm(join(repository, 'large.ts'));
    await rm(join(repository, 'similar.ts'));
    await writeFile(join(repository, 'new-file.ts'), 'shared-a\nshared-b\nshared-c\nnew\n');

    await expect(
      new LineBlameService(new GitRunner()).getLineBlame(repository, 'new-file.ts', 1),
    ).resolves.toMatchObject({ committed: false });
  });

  it('caches case-insensitive HEAD path resolution until invalidated', async () => {
    const { GitRunner } = await import('../../src/git/GitRunner');
    const { LineBlameService } = await import('../../src/git/LineBlameService');
    const repository = await mkdtemp(join(tmpdir(), 'git-log-line-blame-case-cache-'));
    temporaryDirectories.push(repository);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repository });
    await writeFile(join(repository, 'tracked.ts'), 'tracked\n');
    await execFileAsync('git', ['add', 'tracked.ts'], { cwd: repository });
    await execFileAsync('git', ['commit', '-m', 'add tracked file'], {
      cwd: repository,
      env: gitEnvironment,
    });
    await writeFile(join(repository, 'new-file.ts'), 'new content\n');
    const runner = new GitRunner();
    const run = vi.fn(runner.run.bind(runner));
    const service = new LineBlameService({ run } as unknown as GitRunner);

    await service.getLineBlame(repository, 'new-file.ts', 1);
    await service.getLineBlame(repository, 'new-file.ts', 1);

    expect(
      run.mock.calls.filter(([args]) => args[0] === 'config' && args.includes('core.ignorecase')),
    ).toHaveLength(1);

    service.invalidate(repository);
    await service.getLineBlame(repository, 'new-file.ts', 1);

    expect(
      run.mock.calls.filter(([args]) => args[0] === 'config' && args.includes('core.ignorecase')),
    ).toHaveLength(2);
  });
});
