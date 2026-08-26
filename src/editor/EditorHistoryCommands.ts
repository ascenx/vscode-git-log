import type { RepositoryRegistry } from '../repositories/RepositoryRegistry';
import type { EditorHistoryRequest, FolderHistoryRequest } from '../shared/models';
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
  openFolderHistory?(request: FolderHistoryRequest): Promise<void>;
  openLineHistory(request: EditorHistoryRequest & { kind: 'line' }): Promise<void>;
  showErrorMessage(message: string): void;
}

export class EditorHistoryCommands {
  constructor(
    private readonly contexts: EditorGitContextService,
    private readonly repositories: RepositoryRegistry,
    private readonly host: EditorHistoryCommandHost,
  ) {}

  async showFileHistory(resourcePath?: string): Promise<void> {
    await this.openHistory('file', false, true, resourcePath);
  }

  async showFolderHistory(resourcePath?: string): Promise<void> {
    if (!resourcePath) {
      this.host.showErrorMessage('Select a local folder before viewing its Git history.');
      return;
    }
    try {
      const context = await this.contexts.resolveDirectory(resourcePath);
      this.repositories.upsert(context.repository);
      if (!this.host.openFolderHistory) {
        throw new Error('Folder history is not available.');
      }
      await this.host.openFolderHistory({
        repository: context.repository,
        path: context.repositoryPath,
      });
    } catch (error) {
      this.host.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
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
    resourcePath?: string,
  ): Promise<void> {
    const editor = this.host.getActiveEditor();
    const filePath = resourcePath ?? editor?.fsPath;
    if (!filePath) {
      this.host.showErrorMessage('Open a local file before viewing its Git history.');
      return;
    }
    try {
      const context = await this.contexts.resolve(filePath);
      this.repositories.upsert(context.repository);
      const request: EditorHistoryRequest = {
        kind,
        repository: context.repository,
        path: context.repositoryPath,
      };
      if (kind === 'line') {
        if (!editor) throw new Error('The active editor selection is unavailable.');
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
