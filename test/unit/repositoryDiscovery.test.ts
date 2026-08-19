import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { GitRunner } from '../../src/git/GitRunner';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function initializeRepository(path: string, bare = false): Promise<void> {
  await mkdir(path, { recursive: true });
  await execFileAsync('git', bare ? ['init', '--bare', path] : ['init', '-b', 'main', path]);
}

describe('discoverRepositories', () => {
  it('discovers root, nested, and bare repositories without duplicates', async () => {
    const modulePath = '../../src/repositories/discoverRepositories';
    const discoveryModule = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(discoveryModule, 'repository discovery must exist').toBeDefined();
    if (!discoveryModule) return;

    const workspace = await mkdtemp(join(tmpdir(), 'git-log-workbench-discovery-'));
    temporaryDirectories.push(workspace);
    const nested = join(workspace, 'packages', 'nested');
    const bare = join(workspace, 'remotes', 'origin.git');
    await initializeRepository(workspace);
    await initializeRepository(nested);
    await initializeRepository(bare, true);

    const repositories = await discoveryModule.discoverRepositories(
      [workspace],
      new GitRunner(),
      { scanDepth: 3, excludedDirectoryNames: ['node_modules'] },
    );

    expect(repositories).toHaveLength(3);
    expect(repositories.map((repository: { displayName: string }) => repository.displayName).sort()).toEqual(
      [basename(workspace), 'nested', 'origin.git'].sort(),
    );
    expect(repositories.filter((repository: { isBare: boolean }) => repository.isBare)).toHaveLength(1);
    expect(new Set(repositories.map((repository: { id: string }) => repository.id)).size).toBe(3);
  });

  it('respects scan depth and excluded directory names', async () => {
    const modulePath = '../../src/repositories/discoverRepositories';
    const discoveryModule = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(discoveryModule, 'repository discovery must exist').toBeDefined();
    if (!discoveryModule) return;

    const workspace = await mkdtemp(join(tmpdir(), 'git-log-workbench-discovery-'));
    temporaryDirectories.push(workspace);
    await initializeRepository(join(workspace, 'level-one', 'level-two'));
    await initializeRepository(join(workspace, 'node_modules', 'ignored'));

    const repositories = await discoveryModule.discoverRepositories(
      [workspace],
      new GitRunner(),
      { scanDepth: 1, excludedDirectoryNames: ['node_modules'] },
    );

    expect(repositories).toEqual([]);
  });

  it('respects configured glob exclusion patterns', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'git-log-workbench-discovery-glob-'));
    temporaryDirectories.push(workspace);
    await initializeRepository(join(workspace, 'apps', 'included'));
    await initializeRepository(join(workspace, 'vendor', 'ignored'));

    const repositories = await import('../../src/repositories/discoverRepositories').then((module) =>
      module.discoverRepositories([workspace], new GitRunner(), {
        scanDepth: 3,
        excludePatterns: ['**/vendor/**'],
      }),
    );

    expect(repositories.map((repository) => repository.displayName)).toEqual(['included']);
  });

  it('reports missing and unsupported Git versions before repository scanning', async () => {
    const { ensureSupportedGit } = await import('../../src/repositories/discoverRepositories');
    const result = (version: string) => ({
      stdout: Buffer.from(`${version}\n`),
      stderr: Buffer.alloc(0),
      exitCode: 0,
      durationMs: 1,
    });
    await expect(
      ensureSupportedGit(
        { run: () => Promise.resolve(result('git version 2.26.9')) } as never,
        process.cwd(),
      ),
    ).rejects.toThrow('Git 2.27 or newer');
    await expect(
      ensureSupportedGit(
        { run: () => Promise.resolve(result('git version 2.27.0')) } as never,
        process.cwd(),
      ),
    ).resolves.toBe('2.27.0');
    await expect(
      ensureSupportedGit(
        { run: () => Promise.resolve(result('git version 2.44.0.windows.1')) } as never,
        process.cwd(),
      ),
    ).resolves.toBe('2.44.0');
  });

  it('represents detached HEAD without inventing a current branch', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'git-log-workbench-discovery-'));
    temporaryDirectories.push(workspace);
    await initializeRepository(workspace);
    await execFileAsync('git', ['commit', '--allow-empty', '-m', 'detached target'], {
      cwd: workspace,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Alice',
        GIT_AUTHOR_EMAIL: 'alice@example.com',
        GIT_COMMITTER_NAME: 'Alice',
        GIT_COMMITTER_EMAIL: 'alice@example.com',
      },
    });
    await execFileAsync('git', ['checkout', '--detach', 'HEAD'], { cwd: workspace });

    const repositories = await import('../../src/repositories/discoverRepositories').then((module) =>
      module.discoverRepositories([workspace], new GitRunner(), { scanDepth: 0 }),
    );

    expect(repositories).toHaveLength(1);
    expect(repositories[0]?.head).toMatch(/^[0-9a-f]{40,64}$/u);
    expect(repositories[0]?.currentBranch).toBeUndefined();
  });

  it('reports an in-progress Git operation from the worktree Git directory', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'git-log-workbench-operation-state-'));
    temporaryDirectories.push(workspace);
    await initializeRepository(workspace);
    await writeFile(join(workspace, '.git', 'MERGE_HEAD'), `${'a'.repeat(40)}\n`);

    const repositories = await import('../../src/repositories/discoverRepositories').then((module) =>
      module.discoverRepositories([workspace], new GitRunner(), { scanDepth: 0 }),
    );

    expect(repositories[0]).toMatchObject({ operationState: 'merge' });
  });

  it('loads the configured Git identity for current-user UI ordering', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'git-log-workbench-user-identity-'));
    temporaryDirectories.push(workspace);
    await initializeRepository(workspace);
    await execFileAsync('git', ['config', 'user.name', 'Current User'], { cwd: workspace });
    await execFileAsync('git', ['config', 'user.email', 'current@example.com'], { cwd: workspace });

    const repositories = await import('../../src/repositories/discoverRepositories').then((module) =>
      module.discoverRepositories([workspace], new GitRunner(), { scanDepth: 0 }),
    );

    expect(repositories[0]).toMatchObject({
      userName: 'Current User',
      userEmail: 'current@example.com',
    });
  });

  it('discovers a linked worktree and records its shared common Git directory', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'git-log-workbench-worktree-'));
    temporaryDirectories.push(workspace);
    const main = join(workspace, 'main');
    const linked = join(workspace, 'linked');
    await initializeRepository(main);
    await execFileAsync('git', ['commit', '--allow-empty', '-m', 'base'], {
      cwd: main,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Alice',
        GIT_AUTHOR_EMAIL: 'alice@example.com',
        GIT_COMMITTER_NAME: 'Alice',
        GIT_COMMITTER_EMAIL: 'alice@example.com',
      },
    });
    await execFileAsync('git', ['worktree', 'add', '-b', 'linked', linked], { cwd: main });

    const repositories = await import('../../src/repositories/discoverRepositories').then((module) =>
      module.discoverRepositories([workspace], new GitRunner(), { scanDepth: 1 }),
    );

    expect(repositories).toHaveLength(2);
    expect(new Set(repositories.map((repository) => repository.rootUri)).size).toBe(2);
    expect(new Set(repositories.map((repository) => repository.gitDirUri)).size).toBe(2);
    const commonGitDirectories = repositories.map((repository) =>
      'commonGitDirUri' in repository ? repository.commonGitDirUri : undefined,
    );
    expect(commonGitDirectories.every((directory) => typeof directory === 'string')).toBe(true);
    expect(new Set(commonGitDirectories).size).toBe(1);
    expect(commonGitDirectories[0]).toContain('/main/.git');
  });
});
