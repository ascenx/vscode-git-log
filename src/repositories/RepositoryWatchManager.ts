import { fileURLToPath } from 'node:url';
import type { RepositorySummary } from '../shared/models';

export interface WatchDisposable {
  dispose(): void;
}

export type RepositoryWatchFactory = (
  basePath: string,
  pattern: string,
  onChange: () => void,
) => WatchDisposable;

const WORKTREE_PATTERNS = ['HEAD', 'index', 'logs/**'] as const;
const COMMON_PATTERNS = ['refs/**', 'packed-refs', 'logs/**'] as const;

interface WatchedTarget {
  repositoryIds: Set<string>;
  disposable: WatchDisposable;
}

export class RepositoryWatchManager implements WatchDisposable {
  private watchers = new Map<string, WatchedTarget>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly watch: RepositoryWatchFactory,
    private readonly onRepositoryChanged: (repositoryId: string) => void,
    private readonly debounceMs = 150,
  ) {}

  replace(repositories: readonly RepositorySummary[]): void {
    const targets = new Map<string, { basePath: string; pattern: string; repositoryIds: Set<string> }>();

    for (const repository of repositories) {
      const gitDir = fileURLToPath(repository.gitDirUri);
      const commonGitDir = fileURLToPath(repository.commonGitDirUri ?? repository.gitDirUri);
      for (const [basePath, patterns] of [
        [gitDir, WORKTREE_PATTERNS],
        [commonGitDir, COMMON_PATTERNS],
      ] as const) {
        for (const pattern of patterns) {
          const key = `${basePath}\0${pattern}`;
          const target = targets.get(key) ?? {
            basePath,
            pattern,
            repositoryIds: new Set<string>(),
          };
          target.repositoryIds.add(repository.id);
          targets.set(key, target);
        }
      }
    }

    for (const [key, watched] of this.watchers) {
      if (targets.has(key)) continue;
      watched.repositoryIds.clear();
      watched.disposable.dispose();
      this.watchers.delete(key);
    }
    for (const [key, target] of targets) {
      const existing = this.watchers.get(key);
      if (existing) {
        existing.repositoryIds = target.repositoryIds;
        continue;
      }
      const watched: WatchedTarget = {
        repositoryIds: target.repositoryIds,
        disposable: this.watch(target.basePath, target.pattern, () => {
          for (const repositoryId of watched.repositoryIds) this.schedule(repositoryId);
        }),
      };
      this.watchers.set(key, watched);
    }
    const repositoryIds = new Set(repositories.map((repository) => repository.id));
    for (const [repositoryId, timer] of this.timers) {
      if (repositoryIds.has(repositoryId)) continue;
      clearTimeout(timer);
      this.timers.delete(repositoryId);
    }
  }

  dispose(): void {
    this.disposeWatchers();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private schedule(repositoryId: string): void {
    const existing = this.timers.get(repositoryId);
    if (existing) clearTimeout(existing);
    this.timers.set(
      repositoryId,
      setTimeout(() => {
        this.timers.delete(repositoryId);
        this.onRepositoryChanged(repositoryId);
      }, this.debounceMs),
    );
  }

  private disposeWatchers(): void {
    for (const watched of this.watchers.values()) {
      watched.repositoryIds.clear();
      watched.disposable.dispose();
    }
    this.watchers.clear();
  }
}
