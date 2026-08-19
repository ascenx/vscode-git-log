import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitRunner as RealGitRunner } from '../../src/git/GitRunner';
import type { GitRunOptions, GitRunResult, GitRunner } from '../../src/git/GitRunner';
import type { GitOperationRequest } from '../../src/protocol/messages';
import type { RepositorySummary } from '../../src/shared/models';
import { getOperationConfirmation } from '../../src/git/GitOperationService';

const repository: RepositorySummary = {
  id: 'repo-1',
  rootUri: 'file:///workspace/project',
  gitDirUri: 'file:///workspace/project/.git',
  displayName: 'project',
  isBare: false,
};

const passthroughInspection = {
  inspectRepository: (candidate: RepositorySummary) => Promise.resolve(candidate),
};

const successfulResult: GitRunResult = {
  stdout: Buffer.alloc(0),
  stderr: Buffer.alloc(0),
  exitCode: 0,
  durationMs: 1,
};

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Operation Test',
      GIT_AUTHOR_EMAIL: 'operation@example.com',
      GIT_COMMITTER_NAME: 'Operation Test',
      GIT_COMMITTER_EMAIL: 'operation@example.com',
    },
  });
  return result.stdout.trim();
}

async function createFixtureRepository(prefix = 'git-operation-'): Promise<{ path: string; summary: RepositorySummary }> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  await git(path, 'init', '-b', 'main');
  await git(path, 'config', 'user.name', 'Operation Test');
  await git(path, 'config', 'user.email', 'operation@example.com');
  await writeFile(join(path, 'base.txt'), 'base\n');
  await git(path, 'add', 'base.txt');
  await git(path, 'commit', '-m', 'base');
  return {
    path,
    summary: {
      id: path,
      rootUri: pathToFileURL(path).toString(),
      gitDirUri: pathToFileURL(join(path, '.git')).toString(),
      displayName: 'fixture',
      isBare: false,
    },
  };
}

async function commitFile(cwd: string, name: string, content: string, message: string): Promise<string> {
  await writeFile(join(cwd, name), content);
  await git(cwd, 'add', name);
  await git(cwd, 'commit', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

describe('GitOperationService', () => {
  it('drops a contiguous commit range and rebases newer descendants', async () => {
    const { GitOperationService } = await import('../../src/git/GitOperationService');
    const fixture = await createFixtureRepository('git-operation-drop-range-');
    const base = await git(fixture.path, 'rev-parse', 'HEAD');
    const oldest = await commitFile(fixture.path, 'oldest.txt', 'oldest\n', 'oldest selected');
    const newest = await commitFile(fixture.path, 'newest.txt', 'newest\n', 'newest selected');
    await commitFile(fixture.path, 'descendant.txt', 'descendant\n', 'keep descendant');
    const service = new GitOperationService(new RealGitRunner());

    await service.run(
      fixture.summary,
      { kind: 'dropCommits', hashes: [newest, oldest] },
      { confirm: () => Promise.resolve(true) },
    );

    expect((await git(fixture.path, 'log', '--format=%s')).split('\n')).toEqual([
      'keep descendant',
      'base',
    ]);
    expect(await git(fixture.path, 'rev-parse', 'HEAD^')).toBe(base);
    await expect(stat(join(fixture.path, 'oldest.txt'))).rejects.toThrow();
    await expect(stat(join(fixture.path, 'newest.txt'))).rejects.toThrow();
    await expect(stat(join(fixture.path, 'descendant.txt'))).resolves.toBeDefined();
  });

  it('rewrites a selected range that includes the current HEAD', async () => {
    const { GitOperationService } = await import('../../src/git/GitOperationService');
    const fixture = await createFixtureRepository('git-operation-head-range-');
    const base = await git(fixture.path, 'rev-parse', 'HEAD');
    const oldest = await commitFile(fixture.path, 'oldest.txt', 'oldest\n', 'oldest selected');
    const newest = await commitFile(fixture.path, 'newest.txt', 'newest\n', 'newest selected');
    const service = new GitOperationService(new RealGitRunner());

    await service.run(
      fixture.summary,
      { kind: 'dropCommits', hashes: [newest, oldest] },
      { confirm: () => Promise.resolve(true) },
    );

    expect(await git(fixture.path, 'rev-parse', 'HEAD')).toBe(base);
    expect(await git(fixture.path, 'branch', '--show-current')).toBe('main');
  });

  it('does not update other branches when rebase.updateRefs is enabled', async () => {
    const { GitOperationService } = await import('../../src/git/GitOperationService');
    const fixture = await createFixtureRepository('git-operation-no-update-refs-');
    const oldest = await commitFile(fixture.path, 'oldest.txt', 'oldest\n', 'oldest selected');
    const newest = await commitFile(fixture.path, 'newest.txt', 'newest\n', 'newest selected');
    const descendant = await commitFile(
      fixture.path,
      'descendant.txt',
      'descendant\n',
      'keep descendant',
    );
    await git(fixture.path, 'branch', 'unrelated', descendant);
    await git(fixture.path, 'config', 'rebase.updateRefs', 'true');
    const service = new GitOperationService(new RealGitRunner());

    await service.run(
      fixture.summary,
      { kind: 'dropCommits', hashes: [newest, oldest] },
      { confirm: () => Promise.resolve(true) },
    );

    expect(await git(fixture.path, 'rev-parse', 'unrelated')).toBe(descendant);
    expect(await git(fixture.path, 'rev-parse', 'main')).not.toBe(descendant);
  });

  it('rejects a rewrite when the current branch changes during confirmation', async () => {
    const { GitOperationService } = await import('../../src/git/GitOperationService');
    const fixture = await createFixtureRepository('git-operation-stale-plan-');
    await git(fixture.path, 'branch', 'other');
    const oldest = await commitFile(fixture.path, 'oldest.txt', 'oldest\n', 'oldest selected');
    const newest = await commitFile(fixture.path, 'newest.txt', 'newest\n', 'newest selected');
    const service = new GitOperationService(new RealGitRunner());

    await expect(
      service.run(
        fixture.summary,
        { kind: 'dropCommits', hashes: [newest, oldest] },
        {
          confirm: async () => {
            await git(fixture.path, 'checkout', 'other');
            return true;
          },
        },
      ),
    ).rejects.toThrow('changed during confirmation');
    expect(await git(fixture.path, 'branch', '--show-current')).toBe('other');
    expect(await git(fixture.path, 'rev-parse', 'main')).toBe(newest);
  });

  it('rejects a branch switch that occurs during post-confirmation revalidation', async () => {
    const { GitOperationService } = await import('../../src/git/GitOperationService');
    const fixture = await createFixtureRepository('git-operation-revalidation-race-');
    const oldest = await commitFile(fixture.path, 'oldest.txt', 'oldest\n', 'oldest selected');
    const newest = await commitFile(fixture.path, 'newest.txt', 'newest\n', 'newest selected');
    await git(fixture.path, 'branch', 'other', newest);
    const realRunner = new RealGitRunner();
    let historyReads = 0;
    const runner = {
      async run(args: readonly string[], options: GitRunOptions) {
        const result = await realRunner.run(args, options);
        if (args[0] === 'rev-list' && args.includes('--first-parent')) {
          historyReads += 1;
          if (historyReads === 2) await git(fixture.path, 'checkout', 'other');
        }
        return result;
      },
    } as GitRunner;
    const service = new GitOperationService(runner);

    await expect(
      service.run(
        fixture.summary,
        { kind: 'dropCommits', hashes: [newest, oldest] },
        { confirm: () => Promise.resolve(true) },
      ),
    ).rejects.toThrow('changed during confirmation');
    expect(await git(fixture.path, 'branch', '--show-current')).toBe('other');
    expect(await git(fixture.path, 'rev-parse', 'main')).toBe(newest);
  });

  it('squashes a contiguous commit range with the edited message and keeps newer descendants', async () => {
    const { GitOperationService } = await import('../../src/git/GitOperationService');
    const fixture = await createFixtureRepository('git-operation-squash-range-');
    const oldest = await commitFile(fixture.path, 'oldest.txt', 'oldest\n', 'oldest selected');
    const newest = await commitFile(fixture.path, 'newest.txt', 'newest\n', 'newest selected');
    await commitFile(fixture.path, 'descendant.txt', 'descendant\n', 'keep descendant');
    const service = new GitOperationService(new RealGitRunner());

    await service.run(
      fixture.summary,
      {
        kind: 'squashCommits',
        hashes: [newest, oldest],
        message: 'combined subject\n\ncombined body',
      },
      { confirm: () => Promise.resolve(true) },
    );

    expect((await git(fixture.path, 'log', '--format=%s')).split('\n')).toEqual([
      'keep descendant',
      'combined subject',
      'base',
    ]);
    expect(await git(fixture.path, 'log', '-1', '--format=%B', 'HEAD^')).toBe(
      'combined subject\n\ncombined body',
    );
    await expect(stat(join(fixture.path, 'oldest.txt'))).resolves.toBeDefined();
    await expect(stat(join(fixture.path, 'newest.txt'))).resolves.toBeDefined();
    await expect(stat(join(fixture.path, 'descendant.txt'))).resolves.toBeDefined();
  });

  it('rejects non-contiguous commit ranges and dirty worktrees before rewriting history', async () => {
    const { GitOperationService } = await import('../../src/git/GitOperationService');
    const fixture = await createFixtureRepository('git-operation-invalid-range-');
    const oldest = await commitFile(fixture.path, 'oldest.txt', 'oldest\n', 'oldest selected');
    await commitFile(fixture.path, 'middle.txt', 'middle\n', 'unselected middle');
    const newest = await commitFile(fixture.path, 'newest.txt', 'newest\n', 'newest selected');
    const service = new GitOperationService(new RealGitRunner());

    await expect(
      service.run(
        fixture.summary,
        { kind: 'dropCommits', hashes: [newest, oldest] },
        { confirm: () => Promise.resolve(true) },
      ),
    ).rejects.toThrow('contiguous');

    const middle = await git(fixture.path, 'rev-parse', 'HEAD^');
    await writeFile(join(fixture.path, 'dirty.txt'), 'dirty\n');
    await expect(
      service.run(
        fixture.summary,
        { kind: 'dropCommits', hashes: [newest, middle] },
        { confirm: () => Promise.resolve(true) },
      ),
    ).rejects.toThrow('clean worktree');
  });

  it('rejects ranges containing the root commit or crossing a merge commit', async () => {
    const { GitOperationService } = await import('../../src/git/GitOperationService');
    const rootFixture = await createFixtureRepository('git-operation-root-range-');
    const root = await git(rootFixture.path, 'rev-parse', 'HEAD');
    const second = await commitFile(rootFixture.path, 'second.txt', 'second\n', 'second');
    const service = new GitOperationService(new RealGitRunner());
    await expect(
      service.run(
        rootFixture.summary,
        { kind: 'dropCommits', hashes: [second, root] },
        { confirm: () => Promise.resolve(true) },
      ),
    ).rejects.toThrow('root commit');

    const mergeFixture = await createFixtureRepository('git-operation-merge-range-');
    await git(mergeFixture.path, 'branch', 'side');
    const mainCommit = await commitFile(mergeFixture.path, 'main.txt', 'main\n', 'main change');
    await git(mergeFixture.path, 'checkout', 'side');
    await commitFile(mergeFixture.path, 'side.txt', 'side\n', 'side change');
    await git(mergeFixture.path, 'checkout', 'main');
    await git(mergeFixture.path, 'merge', '--no-ff', '--no-edit', 'side');
    const mergeCommit = await git(mergeFixture.path, 'rev-parse', 'HEAD');
    await expect(
      service.run(
        mergeFixture.summary,
        { kind: 'dropCommits', hashes: [mergeCommit, mainCommit] },
        { confirm: () => Promise.resolve(true) },
      ),
    ).rejects.toThrow('merge commits');
  });

  it('requires destructive confirmation for dropping or squashing commits', () => {
    const hashes = ['b'.repeat(40), 'a'.repeat(40)];
    expect(getOperationConfirmation(repository, { kind: 'dropCommits', hashes })).toMatchObject({
      destructive: true,
      confirmLabel: 'Drop Commits',
    });
    expect(
      getOperationConfirmation(repository, {
        kind: 'squashCommits',
        hashes,
        message: 'combined',
      }),
    ).toMatchObject({ destructive: true, confirmLabel: 'Squash Commits' });
  });

  it('maps supported operations to shell-free Git argument arrays', async () => {
    const modulePath = '../../src/git/GitOperationService';
    const operationModule = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(operationModule, 'GitOperationService must exist').toBeDefined();
    if (!operationModule) return;

    const calls: string[][] = [];
    const runner = {
      run(args: readonly string[]) {
        calls.push([...args]);
        if (args[0] === 'remote') {
          return Promise.resolve({ ...successfulResult, stdout: Buffer.from('origin\n') });
        }
        return Promise.resolve(successfulResult);
      },
    } as unknown as GitRunner;
    const service = new operationModule.GitOperationService(runner, passthroughInspection);
    const cases: Array<[GitOperationRequest, string[]]> = [
      [{ kind: 'checkout', ref: 'main' }, ['checkout', 'main', '--']],
      [
        { kind: 'createBranch', name: 'feature/login', startPoint: 'abc1234' },
        ['branch', '--', 'feature/login', 'abc1234'],
      ],
      [{ kind: 'createTag', name: 'v1.0.0', target: 'abc1234' }, ['tag', '--', 'v1.0.0', 'abc1234']],
      [{ kind: 'deleteTag', name: 'v1.0.0' }, ['tag', '-d', '--', 'v1.0.0']],
      [
        { kind: 'checkoutRemote', name: 'feature', startPoint: 'origin/feature' },
        ['checkout', '-b', 'feature', '--track', 'origin/feature'],
      ],
      [
        { kind: 'deleteRemoteBranch', remote: 'origin', branch: 'feature' },
        ['push', 'origin', '--delete', 'refs/heads/feature'],
      ],
      [{ kind: 'fetch', remote: 'origin' }, ['fetch', 'origin']],
      [{ kind: 'pull' }, ['pull']],
      [{ kind: 'cherryPick', hash: 'abc1234' }, ['cherry-pick', 'abc1234']],
      [{ kind: 'revert', hash: 'abc1234' }, ['revert', '--no-edit', 'abc1234']],
      [{ kind: 'merge', ref: 'feature/login' }, ['merge', '--no-edit', 'feature/login']],
      [{ kind: 'rebase', ref: 'main' }, ['rebase', 'main']],
      [{ kind: 'reset', hash: 'abc1234', mode: 'hard' }, ['reset', '--hard', 'abc1234', '--']],
      [
        { kind: 'renameBranch', oldName: 'feature/login', newName: 'feature/auth' },
        ['branch', '-m', '--', 'feature/login', 'feature/auth'],
      ],
      [{ kind: 'deleteBranch', name: 'feature/auth', force: true }, ['branch', '-D', '--', 'feature/auth']],
    ];

    for (const [operation] of cases) {
      await service.run(repository, operation, { confirm: () => Promise.resolve(true) });
    }

    for (const [, args] of cases) expect(calls).toContainEqual(args);
  });

  it('requires explicit confirmation before deleting tags or remote branches', () => {
    const remote = getOperationConfirmation(repository, {
      kind: 'deleteRemoteBranch',
      remote: 'origin',
      branch: 'feature',
    });
    const tag = getOperationConfirmation(repository, { kind: 'deleteTag', name: 'v1.0.0' });

    expect(remote).toMatchObject({ destructive: true, confirmLabel: 'Delete Remote Branch' });
    expect(remote?.detail).toContain('origin/feature');
    expect(tag).toMatchObject({ destructive: true, confirmLabel: 'Delete Tag' });
  });

  it('refuses destructive operations when no confirmation handler is available', async () => {
    const { GitOperationService } = await import('../../src/git/GitOperationService');
    const run = vi.fn().mockResolvedValue(successfulResult);
    const service = new GitOperationService({ run } as unknown as GitRunner, passthroughInspection);

    await expect(
      service.run(repository, { kind: 'deleteTag', name: 'v1.0.0' }),
    ).rejects.toThrow('requires confirmation');
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects remote-branch deletion unless the remote is configured and tracked locally', async () => {
    const { GitOperationService } = await import('../../src/git/GitOperationService');
    const run = vi.fn().mockImplementation((args: readonly string[]) => {
      if (args[0] === 'remote') return Promise.resolve({ ...successfulResult, stdout: Buffer.from('upstream\n') });
      return Promise.resolve(successfulResult);
    });
    const service = new GitOperationService({ run } as unknown as GitRunner, passthroughInspection);

    await expect(
      service.run(
        repository,
        { kind: 'deleteRemoteBranch', remote: 'origin', branch: 'feature' },
        { confirm: () => Promise.resolve(true) },
      ),
    ).rejects.toThrow('configured remote');
    expect(run.mock.calls.some(([args]) => args[0] === 'push')).toBe(false);
  });

  it('serializes operations for one repository while allowing another repository to proceed', async () => {
    const operationModule = await import('../../src/git/GitOperationService');
    const started: string[] = [];
    let finishFirst: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const runner = {
      async run(args: readonly string[], options: GitRunOptions) {
        started.push(`${options.cwd}:${args.join(' ')}`);
        if (args.includes('one')) await first;
        return successfulResult;
      },
    } as unknown as GitRunner;
    const service = new operationModule.GitOperationService(runner, passthroughInspection);
    const otherRepository = {
      ...repository,
      id: 'repo-2',
      rootUri: 'file:///workspace/other',
      gitDirUri: 'file:///workspace/other/.git',
      displayName: 'other',
    };

    const firstRun = service.run(repository, { kind: 'checkout', ref: 'one' });
    const secondRun = service.run(repository, { kind: 'checkout', ref: 'two' });
    const otherRun = service.run(otherRepository, { kind: 'checkout', ref: 'other' });
    await vi.waitFor(() => expect(started).toHaveLength(2));
    expect(started).toEqual(
      expect.arrayContaining([
        '/workspace/project:checkout one --',
        '/workspace/other:checkout other --',
      ]),
    );
    expect(started.some((entry) => entry.includes('checkout two'))).toBe(false);

    finishFirst?.();
    await Promise.all([firstRun, secondRun, otherRun]);
    expect(started.at(-1)).toBe('/workspace/project:checkout two --');
  });

  it('serializes linked worktrees that share a common Git directory', async () => {
    const { GitOperationService } = await import('../../src/git/GitOperationService');
    const started: string[] = [];
    let finishFirst: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const runner = {
      async run(args: readonly string[], options: GitRunOptions) {
        started.push(`${options.cwd}:${args.join(' ')}`);
        if (args.includes('main')) await first;
        return successfulResult;
      },
    } as unknown as GitRunner;
    const service = new GitOperationService(runner, passthroughInspection);
    const mainWorktree = {
      ...repository,
      commonGitDirUri: 'file:///workspace/project/.git',
    };
    const linkedWorktree: RepositorySummary = {
      ...repository,
      id: 'repo-linked',
      rootUri: 'file:///workspace/project-feature',
      gitDirUri: 'file:///workspace/project/.git/worktrees/project-feature',
      commonGitDirUri: 'file:///workspace/project/.git',
      displayName: 'project-feature',
    };

    const mainRun = service.run(mainWorktree, { kind: 'checkout', ref: 'main' });
    const linkedRun = service.run(linkedWorktree, { kind: 'checkout', ref: 'feature' });
    await vi.waitFor(() => expect(started).toHaveLength(1));
    expect(started).toEqual(['/workspace/project:checkout main --']);

    finishFirst?.();
    await Promise.all([mainRun, linkedRun]);
    expect(started).toEqual([
      '/workspace/project:checkout main --',
      '/workspace/project-feature:checkout feature --',
    ]);
  });

  it('prepares and confirms a queued force push against fresh state under the repository lock', async () => {
    const { GitOperationService } = await import('../../src/git/GitOperationService');
    const mainHash = 'a'.repeat(40);
    const featureHash = 'b'.repeat(40);
    let currentBranch = 'main';
    let head = mainHash;
    let releaseCheckout: (() => void) | undefined;
    let checkoutStarted: (() => void) | undefined;
    const checkoutGate = new Promise<void>((resolve) => {
      releaseCheckout = resolve;
    });
    const started = new Promise<void>((resolve) => {
      checkoutStarted = resolve;
    });
    const calls: string[][] = [];
    const runner = {
      async run(args: readonly string[]) {
        calls.push([...args]);
        if (args[0] === 'checkout') {
          checkoutStarted?.();
          await checkoutGate;
          currentBranch = 'feature';
          head = featureHash;
          return successfulResult;
        }
        if (args[0] === 'config' && args[1] === '--get') {
          const values = new Map<string, string>([
            ['branch.feature.remote', 'origin'],
            ['branch.feature.merge', 'refs/heads/feature'],
            ['push.default', 'simple'],
          ]);
          const value = values.get(args[2] ?? '');
          if (value) return { ...successfulResult, stdout: Buffer.from(`${value}\n`) };
          throw new (await import('../../src/git/GitRunner')).GitCommandError(
            'missing config',
            args,
            '/workspace/project',
            1,
            Buffer.alloc(0),
            Buffer.alloc(0),
            false,
            false,
          );
        }
        if (args[0] === 'config' && args[1] === '--get-all') {
          throw new (await import('../../src/git/GitRunner')).GitCommandError(
            'missing config',
            args,
            '/workspace/project',
            1,
            Buffer.alloc(0),
            Buffer.alloc(0),
            false,
            false,
          );
        }
        if (args[0] === 'rev-parse') {
          return { ...successfulResult, stdout: Buffer.from(`${head}\n`) };
        }
        return successfulResult;
      },
    } as unknown as GitRunner;
    const service = new GitOperationService(runner, {
      inspectRepository: () =>
        Promise.resolve({ ...repository, currentBranch, head }),
    } as never);
    const confirm = vi.fn().mockResolvedValue(true);

    const checkout = service.run(repository, { kind: 'checkout', ref: 'feature' });
    await started;
    const forcePush = service.run(
      repository,
      { kind: 'push', forceWithLease: true },
      { confirm },
    );
    releaseCheckout?.();
    await Promise.all([checkout, forcePush]);

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.stringContaining('origin/refs/heads/feature') }),
    );
    expect(calls.at(-1)).toEqual([
      'push',
      '--force-with-lease=refs/heads/feature',
      'origin',
      `${featureHash}:refs/heads/feature`,
    ]);
  });

  it('describes destructive confirmations with the repository and actual target', async () => {
    const operationModule = await import('../../src/git/GitOperationService');

    expect(
      operationModule.getOperationConfirmation(repository, {
        kind: 'reset',
        mode: 'hard',
        hash: 'abc1234',
      }),
    ).toMatchObject({ destructive: true, confirmLabel: 'Hard Reset' });
    expect(
      operationModule.getOperationConfirmation(repository, {
        kind: 'deleteBranch',
        name: 'feature/login',
        force: true,
      })?.detail,
    ).toContain('project');
    expect(
      operationModule.getOperationConfirmation(repository, {
        kind: 'deleteBranch',
        name: 'feature/login',
        force: true,
      })?.detail,
    ).toContain('feature/login');
    expect(
      operationModule.getOperationConfirmation(repository, {
        kind: 'push',
        forceWithLease: true,
        remote: 'origin',
        targetRef: 'refs/heads/main',
      }),
    ).toMatchObject({ destructive: true, confirmLabel: 'Force Push with Lease' });
    expect(
      operationModule.getOperationConfirmation(repository, {
        kind: 'push',
        forceWithLease: true,
        remote: 'origin',
        targetRef: 'refs/heads/main',
      })?.detail,
    ).toContain('origin/refs/heads/main');
    expect(operationModule.getOperationConfirmation(repository, { kind: 'fetch' })).toBeUndefined();
  });

  it('rejects every write operation for a bare repository before invoking Git', async () => {
    const { GitOperationService } = await import('../../src/git/GitOperationService');
    const run = vi.fn().mockResolvedValue(successfulResult);
    const service = new GitOperationService(
      { run } as unknown as GitRunner,
      passthroughInspection,
    );

    await expect(
      service.run({ ...repository, isBare: true }, { kind: 'fetch' }),
    ).rejects.toThrow('read-only');
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects conflicting operations while a sequenced Git operation is in progress', async () => {
    const { GitOperationService } = await import('../../src/git/GitOperationService');
    const run = vi.fn().mockResolvedValue(successfulResult);
    const service = new GitOperationService(
      { run } as unknown as GitRunner,
      passthroughInspection,
    );

    await expect(
      service.run(
        { ...repository, operationState: 'rebase' },
        { kind: 'checkout', ref: 'feature' },
      ),
    ).rejects.toThrow('rebase is in progress');
    expect(run).not.toHaveBeenCalled();
  });

  it('resolves and pins the exact upstream target for force push with lease', async () => {
    const { GitOperationService } = await import('../../src/git/GitOperationService');
    const calls: string[][] = [];
    const values = new Map<string, string>([
      ['branch.main.pushRemote', 'origin'],
      ['branch.main.remote', 'origin'],
      ['branch.main.merge', 'refs/heads/main'],
    ]);
    const runner = {
      run(args: readonly string[]) {
        calls.push([...args]);
        if (args[0] === 'config') {
          const value = values.get(args[2] ?? '');
          if (value !== undefined) {
            return Promise.resolve({ ...successfulResult, stdout: Buffer.from(`${value}\n`) });
          }
          return Promise.resolve({ ...successfulResult, stdout: Buffer.alloc(0) });
        }
        if (args[0] === 'rev-parse') {
          return Promise.resolve({ ...successfulResult, stdout: Buffer.from(`${'a'.repeat(40)}\n`) });
        }
        return Promise.resolve(successfulResult);
      },
    } as unknown as GitRunner;
    const service = new GitOperationService(runner, {
      inspectRepository: (candidate) =>
        Promise.resolve({ ...candidate, currentBranch: 'main', head: 'a'.repeat(40) }),
    });
    const target = await service.resolvePushTarget({ ...repository, currentBranch: 'main' });
    await service.run(
      { ...repository, currentBranch: 'main' },
      { kind: 'push', forceWithLease: true },
      { confirm: () => Promise.resolve(true) },
    );

    expect(target).toEqual({ remote: 'origin', targetRef: 'refs/heads/main' });
    expect(calls).toContainEqual(['rev-parse', '--verify', 'HEAD^{commit}']);
    expect(calls.at(-1)).toEqual([
      'push',
      '--force-with-lease=refs/heads/main',
      'origin',
      `${'a'.repeat(40)}:refs/heads/main`,
    ]);
  });

  it('falls back through unset optional push config in a real repository', async () => {
    const { GitOperationService } = await import('../../src/git/GitOperationService');
    const fixture = await createFixtureRepository('git-operation-push-target-');
    const remote = await mkdtemp(join(tmpdir(), 'git-operation-push-target-remote-'));
    temporaryDirectories.push(remote);
    await git(remote, 'init', '--bare');
    await git(fixture.path, 'remote', 'add', 'origin', remote);
    await git(fixture.path, 'push', '-u', 'origin', 'main');

    const service = new GitOperationService(new RealGitRunner());
    await expect(
      service.resolvePushTarget({ ...fixture.summary, currentBranch: 'main' }),
    ).resolves.toEqual({ remote: 'origin', targetRef: 'refs/heads/main' });
  });

  it('rejects push.default=simple when the current branch has no upstream', async () => {
    const { GitOperationService } = await import('../../src/git/GitOperationService');
    const fixture = await createFixtureRepository('git-operation-simple-no-upstream-');
    const remote = await mkdtemp(join(tmpdir(), 'git-operation-simple-no-upstream-remote-'));
    temporaryDirectories.push(remote);
    await git(remote, 'init', '--bare');
    await git(fixture.path, 'remote', 'add', 'origin', remote);
    await git(fixture.path, 'config', 'push.default', 'simple');

    const service = new GitOperationService(new RealGitRunner());
    await expect(
      service.resolvePushTarget({ ...fixture.summary, currentBranch: 'main' }),
    ).rejects.toThrow('no upstream push target');
  });

  it('treats push.default=tracking as upstream for force-push target resolution', async () => {
    const { GitOperationService } = await import('../../src/git/GitOperationService');
    const fixture = await createFixtureRepository('git-operation-tracking-target-');
    const remote = await mkdtemp(join(tmpdir(), 'git-operation-tracking-target-remote-'));
    temporaryDirectories.push(remote);
    await git(remote, 'init', '--bare');
    await git(fixture.path, 'remote', 'add', 'origin', remote);
    await git(fixture.path, 'config', 'branch.main.remote', 'origin');
    await git(fixture.path, 'config', 'branch.main.merge', 'refs/heads/develop');
    await git(fixture.path, 'config', 'push.default', 'tracking');

    const service = new GitOperationService(new RealGitRunner());
    await expect(
      service.resolvePushTarget({ ...fixture.summary, currentBranch: 'main' }),
    ).resolves.toEqual({ remote: 'origin', targetRef: 'refs/heads/develop' });
  });

  it('uses current-branch semantics for simple pushes to a triangular push remote', async () => {
    const { GitOperationService } = await import('../../src/git/GitOperationService');
    const fixture = await createFixtureRepository('git-operation-triangular-target-');
    const origin = await mkdtemp(join(tmpdir(), 'git-operation-triangular-origin-'));
    const fork = await mkdtemp(join(tmpdir(), 'git-operation-triangular-fork-'));
    temporaryDirectories.push(origin, fork);
    await git(origin, 'init', '--bare');
    await git(fork, 'init', '--bare');
    await git(fixture.path, 'remote', 'add', 'origin', origin);
    await git(fixture.path, 'remote', 'add', 'fork', fork);
    await git(fixture.path, 'config', 'branch.main.remote', 'origin');
    await git(fixture.path, 'config', 'branch.main.merge', 'refs/heads/develop');
    await git(fixture.path, 'config', 'branch.main.pushRemote', 'fork');
    await git(fixture.path, 'config', 'push.default', 'simple');

    const service = new GitOperationService(new RealGitRunner());
    await expect(
      service.resolvePushTarget({ ...fixture.summary, currentBranch: 'main' }),
    ).resolves.toEqual({ remote: 'fork', targetRef: 'refs/heads/main' });
  });

  it('honors a single remote push refspec when resolving the force-push destination', async () => {
    const { GitOperationService } = await import('../../src/git/GitOperationService');
    const fixture = await createFixtureRepository('git-operation-push-refspec-');
    const remote = await mkdtemp(join(tmpdir(), 'git-operation-push-refspec-remote-'));
    temporaryDirectories.push(remote);
    await git(remote, 'init', '--bare');
    await git(fixture.path, 'remote', 'add', 'origin', remote);
    await git(fixture.path, 'config', 'branch.main.remote', 'origin');
    await git(fixture.path, 'config', 'branch.main.merge', 'refs/heads/main');
    await git(
      fixture.path,
      'config',
      'remote.origin.push',
      'refs/heads/main:refs/heads/review/main',
    );

    const service = new GitOperationService(new RealGitRunner());
    await expect(
      service.resolvePushTarget({ ...fixture.summary, currentBranch: 'main' }),
    ).resolves.toEqual({ remote: 'origin', targetRef: 'refs/heads/review/main' });
  });

  it('rejects configured push refspecs whose destination namespace is implicit', async () => {
    const { GitOperationService } = await import('../../src/git/GitOperationService');
    const fixture = await createFixtureRepository('git-operation-shorthand-refspec-');
    const remote = await mkdtemp(join(tmpdir(), 'git-operation-shorthand-refspec-remote-'));
    temporaryDirectories.push(remote);
    await git(remote, 'init', '--bare');
    await git(fixture.path, 'remote', 'add', 'origin', remote);
    await git(fixture.path, 'config', 'branch.main.remote', 'origin');
    await git(fixture.path, 'config', 'branch.main.merge', 'refs/heads/main');
    const service = new GitOperationService(new RealGitRunner());

    await git(fixture.path, 'config', 'remote.origin.push', 'HEAD');
    await expect(
      service.resolvePushTarget({ ...fixture.summary, currentBranch: 'main' }),
    ).rejects.toThrow('fully qualified');

    await git(fixture.path, 'config', 'remote.origin.push', 'refs/tags/v1:release');
    await expect(
      service.resolvePushTarget({ ...fixture.summary, currentBranch: 'main' }),
    ).rejects.toThrow('fully qualified');
  });

  it('rejects mirror and multi-ref remote push configurations for force push', async () => {
    const { GitOperationService } = await import('../../src/git/GitOperationService');
    const fixture = await createFixtureRepository('git-operation-ambiguous-push-refspec-');
    const remote = await mkdtemp(join(tmpdir(), 'git-operation-ambiguous-push-refspec-remote-'));
    temporaryDirectories.push(remote);
    await git(remote, 'init', '--bare');
    await git(fixture.path, 'remote', 'add', 'origin', remote);
    await git(fixture.path, 'config', 'branch.main.remote', 'origin');
    await git(fixture.path, 'config', 'branch.main.merge', 'refs/heads/main');
    const service = new GitOperationService(new RealGitRunner());

    await git(fixture.path, 'config', 'remote.origin.mirror', 'true');
    await expect(
      service.resolvePushTarget({ ...fixture.summary, currentBranch: 'main' }),
    ).rejects.toThrow('mirror');

    await git(fixture.path, 'config', '--unset', 'remote.origin.mirror');
    await git(fixture.path, 'config', '--add', 'remote.origin.push', 'main:main');
    await git(fixture.path, 'config', '--add', 'remote.origin.push', 'feature:feature');
    await expect(
      service.resolvePushTarget({ ...fixture.summary, currentBranch: 'main' }),
    ).rejects.toThrow('multiple');
  });

  it('rejects an unknown push.default mode instead of guessing a force-push target', async () => {
    const { GitOperationService } = await import('../../src/git/GitOperationService');
    const fixture = await createFixtureRepository('git-operation-unknown-push-default-');
    await git(fixture.path, 'config', 'push.default', 'surprise');

    const service = new GitOperationService(new RealGitRunner());
    await expect(
      service.resolvePushTarget({ ...fixture.summary, currentBranch: 'main' }),
    ).rejects.toThrow();
  });

  it('executes local history and branch operations in a disposable repository', async () => {
    const { GitOperationService } = await import('../../src/git/GitOperationService');
    const fixture = await createFixtureRepository();
    const service = new GitOperationService(new RealGitRunner());
    const baseHash = await git(fixture.path, 'rev-parse', 'HEAD');

    await service.run(fixture.summary, { kind: 'createBranch', name: 'feature', startPoint: baseHash });
    await service.run(fixture.summary, { kind: 'checkout', ref: 'feature' });
    await writeFile(join(fixture.path, 'feature.txt'), 'feature\n');
    await git(fixture.path, 'add', 'feature.txt');
    await git(fixture.path, 'commit', '-m', 'feature change');
    const featureHash = await git(fixture.path, 'rev-parse', 'HEAD');
    await service.run(fixture.summary, { kind: 'checkout', ref: 'main' });
    await service.run(fixture.summary, { kind: 'cherryPick', hash: featureHash });
    const cherryPickHash = await git(fixture.path, 'rev-parse', 'HEAD');
    await expect(stat(join(fixture.path, 'feature.txt'))).resolves.toBeDefined();
    await service.run(fixture.summary, { kind: 'revert', hash: cherryPickHash });
    await expect(stat(join(fixture.path, 'feature.txt'))).rejects.toThrow();

    await service.run(fixture.summary, { kind: 'createTag', name: 'v1.0.0', target: baseHash });
    await service.run(fixture.summary, { kind: 'createBranch', name: 'old-name', startPoint: baseHash });
    await service.run(fixture.summary, {
      kind: 'renameBranch',
      oldName: 'old-name',
      newName: 'new-name',
    });
    await service.run(
      fixture.summary,
      { kind: 'deleteBranch', name: 'new-name', force: true },
      { confirm: () => Promise.resolve(true) },
    );
    expect(await git(fixture.path, 'tag', '--list', 'v1.0.0')).toBe('v1.0.0');
    expect(await git(fixture.path, 'branch', '--list', 'new-name')).toBe('');
    await service.run(
      fixture.summary,
      { kind: 'deleteTag', name: 'v1.0.0' },
      { confirm: () => Promise.resolve(true) },
    );
    expect(await git(fixture.path, 'tag', '--list', 'v1.0.0')).toBe('');

    await service.run(
      fixture.summary,
      { kind: 'reset', mode: 'hard', hash: baseHash },
      { confirm: () => Promise.resolve(true) },
    );
    await service.run(fixture.summary, { kind: 'createBranch', name: 'merge-source', startPoint: baseHash });
    await service.run(fixture.summary, { kind: 'checkout', ref: 'merge-source' });
    await writeFile(join(fixture.path, 'merge.txt'), 'merge\n');
    await git(fixture.path, 'add', 'merge.txt');
    await git(fixture.path, 'commit', '-m', 'merge source');
    await service.run(fixture.summary, { kind: 'checkout', ref: 'main' });
    await service.run(fixture.summary, { kind: 'merge', ref: 'merge-source' });
    expect(await git(fixture.path, 'rev-parse', 'HEAD')).not.toBe(baseHash);

    await service.run(fixture.summary, { kind: 'createBranch', name: 'rebase-source', startPoint: baseHash });
    await service.run(fixture.summary, { kind: 'checkout', ref: 'rebase-source' });
    await writeFile(join(fixture.path, 'rebase.txt'), 'rebase\n');
    await git(fixture.path, 'add', 'rebase.txt');
    await git(fixture.path, 'commit', '-m', 'rebase source');
    await service.run(fixture.summary, { kind: 'rebase', ref: 'main' });
    expect(await git(fixture.path, 'merge-base', '--is-ancestor', 'main', 'HEAD')).toBe('');
  });

  it('fetches, pulls, and pushes through a local bare remote', async () => {
    const { GitOperationService } = await import('../../src/git/GitOperationService');
    const fixture = await createFixtureRepository('git-operation-local-');
    const remote = await mkdtemp(join(tmpdir(), 'git-operation-remote-'));
    const peer = await mkdtemp(join(tmpdir(), 'git-operation-peer-'));
    temporaryDirectories.push(remote, peer);
    await git(remote, 'init', '--bare');
    await git(fixture.path, 'remote', 'add', 'origin', remote);
    await git(fixture.path, 'push', '-u', 'origin', 'main');
    await execFileAsync('git', ['clone', '-b', 'main', remote, peer]);
    await git(peer, 'checkout', '-b', 'topic');
    await writeFile(join(peer, 'topic.txt'), 'topic\n');
    await git(peer, 'add', 'topic.txt');
    await git(peer, 'commit', '-m', 'topic change');
    await git(peer, 'push', '-u', 'origin', 'topic');
    await git(peer, 'checkout', 'main');
    await writeFile(join(peer, 'peer.txt'), 'peer\n');
    await git(peer, 'add', 'peer.txt');
    await git(peer, 'commit', '-m', 'peer change');
    await git(peer, 'push', 'origin', 'main');

    const service = new GitOperationService(new RealGitRunner());
    await service.run(fixture.summary, { kind: 'fetch', remote: 'origin' });
    await service.run(fixture.summary, {
      kind: 'checkoutRemote',
      name: 'topic-local',
      startPoint: 'origin/topic',
    });
    expect(await git(fixture.path, 'branch', '--show-current')).toBe('topic-local');
    await service.run(fixture.summary, { kind: 'checkout', ref: 'main' });
    await service.run(
      fixture.summary,
      { kind: 'deleteRemoteBranch', remote: 'origin', branch: 'topic' },
      { confirm: () => Promise.resolve(true) },
    );
    await expect(
      execFileAsync('git', ['show-ref', '--verify', 'refs/heads/topic'], { cwd: remote }),
    ).rejects.toBeDefined();
    await service.run(fixture.summary, { kind: 'pull' });
    await expect(stat(join(fixture.path, 'peer.txt'))).resolves.toBeDefined();
    await writeFile(join(fixture.path, 'local.txt'), 'local\n');
    await git(fixture.path, 'add', 'local.txt');
    await git(fixture.path, 'commit', '-m', 'local change');
    await service.run(fixture.summary, { kind: 'push' });
    expect(await git(remote, 'rev-parse', 'main')).toBe(await git(fixture.path, 'rev-parse', 'main'));
  });
});
