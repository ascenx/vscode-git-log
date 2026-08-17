import { describe, expect, it, vi } from 'vitest';
import type { WorkingSnapshotContentProvider } from '../../src/diff/WorkingSnapshotContentProvider';
import type { RepositoryRegistry } from '../../src/repositories/RepositoryRegistry';

vi.mock('vscode', () => ({}));

describe('native diff resources', () => {
  it('releases the exact repository lease and dirty snapshot owned by a closed diff tab', async () => {
    const modulePath = '../../src/diff/NativeDiffResources';
    const resources = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(resources, 'NativeDiffResources must exist').toBeDefined();
    if (!resources) return;
    const original = { toString: () => 'git-log-workbench:/app.ts?repositoryId=repo-1' };
    const modified = {
      scheme: 'git-log-workbench-working',
      toString: () => 'git-log-workbench-working:/app.ts?id=snapshot-1',
    };
    const releaseRepository = vi.fn();
    const releaseSnapshot = vi.fn();

    resources.releaseNativeDiffResources(
      { original, modified } as never,
      { release: releaseRepository } as unknown as RepositoryRegistry,
      { release: releaseSnapshot } as unknown as WorkingSnapshotContentProvider,
    );

    expect(releaseRepository).toHaveBeenCalledWith(
      resources.nativeDiffResourceKey(original as never, modified as never),
    );
    expect(releaseSnapshot).toHaveBeenCalledWith(modified);
  });

  it('does not release a normal file modified side as a working snapshot', async () => {
    const resources = await import('../../src/diff/NativeDiffResources');
    const original = { toString: () => 'git-log-workbench:/app.ts?repositoryId=repo-1' };
    const modified = { scheme: 'file', toString: () => 'file:///repo/app.ts' };
    const releaseRepository = vi.fn();
    const releaseSnapshot = vi.fn();

    resources.releaseNativeDiffResources(
      { original, modified } as never,
      { release: releaseRepository } as unknown as RepositoryRegistry,
      { release: releaseSnapshot } as unknown as WorkingSnapshotContentProvider,
    );

    expect(releaseRepository).toHaveBeenCalledOnce();
    expect(releaseSnapshot).not.toHaveBeenCalled();
  });

  it('keeps resources while another split tab has the same diff input', async () => {
    const resources = await import('../../src/diff/NativeDiffResources');
    const input = {
      original: { toString: () => 'git-log-workbench:/app.ts?repositoryId=repo-1' },
      modified: {
        scheme: 'git-log-workbench-working',
        toString: () => 'git-log-workbench-working:/app.ts?id=snapshot-1',
      },
    };
    const releaseRepository = vi.fn();
    const releaseSnapshot = vi.fn();

    resources.releaseNativeDiffResourcesIfUnused(
      input as never,
      [input] as never,
      { release: releaseRepository } as unknown as RepositoryRegistry,
      { release: releaseSnapshot } as unknown as WorkingSnapshotContentProvider,
    );

    expect(releaseRepository).not.toHaveBeenCalled();
    expect(releaseSnapshot).not.toHaveBeenCalled();
  });

  it('releases resources after the last split tab closes', async () => {
    const resources = await import('../../src/diff/NativeDiffResources');
    const input = {
      original: { toString: () => 'git-log-workbench:/app.ts?repositoryId=repo-1' },
      modified: {
        scheme: 'git-log-workbench-working',
        toString: () => 'git-log-workbench-working:/app.ts?id=snapshot-1',
      },
    };
    const releaseRepository = vi.fn();
    const releaseSnapshot = vi.fn();

    resources.releaseNativeDiffResourcesIfUnused(
      input as never,
      [] as never,
      { release: releaseRepository } as unknown as RepositoryRegistry,
      { release: releaseSnapshot } as unknown as WorkingSnapshotContentProvider,
    );

    expect(releaseRepository).toHaveBeenCalledOnce();
    expect(releaseSnapshot).toHaveBeenCalledOnce();
  });
});
