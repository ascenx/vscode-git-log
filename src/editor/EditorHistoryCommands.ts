import type { RepositoryRegistry } from '../repositories/RepositoryRegistry';
import type { EditorHistoryRequest } from '../shared/models';
import type { EditorGitContextService } from './EditorGitContextService';

export interface EditorSelectionSnapshot {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

export interface EditorHistoryCommandHost {
  getActiveEditor():
    | {
        fsPath: string;
        selection?: EditorSelectionSnapshot;
        workingContent?: string;
      }
    | undefined;
  openHistory(request: EditorHistoryRequest): Promise<void>;
  openFileHistory(request: EditorHistoryRequest & { kind: 'file' }): Promise<void>;
  openLineHistory(request: EditorHistoryRequest & { kind: 'line' }): Promise<void>;
  showErrorMessage(message: string): void;
}

export class EditorHistoryCommands {
  constructor(
    private readonly contexts: EditorGitContextService,
    private readonly repositories: RepositoryRegistry,
    private readonly host: EditorHistoryCommandHost,
  ) {}

  async showFileHistory(): Promise<void> {
    await this.openHistory('file', false, true);
  }

  async showLineHistory(): Promise<void> {
    await this.openHistory('line', false, true);
  }

  async showSelectionHistory(): Promise<void> {
    await this.openHistory('line', true, true);
  }

  private async openHistory(
    kind: 'file' | 'line',
    useSelection = false,
    openInEditor = false,
  ): Promise<void> {
    const editor = this.host.getActiveEditor();
    if (!editor) {
      this.host.showErrorMessage('Open a local file before viewing its Git history.');
      return;
    }
    try {
      const context = await this.contexts.resolve(editor.fsPath);
      this.repositories.upsert(context.repository);
      const request: EditorHistoryRequest = {
        kind,
        repository: context.repository,
        path: context.repositoryPath,
      };
      if (kind === 'line') {
        request.lineScope = useSelection ? 'selection' : 'current';
        const selection = editor.selection;
        if (!selection) throw new Error('The active editor selection is unavailable.');
        const startLine = selection.startLine + 1;
        const endLine = useSelection
          ? selection.endCharacter === 0 && selection.endLine > selection.startLine
            ? selection.endLine
            : selection.endLine + 1
          : startLine;
        request.startLine = startLine;
        request.endLine = Math.max(startLine, endLine);
        if (editor.workingContent !== undefined) {
          request.workingContent = editor.workingContent;
        }
      }
      if (openInEditor) {
        if (kind === 'file') {
          await this.host.openFileHistory({ ...request, kind: 'file' });
        } else {
          await this.host.openLineHistory({ ...request, kind: 'line' });
        }
      } else {
        await this.host.openHistory(request);
      }
    } catch (error) {
      this.host.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }
}
