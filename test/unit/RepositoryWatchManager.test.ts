import { describe, expect, it, vi } from 'vitest';
import type { RepositorySummary } from '../../src/shared/models';

describe('RepositoryWatchManager', () => {
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
