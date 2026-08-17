import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { GitRunner } from '../../src/git/GitRunner';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe('EditorGitContextService', () => {
  it('resolves the nearest repository and a normalized Git path without prior discovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'git-log-editor-context-'));
    temporaryDirectories.push(root);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
    await mkdir(join(root, 'src', 'nested'), { recursive: true });
    const file = join(root, 'src', 'nested', 'hello 中文.ts');
    await writeFile(file, 'export const value = 1;\n');

    const modulePath = '../../src/editor/EditorGitContextService';
    const serviceModule = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(serviceModule, 'EditorGitContextService must exist').toBeDefined();
    if (!serviceModule) return;

    const context = await new serviceModule.EditorGitContextService(new GitRunner()).resolve(file);

    expect(context.repositoryRoot).toBe(await realpath(root));
    expect(context.repository.isBare).toBe(false);
    expect(context.repositoryPath).toBe('src/nested/hello 中文.ts');
    expect(context.absolutePath).toBe(file);
  });

  it('rejects a file outside a Git working tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'git-log-editor-outside-'));
    temporaryDirectories.push(root);
    const file = join(root, 'outside.ts');
    await writeFile(file, 'outside\n');
    const { EditorGitContextService } = await import('../../src/editor/EditorGitContextService');

    await expect(new EditorGitContextService(new GitRunner()).resolve(file)).rejects.toThrow(
      'not inside a Git working tree',
    );
  });

  it('selects the nearest nested repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'git-log-editor-nested-'));
    temporaryDirectories.push(root);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
    const nested = join(root, 'packages', 'nested');
    await mkdir(nested, { recursive: true });
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: nested });
    const file = join(nested, 'src', 'app.ts');
    await mkdir(join(nested, 'src'), { recursive: true });
    await writeFile(file, 'nested\n');
    const { EditorGitContextService } = await import('../../src/editor/EditorGitContextService');

    const context = await new EditorGitContextService(new GitRunner()).resolve(file);

    expect(context.repositoryRoot).toBe(await realpath(nested));
    expect(context.repositoryPath).toBe('src/app.ts');
  });

  it('resolves files inside a linked worktree and records the common Git directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'git-log-editor-worktree-'));
    temporaryDirectories.push(root);
    const main = join(root, 'main');
    const linked = join(root, 'linked');
    await mkdir(main, { recursive: true });
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: main });
    await execFileAsync('git', ['config', 'user.name', 'Alice'], { cwd: main });
    await execFileAsync('git', ['config', 'user.email', 'alice@example.com'], { cwd: main });
    await writeFile(join(main, 'app.ts'), 'main\n');
    await execFileAsync('git', ['add', 'app.ts'], { cwd: main });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: main });
    await execFileAsync('git', ['branch', 'feature'], { cwd: main });
    await execFileAsync('git', ['worktree', 'add', linked, 'feature'], { cwd: main });
    const { EditorGitContextService } = await import('../../src/editor/EditorGitContextService');

    const context = await new EditorGitContextService(new GitRunner()).resolve(join(linked, 'app.ts'));

    expect(context.repositoryRoot).toBe(await realpath(linked));
    expect(context.repository.commonGitDirUri).toBeDefined();
    expect(context.repositoryPath).toBe('app.ts');
  });

  it('resolves a deleted tracked file that is still open in the editor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'git-log-editor-deleted-file-'));
    temporaryDirectories.push(root);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
    await mkdir(join(root, 'src'), { recursive: true });
    const file = join(root, 'src', 'deleted.ts');
    await writeFile(file, 'export const deleted = true;\n');
    await execFileAsync('git', ['add', 'src/deleted.ts'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'add deleted file'], {
      cwd: root,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Alice',
        GIT_AUTHOR_EMAIL: 'alice@example.com',
        GIT_COMMITTER_NAME: 'Alice',
        GIT_COMMITTER_EMAIL: 'alice@example.com',
      },
    });
    await rm(file);
    const { EditorGitContextService } = await import('../../src/editor/EditorGitContextService');

    const context = await new EditorGitContextService(new GitRunner()).resolve(file);

    expect(context.repositoryRoot).toBe(await realpath(root));
    expect(context.repositoryPath).toBe('src/deleted.ts');
    expect(context.absolutePath).toBe(file);
  });
});
