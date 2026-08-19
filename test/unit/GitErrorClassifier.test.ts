import { describe, expect, it } from 'vitest';
import { GitCommandError } from '../../src/git/GitRunner';

function error(stderr: string): GitCommandError {
  return new GitCommandError(
    'Git command exited with code 1.',
    ['cherry-pick', 'abc1234'],
    '/workspace/project',
    1,
    Buffer.alloc(0),
    Buffer.from(stderr),
    false,
    false,
  );
}

describe('classifyGitError', () => {
  it('classifies conflicts, authentication, hooks, and redacts credential URLs', async () => {
    const modulePath = '../../src/git/classifyGitError';
    const classifier = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(classifier, 'Git error classifier must exist').toBeDefined();
    if (!classifier) return;

    expect(classifier.classifyGitError(error('CONFLICT (content): Merge conflict in app.ts'))).toMatchObject({
      message: 'Git stopped because of conflicts.',
      category: 'conflict',
    });
    expect(classifier.classifyGitError(error('fatal: Authentication failed for origin'))).toMatchObject({
      category: 'authentication',
    });
    expect(classifier.classifyGitError(error('pre-commit hook declined'))).toMatchObject({
      category: 'hook',
    });
    expect(
      classifier.classifyGitError(
        error('fatal: unable to access https://alice:secret@example.com/repo.git'),
      ).detail,
    ).not.toContain('secret');
    expect(classifier.redactGitDiagnostic('https://personal-access-token@example.com/repo.git')).toBe(
      'https://***@example.com/repo.git',
    );
  });

  it('provides installation guidance when the Git executable cannot start', async () => {
    const classifier = await import('../../src/git/classifyGitError');
    const unavailable = new GitCommandError(
      'Unable to start /missing/git: ENOENT',
      ['--version'],
      '/workspace/project',
      null,
      Buffer.alloc(0),
      Buffer.alloc(0),
      false,
      false,
    );

    const classified = classifier.classifyGitError(unavailable);
    expect(classified).toMatchObject({ category: 'repository' });
    expect(classified.message).toContain('Git 2.27 or newer');
    expect(classified.message).toContain('gitLogWorkbench.git.path');
  });

  it('does not misclassify timeouts or output limits as a missing Git executable', async () => {
    const classifier = await import('../../src/git/classifyGitError');
    const timedOut = new GitCommandError(
      'Git command timed out.',
      ['log'],
      '/workspace/project',
      null,
      Buffer.alloc(0),
      Buffer.alloc(0),
      false,
      true,
    );
    const outputLimited = new GitCommandError(
      'Git stdout exceeded 67108864 bytes.',
      ['log'],
      '/workspace/project',
      null,
      Buffer.alloc(0),
      Buffer.alloc(0),
      false,
      false,
    );

    expect(classifier.classifyGitError(timedOut)).toMatchObject({
      message: 'Git query timed out. Try a smaller selection or a narrower history request.',
    });
    expect(classifier.classifyGitError(outputLimited)).toMatchObject({
      message: 'Git output exceeded the safety limit. Try a smaller selection or history request.',
    });
    expect(classifier.classifyGitError(error('fatal: file image.png is binary'))).toMatchObject({
      message: 'Binary files do not support line history.',
    });
  });
});
