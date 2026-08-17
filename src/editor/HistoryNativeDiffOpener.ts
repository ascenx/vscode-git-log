import type { DiffManager } from '../diff/DiffManager';
import { nativeDiffResourceKey } from '../diff/NativeDiffResources';
import type { GitService } from '../git/GitService';
import type { RepositoryRegistry } from '../repositories/RepositoryRegistry';
import type { ChangedFile, HistoryEntry, RepositorySummary } from '../shared/models';
import type { HistoryNativeDiffOpener as HistoryNativeDiffOpenerContract } from './HistoryDiffSupport';

function findHistoryFile(
  entry: HistoryEntry,
  files: readonly ChangedFile[],
): ChangedFile | undefined {
  return (
    files.find(
      (candidate) => candidate.path === entry.path && candidate.oldPath === entry.oldPath,
    ) ??
    files.find((candidate) => candidate.path === entry.path) ??
    (entry.oldPath === undefined
      ? undefined
      : files.find((candidate) => candidate.oldPath === entry.oldPath) ??
        files.find((candidate) => candidate.path === entry.oldPath))
  );
}

export class HistoryNativeDiffOpener implements HistoryNativeDiffOpenerContract {
  private abortController: AbortController | undefined;
  private openRequestId = 0;
  private openQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly gitService: GitService,
    private readonly diffManager: DiffManager,
    private readonly repositories: RepositoryRegistry,
  ) {}

  async open(
    repository: RepositorySummary,
    cwd: string,
    entry: HistoryEntry,
    parent?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const selectedParent = parent ?? entry.parents[0];
    if (selectedParent !== undefined && !entry.parents.includes(selectedParent)) {
      throw new Error('The selected revision is not a parent of this history entry.');
    }
    if (signal?.aborted) return;
    const requestId = ++this.openRequestId;
    this.abortController?.abort();
    const abortController = new AbortController();
    this.abortController = abortController;
    const abortFromCaller = () => abortController.abort();
    signal?.addEventListener('abort', abortFromCaller, { once: true });
    try {
      const files = await this.gitService.getChangedFiles(
        cwd,
        entry.hash,
        selectedParent,
        abortController.signal,
      );
      if (abortController.signal.aborted || requestId !== this.openRequestId) return;
      const file = findHistoryFile(entry, files);
      if (!file) throw new Error('The selected commit does not contain this file change.');
      if (file.binary) throw new Error('Binary files cannot be opened in the text diff editor.');
      await this.enqueueOpen(async () => {
        if (abortController.signal.aborted || requestId !== this.openRequestId) return;
        this.repositories.upsert(repository);
        let resourceKey: string | undefined;
        let retainedResource = false;
        try {
          await this.diffManager.open(repository.id, {
            hash: entry.hash,
            ...(selectedParent ? { parent: selectedParent } : {}),
            path: file.path,
            ...(file.oldPath ? { oldPath: file.oldPath } : {}),
            status: file.status,
            onWillOpen: (originalUri, modifiedUri) => {
              resourceKey = nativeDiffResourceKey(originalUri, modifiedUri);
              retainedResource = this.repositories.retain(repository, resourceKey);
            },
          });
        } catch (error) {
          if (retainedResource && resourceKey) this.repositories.release(resourceKey);
          throw error;
        }
      });
    } catch (error) {
      if (abortController.signal.aborted || requestId !== this.openRequestId) return;
      throw error;
    } finally {
      signal?.removeEventListener('abort', abortFromCaller);
      if (this.abortController === abortController) this.abortController = undefined;
    }
  }

  dispose(): void {
    this.openRequestId += 1;
    this.abortController?.abort();
    this.abortController = undefined;
  }

  private enqueueOpen(operation: () => Promise<void>): Promise<void> {
    const queued = this.openQueue.then(operation, operation);
    this.openQueue = queued.catch(() => undefined);
    return queued;
  }
}
