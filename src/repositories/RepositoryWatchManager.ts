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

export class RepositoryWatchManager implements WatchDisposable {
  private watchers: WatchDisposable[] = [];
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly watch: RepositoryWatchFactory,
    private readonly onRepositoryChanged: (repositoryId: string) => void,
    private readonly debounceMs = 150,
  ) {}

  replace(repositories: readonly RepositorySummary[]): void {
    this.disposeWatchers();
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

    this.watchers = [...targets.values()].map((target) =>
      this.watch(target.basePath, target.pattern, () => {
        for (const repositoryId of target.repositoryIds) this.schedule(repositoryId);
      }),
    );
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
    for (const watcher of this.watchers) watcher.dispose();
    this.watchers = [];
  }
}
