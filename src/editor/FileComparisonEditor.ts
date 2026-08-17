import { join } from 'node:path';
import * as vscode from 'vscode';
import type { DiffManager } from '../diff/DiffManager';
import { nativeDiffResourceKey } from '../diff/NativeDiffResources';
import type { WorkingSnapshotContentProvider } from '../diff/WorkingSnapshotContentProvider';
import type { GitService } from '../git/GitService';
import type { RepositoryRegistry } from '../repositories/RepositoryRegistry';
import type { FileComparisonOpener, FileComparisonRequest } from './EditorFileComparisonCommand';

export class FileComparisonEditor implements vscode.Disposable, FileComparisonOpener {
  private abortController: AbortController | undefined;
  private openRequestId = 0;
  private openQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly gitService: GitService,
    private readonly diffManager: DiffManager,
    private readonly snapshots: WorkingSnapshotContentProvider,
    private readonly repositories: RepositoryRegistry,
  ) {}

  async open(request: FileComparisonRequest): Promise<void> {
    const requestId = ++this.openRequestId;
    this.abortController?.abort();
    const abortController = new AbortController();
    this.abortController = abortController;
    this.repositories.upsert(request.repository);
    try {
      const revisionExists = await this.gitService.hasFileAtRevision(
        request.cwd,
        request.revision,
        request.path,
        abortController.signal,
      );
      if (requestId !== this.openRequestId) return;
      await this.enqueueOpen(async () => {
        if (requestId !== this.openRequestId) return;
        this.repositories.upsert(request.repository);
        const isSnapshot = request.workingContent !== undefined;
        const workingFileUri = isSnapshot
          ? this.snapshots.create(request.path, request.workingContent as string)
          : vscode.Uri.file(join(request.cwd, request.path));
        let resourceKey: string | undefined;
        let retainedResource = false;
        try {
          await this.diffManager.openWorkingFileAgainstRevision(request.repository.id, {
            revision: request.revision,
            revisionLabel: request.revisionLabel,
            path: request.path,
            workingFileUri,
            revisionExists,
            forceInline: true,
            isCurrent: () => requestId === this.openRequestId,
            onWillOpen: (originalUri) => {
              resourceKey = nativeDiffResourceKey(originalUri, workingFileUri);
              retainedResource = this.repositories.retain(request.repository, resourceKey);
            },
          });
        } catch (error) {
          if (retainedResource && resourceKey) this.repositories.release(resourceKey);
          if (isSnapshot) this.snapshots.release(workingFileUri);
          throw error;
        }
      });
    } catch (error) {
      if (abortController.signal.aborted || requestId !== this.openRequestId) return;
      throw error;
    } finally {
      if (this.abortController === abortController) this.abortController = undefined;
    }
  }

  private enqueueOpen(operation: () => Promise<void>): Promise<void> {
    const queued = this.openQueue.then(operation, operation);
    this.openQueue = queued.catch(() => undefined);
    return queued;
  }

  dispose(): void {
    this.openRequestId += 1;
    this.abortController?.abort();
    this.abortController = undefined;
  }
}
