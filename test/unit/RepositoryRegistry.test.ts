import { describe, expect, it } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';

describe('RepositoryRegistry', () => {
  it('only resolves repository ids supplied by discovery', async () => {
    const modulePath = '../../src/repositories/RepositoryRegistry';
    const registryModule = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(registryModule, 'the repository registry must exist').toBeDefined();
    if (!registryModule) return;

    const registry = new registryModule.RepositoryRegistry();
    registry.replace([
      {
        id: 'repo-1',
        rootUri: pathToFileURL('/workspace/project').toString(),
        gitDirUri: pathToFileURL('/workspace/project/.git').toString(),
        displayName: 'project',
        isBare: false,
      },
    ]);

    expect(registry.getRoot('repo-1')).toBe(fileURLToPath(pathToFileURL('/workspace/project')));
    expect(registry.getRoot('../../outside')).toBeUndefined();
    registry.upsert({
      id: 'repo-2',
      rootUri: pathToFileURL('/workspace/nested').toString(),
      gitDirUri: pathToFileURL('/workspace/nested/.git').toString(),
      displayName: 'nested',
      isBare: false,
    });
    expect(registry.getRoot('repo-2')).toBe(fileURLToPath(pathToFileURL('/workspace/nested')));
    registry.replace([]);
    expect(registry.getRoot('repo-1')).toBeUndefined();
  });

  it('retains repositories while native diff resources still reference them', async () => {
    const { RepositoryRegistry } = await import('../../src/repositories/RepositoryRegistry');
    const registry = new RepositoryRegistry();
    const repository = {
      id: 'repo-1',
      rootUri: pathToFileURL('/workspace/project').toString(),
      gitDirUri: pathToFileURL('/workspace/project/.git').toString(),
      displayName: 'project',
      isBare: false,
    };

    registry.retain(repository, 'diff-1');
    registry.retain(repository, 'diff-2');
    registry.replace([]);
    expect(registry.getRoot('repo-1')).toBe('/workspace/project');

    registry.release('diff-1');
    expect(registry.getRoot('repo-1')).toBe('/workspace/project');
    registry.release('diff-2');
    expect(registry.getRoot('repo-1')).toBeUndefined();
  });
});
