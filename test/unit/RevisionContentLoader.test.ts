import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitRunner } from '../../src/git/GitRunner';
import { GitService } from '../../src/git/GitService';
import { RepositoryRegistry } from '../../src/repositories/RepositoryRegistry';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('RevisionContentLoader', () => {
  it('loads validated text revisions and rejects binary or unknown repositories', async () => {
    const modulePath = '../../src/diff/RevisionContentLoader';
    const loaderModule = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(loaderModule, 'the revision content loader must exist').toBeDefined();
    if (!loaderModule) return;

    const repository = await mkdtemp(join(tmpdir(), 'git-log-workbench-content-'));
    temporaryDirectories.push(repository);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repository });
    await writeFile(join(repository, 'hello 中文.txt'), 'hello revision\n');
    await writeFile(join(repository, 'binary.bin'), Buffer.from([0, 1, 2, 0, 255]));
    await execFileAsync('git', ['add', '.'], { cwd: repository });
    await execFileAsync('git', ['commit', '-m', 'content'], {
      cwd: repository,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Alice',
        GIT_AUTHOR_EMAIL: 'alice@example.com',
        GIT_COMMITTER_NAME: 'Alice',
        GIT_COMMITTER_EMAIL: 'alice@example.com',
      },
    });
    const revision = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim();
    const registry = new RepositoryRegistry();
    registry.replace([
      {
        id: 'repo-1',
        rootUri: pathToFileURL(repository).toString(),
        gitDirUri: pathToFileURL(join(repository, '.git')).toString(),
        displayName: 'fixture',
        isBare: false,
      },
    ]);
    const loader = new loaderModule.RevisionContentLoader(
      registry,
      new GitService(new GitRunner()),
      1024,
    );

    await expect(
      loader.load({
        repositoryId: 'repo-1',
        revision,
        path: 'hello 中文.txt',
        empty: false,
      }),
    ).resolves.toBe('hello revision\n');
    await expect(
      loader.load({ repositoryId: 'repo-1', revision: '', path: 'new.txt', empty: true }),
    ).resolves.toBe('');
    await expect(
      loader.load({ repositoryId: 'missing', revision, path: 'hello 中文.txt', empty: false }),
    ).rejects.toThrow('Unknown repository');
    await expect(
      loader.load({ repositoryId: 'repo-1', revision, path: 'binary.bin', empty: false }),
    ).rejects.toThrow('Binary file');
  });

  it('checks blob size before loading content into extension-host memory', async () => {
    const { RevisionContentLoader } = await import('../../src/diff/RevisionContentLoader');
    const registry = new RepositoryRegistry();
    registry.replace([
      {
        id: 'repo-1',
        rootUri: 'file:///workspace/project',
        gitDirUri: 'file:///workspace/project/.git',
        displayName: 'project',
        isBare: false,
      },
    ]);
    const getFileContent = vi.fn().mockResolvedValue(Buffer.alloc(0));
    const gitService = {
      getFileSize: vi.fn().mockResolvedValue(4096),
      getFileContent,
    } as unknown as GitService;
    const loader = new RevisionContentLoader(registry, gitService, 1024);

    await expect(
      loader.load({
        repositoryId: 'repo-1',
        revision: 'a'.repeat(40),
        path: 'large.txt',
        empty: false,
      }),
    ).rejects.toThrow('4096 bytes');
    expect(getFileContent).not.toHaveBeenCalled();
  });
});
