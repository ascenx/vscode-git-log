import type * as vscode from 'vscode';
import { parseRevisionQuery } from './diffModel';
import type { RevisionContentLoader } from './RevisionContentLoader';

export const REVISION_SCHEME = 'git-log-workbench';

export class RevisionContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly loader: RevisionContentLoader) {}

  async provideTextDocumentContent(uri: vscode.Uri, token: vscode.CancellationToken): Promise<string> {
    const query = parseRevisionQuery(uri.query);
    if (!query) throw new Error('Invalid Git Log revision URI.');

    const abortController = new AbortController();
    const cancellation = token.onCancellationRequested(() => abortController.abort());
    try {
      return await this.loader.load(query, abortController.signal);
    } finally {
      cancellation.dispose();
    }
  }
}
