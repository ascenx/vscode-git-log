import { fileURLToPath } from 'node:url';
import type { RepositorySummary } from '../shared/models';

export class RepositoryRegistry {
  private roots = new Map<string, string>();
  private discoveredIds = new Set<string>();
  private readonly retained = new Map<string, { repositoryId: string; root: string }>();

  replace(repositories: readonly RepositorySummary[]): void {
    this.roots = new Map(
      repositories.map((repository) => [repository.id, fileURLToPath(repository.rootUri)]),
    );
    this.discoveredIds = new Set(repositories.map((repository) => repository.id));
    for (const retained of this.retained.values()) {
      this.roots.set(retained.repositoryId, retained.root);
    }
  }

  upsert(repository: RepositorySummary): void {
    this.roots.set(repository.id, fileURLToPath(repository.rootUri));
  }

  retain(repository: RepositorySummary, resourceKey: string): boolean {
    const root = fileURLToPath(repository.rootUri);
    const isNew = !this.retained.has(resourceKey);
    this.retained.set(resourceKey, { repositoryId: repository.id, root });
    this.roots.set(repository.id, root);
    return isNew;
  }

  release(resourceKey: string): void {
    const released = this.retained.get(resourceKey);
    if (!released) return;
    this.retained.delete(resourceKey);
    if (this.discoveredIds.has(released.repositoryId)) return;
    const stillRetained = [...this.retained.values()].some(
      (entry) => entry.repositoryId === released.repositoryId,
    );
    if (!stillRetained) this.roots.delete(released.repositoryId);
  }

  getRoot(repositoryId: string): string | undefined {
    return this.roots.get(repositoryId);
  }
}
