import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';

export const WORKING_SNAPSHOT_SCHEME = 'git-log-workbench-working';

const DEFAULT_MAXIMUM_FILE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAXIMUM_TOTAL_BYTES = DEFAULT_MAXIMUM_FILE_BYTES * 8;

interface WorkingSnapshot {
  content: string;
  bytes: number;
}

export class WorkingSnapshotContentProvider
implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly snapshots = new Map<string, WorkingSnapshot>();
  private totalBytes = 0;

  constructor(
    private readonly maximumFileBytes = DEFAULT_MAXIMUM_FILE_BYTES,
    private readonly maximumTotalBytes = DEFAULT_MAXIMUM_TOTAL_BYTES,
  ) {}

  create(path: string, content: string): vscode.Uri {
    if (!path || path.includes('\0')) throw new Error('Invalid working-file snapshot path.');
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > this.maximumFileBytes) {
      throw new Error('The working-file snapshot is too large to compare.');
    }
    if (this.totalBytes + bytes > this.maximumTotalBytes) {
      throw new Error('The working-file snapshot memory limit has been reached.');
    }
    const id = randomUUID();
    this.snapshots.set(id, { content, bytes });
    this.totalBytes += bytes;
    return vscode.Uri.from({
      scheme: WORKING_SNAPSHOT_SCHEME,
      path: `/${path.replace(/^\/+/, '')}`,
      query: new URLSearchParams({ id }).toString(),
    });
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const id = new URLSearchParams(uri.query).get('id');
    const snapshot = id ? this.snapshots.get(id) : undefined;
    if (!snapshot) throw new Error('Unknown working-file snapshot.');
    return snapshot.content;
  }

  release(uri: vscode.Uri): void {
    const id = new URLSearchParams(uri.query).get('id');
    if (!id) return;
    const snapshot = this.snapshots.get(id);
    if (!snapshot) return;
    this.snapshots.delete(id);
    this.totalBytes -= snapshot.bytes;
  }

  dispose(): void {
    this.snapshots.clear();
    this.totalBytes = 0;
  }
}
