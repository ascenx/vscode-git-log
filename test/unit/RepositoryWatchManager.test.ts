import { afterEach, describe, expect, it, vi } from 'vitest';
import { RepositoryWatchManager } from '../../src/repositories/RepositoryWatchManager';
import type { RepositorySummary } from '../../src/shared/models';

afterEach(() => vi.useRealTimers());

function createWatchFixture() {
  vi.useFakeTimers();
  const registrations: Array<{
    basePath: string;
    pattern: string;
    fire(): void;
    dispose: ReturnType<typeof vi.fn>;
  }> = [];
  const changed = vi.fn();
  const manager = new RepositoryWatchManager(
    (basePath, pattern, fire) => {
      const dispose = vi.fn();
      registrations.push({ basePath, pattern, fire, dispose });
      return { dispose };
    },
    changed,
    100,
  );
  const repository: RepositorySummary = {
    id: 'main',
    rootUri: 'file:///project',
    gitDirUri: 'file:///project/.git',
    displayName: 'project',
    isBare: false,
  };
  return { manager, registrations, changed, repository };
}

describe('RepositoryWatchManager', () => {
  it('reuses unchanged watchers and preserves pending change notifications', async () => {
    const { manager, registrations, changed, repository } = createWatchFixture();
    manager.replace([repository]);
    const count = registrations.length;
    registrations[0]!.fire();
    manager.replace([{ ...repository, head: 'a'.repeat(40), currentBranch: 'feature' }]);
    expect(registrations).toHaveLength(count);
    expect(registrations.every(({ dispose }) => dispose.mock.calls.length === 0)).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(changed).toHaveBeenCalledExactlyOnceWith('main');
    manager.dispose();
  });

  it('updates recipients of shared watchers when a linked worktree is removed', async () => {
    const { manager, registrations, changed, repository } = createWatchFixture();
    const linked: RepositorySummary = {
      ...repository,
      id: 'linked',
      rootUri: 'file:///linked',
      gitDirUri: 'file:///project/.git/worktrees/linked',
      commonGitDirUri: repository.gitDirUri,
    };
    manager.replace([repository, linked]);
    const count = registrations.length;
    const shared = registrations.find(
      ({ basePath, pattern }) => basePath === '/project/.git' && pattern === 'refs/**',
    )!;
    shared.fire();
    manager.replace([linked]);
    expect(registrations).toHaveLength(count);
    expect(shared.dispose).not.toHaveBeenCalled();
    shared.fire();
    await vi.advanceTimersByTimeAsync(100);
    expect(changed.mock.calls).toEqual([['linked']]);
    manager.dispose();
  });

  it('cancels pending events for removed repositories', async () => {
    const { manager, registrations, changed, repository } = createWatchFixture();
    manager.replace([repository]);
    registrations[0]!.fire();
    manager.replace([]);
    await vi.advanceTimersByTimeAsync(100);
    expect(changed).not.toHaveBeenCalled();
    expect(registrations.every(({ dispose }) => dispose.mock.calls.length === 1)).toBe(true);
    manager.dispose();
  });

  it('watches Git metadata, debounces bursts, and disposes obsolete watchers', async () => {
    vi.useFakeTimers();
    const modulePath = '../../src/repositories/RepositoryWatchManager';
    const watchModule = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(watchModule, 'RepositoryWatchManager must exist').toBeDefined();
    if (!watchModule) return;

    const registrations: Array<{
      basePath: string;
      pattern: string;
      fire(): void;
      dispose: ReturnType<typeof vi.fn>;
    }> = [];
    const onRepositoryChanged = vi.fn();
    const repository: RepositorySummary = {
      id: 'repo-1',
      rootUri: 'file:///workspace/project',
      gitDirUri: 'file:///workspace/project/.git/worktrees/linked',
      commonGitDirUri: 'file:///workspace/project/.git',
      displayName: 'project',
      isBare: false,
    };
    const manager = new watchModule.RepositoryWatchManager(
      (basePath: string, pattern: string, fire: () => void) => {
        const dispose = vi.fn();
        registrations.push({ basePath, pattern, fire, dispose });
        return { dispose };
      },
      onRepositoryChanged,
      100,
    );

    manager.replace([repository]);

    expect(registrations.map(({ pattern }) => pattern)).toEqual(
      expect.arrayContaining(['HEAD', 'index', 'refs/**', 'packed-refs', 'logs/**']),
    );
    expect(registrations.some(({ basePath }) => basePath.endsWith('/.git'))).toBe(true);
    expect(registrations.some(({ basePath }) => basePath.includes('/worktrees/linked'))).toBe(true);

    registrations[0]?.fire();
    registrations[1]?.fire();
    await vi.advanceTimersByTimeAsync(99);
    expect(onRepositoryChanged).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onRepositoryChanged).toHaveBeenCalledOnce();
    expect(onRepositoryChanged).toHaveBeenCalledWith('repo-1');

    manager.replace([]);
    expect(registrations.every(({ dispose }) => dispose.mock.calls.length === 1)).toBe(true);
    manager.dispose();
    vi.useRealTimers();
  });
});
