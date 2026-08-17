import type * as vscode from 'vscode';
import type { RepositoryRegistry } from '../repositories/RepositoryRegistry';
import {
  WORKING_SNAPSHOT_SCHEME,
  type WorkingSnapshotContentProvider,
} from './WorkingSnapshotContentProvider';

export function nativeDiffResourceKey(original: vscode.Uri, modified: vscode.Uri): string {
  return JSON.stringify([original.toString(), modified.toString()]);
}

export function releaseNativeDiffResources(
  input: Pick<vscode.TabInputTextDiff, 'original' | 'modified'>,
  repositories: RepositoryRegistry,
  snapshots: WorkingSnapshotContentProvider,
): void {
  repositories.release(nativeDiffResourceKey(input.original, input.modified));
  if (input.modified.scheme === WORKING_SNAPSHOT_SCHEME) {
    snapshots.release(input.modified);
  }
}

export function releaseNativeDiffResourcesIfUnused(
  closedInput: Pick<vscode.TabInputTextDiff, 'original' | 'modified'>,
  openInputs: readonly Pick<vscode.TabInputTextDiff, 'original' | 'modified'>[],
  repositories: RepositoryRegistry,
  snapshots: WorkingSnapshotContentProvider,
): void {
  const closedKey = nativeDiffResourceKey(closedInput.original, closedInput.modified);
  const stillOpen = openInputs.some(
    (input) => nativeDiffResourceKey(input.original, input.modified) === closedKey,
  );
  if (stillOpen) return;
  releaseNativeDiffResources(closedInput, repositories, snapshots);
}
