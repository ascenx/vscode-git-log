import { describe, expect, it, vi } from 'vitest';
import { GitCommandError, type GitRunner } from '../../src/git/GitRunner';

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
});
