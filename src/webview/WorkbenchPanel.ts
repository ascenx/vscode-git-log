import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { GitRunner } from '../git/GitRunner';
import type { GitService } from '../git/GitService';
import type { FileHistoryService } from '../git/FileHistoryService';
import type { GitOperationService } from '../git/GitOperationService';
import type { DiffManager } from '../diff/DiffManager';
import {
  parseWebviewMessage,
  type PersistedWorkbenchState,
  type WorkbenchLayout,
} from '../protocol/messages';
import type { RepositoryRegistry } from '../repositories/RepositoryRegistry';
import { RepositoryWatchManager } from '../repositories/RepositoryWatchManager';
import type { EditorHistoryRequest, FolderHistoryRequest } from '../shared/models';
import { createWebviewHtml } from './createWebviewHtml';
import { WorkbenchController } from './WorkbenchController';

const DEFAULT_LAYOUT: WorkbenchLayout = {
  refsWidth: 220,
  filesWidth: 320,
  detailsHeight: 156,
  detailsPlacement: 'bottom',
  filesViewMode: 'tree',
  refsColumnWidth: 150,
  authorColumnWidth: 130,
  dateColumnWidth: 125,
};

interface WorkbenchViewSession {
  controller: WorkbenchController;
  watchManager: RepositoryWatchManager;
  disposables: vscode.Disposable[];
  ready: boolean;
}

export class WorkbenchViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private session: WorkbenchViewSession | undefined;
  private pendingHistoryRequest:
    | { kind: 'editor'; request: EditorHistoryRequest }
    | { kind: 'folder'; request: FolderHistoryRequest }
    | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly runner: GitRunner,
    private readonly gitService: GitService,
    private readonly fileHistoryService: FileHistoryService,
    private readonly operationService: GitOperationService,
    private readonly repositories: RepositoryRegistry,
    private readonly diffManager: DiffManager,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.disposeSession();
    const extensionUri = this.context.extensionUri;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')],
    };
    const scriptUri = view.webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'),
    );
    const styleUri = view.webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, 'dist', 'webview.css'),
    );

    view.webview.html = createWebviewHtml({
      cspSource: view.webview.cspSource,
      scriptUri: scriptUri.toString(),
      styleUri: styleUri.toString(),
      nonce: randomBytes(18).toString('base64url'),
    });

    const configuration = vscode.workspace.getConfiguration('gitLogWorkbench');
    const storedLayout = this.context.workspaceState.get<WorkbenchLayout>(
      'workbench.layout',
      DEFAULT_LAYOUT,
    );
    const storedState = this.context.workspaceState.get<PersistedWorkbenchState>('workbench.state');
    const controllerRef: { current?: WorkbenchController } = {};
    const watchManager = new RepositoryWatchManager(
      (basePath, pattern, onChange) => {
        const watcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(basePath, pattern),
        );
        return vscode.Disposable.from(
          watcher.onDidCreate(onChange),
          watcher.onDidChange(onChange),
          watcher.onDidDelete(onChange),
          watcher,
        );
      },
      (repositoryId) =>
        this.runSafely('repository refresh failed', () =>
          controllerRef.current?.notifyRepositoryChanged(repositoryId),
        ),
    );
    const controller = new WorkbenchController({
      workspaceRoots: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
      gitRunner: this.runner,
      gitService: this.gitService,
      fileHistoryService: this.fileHistoryService,
      operationService: this.operationService,
      confirmOperation: async (confirmation) => {
        const selected = await vscode.window.showWarningMessage(
          confirmation.title,
          { modal: true, detail: confirmation.detail },
          confirmation.confirmLabel,
        );
        return selected === confirmation.confirmLabel;
      },
      withProgress: (title, task) =>
        Promise.resolve(
          vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title, cancellable: false },
            task,
          ),
        ),
      scanDepth: configuration.get<number>('repositories.scanDepth', 2),
      repositoryExcludes: configuration.get<string[]>('repositories.exclude', [
        '**/node_modules/**',
        '**/.worktrees/**',
      ]),
      initialPageSize: configuration.get<number>('log.initialPageSize', 200),
      pageSize: configuration.get<number>('log.pageSize', 500),
      maxCachedCommits: configuration.get<number>('performance.maxCachedCommits', 5000),
      initialLayout: storedLayout,
      ...(storedState ? { initialState: storedState } : {}),
      postMessage: (message) => Promise.resolve(view.webview.postMessage(message)),
      persistLayout: (layout) =>
        Promise.resolve(this.context.workspaceState.update('workbench.layout', layout)),
      persistState: (state) =>
        Promise.resolve(this.context.workspaceState.update('workbench.state', state)),
      showOutput: () => this.output.show(true),
      copyToClipboard: (text) => Promise.resolve(vscode.env.clipboard.writeText(text)),
      onRepositoriesChanged: (discovered) => {
        this.repositories.replace(discovered);
        watchManager.replace(discovered);
      },
      openDiff: (repository, request) => this.diffManager.open(repository.id, request),
      openFile: (repository, request) =>
        this.diffManager.openFile(repository.id, vscode.Uri.parse(repository.rootUri), request),
      openCommitComparison: (repository, request, files) =>
        this.diffManager.openCommit(repository.id, request, files),
    });
    controllerRef.current = controller;

    const session: WorkbenchViewSession = { controller, watchManager, disposables: [], ready: false };
    session.disposables.push(
      view.webview.onDidReceiveMessage((rawMessage: unknown) => {
        const message = parseWebviewMessage(rawMessage);
        if (!message) {
          this.output.appendLine('[protocol] Ignored an invalid webview message.');
          return;
        }
        this.runSafely('webview message handling failed', async () => {
          await controller.handleMessage(message);
          if (message.type === 'ready' && this.session === session) {
            session.ready = true;
            await this.flushPendingHistory();
          }
        });
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.runSafely('workspace refresh failed', () =>
          controller.updateWorkspaceRoots(
            (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
          ),
        );
      }),
      view.onDidDispose(() => {
        if (this.session === session) this.disposeSession();
      }),
    );
    this.session = session;
  }

  async openEditorHistory(request: EditorHistoryRequest): Promise<void> {
    this.pendingHistoryRequest = { kind: 'editor', request };
    await vscode.commands.executeCommand('gitLogWorkbench.log.focus');
    await this.flushPendingHistory();
  }

  async openFolderHistory(request: FolderHistoryRequest): Promise<void> {
    this.pendingHistoryRequest = { kind: 'folder', request };
    await vscode.commands.executeCommand('gitLogWorkbench.log.focus');
    await this.flushPendingHistory();
  }

  dispose(): void {
    this.disposeSession();
  }

  private disposeSession(): void {
    const session = this.session;
    if (!session) return;
    this.session = undefined;
    session.controller.dispose();
    session.watchManager.dispose();
    for (const disposable of session.disposables.splice(0)) disposable.dispose();
  }

  private async flushPendingHistory(): Promise<void> {
    const session = this.session;
    const request = this.pendingHistoryRequest;
    if (!session?.ready || !request) return;
    this.pendingHistoryRequest = undefined;
    if (request.kind === 'editor') {
      await session.controller.openEditorHistory(request.request);
    } else {
      await session.controller.openFolderHistory(request.request);
    }
  }

  private runSafely(label: string, task: () => void | Promise<void>): void {
    void Promise.resolve()
      .then(task)
      .catch((error: unknown) => {
        this.output.appendLine(
          `[workbench] ${label}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }
}
