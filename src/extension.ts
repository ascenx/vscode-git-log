import * as vscode from 'vscode';
import { DiffManager } from './diff/DiffManager';
import { releaseNativeDiffResourcesIfUnused } from './diff/NativeDiffResources';
import { RevisionContentLoader } from './diff/RevisionContentLoader';
import { REVISION_SCHEME, RevisionContentProvider } from './diff/RevisionContentProvider';
import {
  WORKING_SNAPSHOT_SCHEME,
  WorkingSnapshotContentProvider,
} from './diff/WorkingSnapshotContentProvider';
import { EditorFileComparisonCommand } from './editor/EditorFileComparisonCommand';
import { FileComparisonEditor } from './editor/FileComparisonEditor';
import { FileHistoryEditor } from './editor/FileHistoryEditor';
import { HistoryNativeDiffOpener } from './editor/HistoryNativeDiffOpener';
import { HistoryPatchSyntaxHighlighter } from './editor/HistoryPatchSyntaxHighlighter';
import { LineHistoryEditor } from './editor/LineHistoryEditor';
import { ShikiHistoryCodeTokenizer } from './editor/ShikiHistoryCodeTokenizer';
import { EditorGitContextService } from './editor/EditorGitContextService';
import { EditorHistoryCommands } from './editor/EditorHistoryCommands';
import { FileHistoryService } from './git/FileHistoryService';
import { GitRunner } from './git/GitRunner';
import { GitService } from './git/GitService';
import { GitOperationService } from './git/GitOperationService';
import { registerExtension } from './registerExtension';
import { RepositoryRegistry } from './repositories/RepositoryRegistry';
import { WorkbenchViewProvider } from './webview/WorkbenchPanel';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Git Log');
  const configuration = vscode.workspace.getConfiguration('gitLogWorkbench');
  const runner = new GitRunner({
    executable: configuration.get<string>('git.path', 'git'),
    logLevel: configuration.get<'off' | 'error' | 'debug'>('debug.logLevel', 'off'),
    onDiagnostic: (line) => output.appendLine(line),
  });
  const gitService = new GitService(runner);
  const fileHistoryService = new FileHistoryService(runner);
  const operationService = new GitOperationService(runner);
  const repositories = new RepositoryRegistry();
  const maximumDiffFileBytes = configuration.get<number>(
    'performance.maxDiffFileBytes',
    5 * 1024 * 1024,
  );
  const contentLoader = new RevisionContentLoader(
    repositories,
    gitService,
    maximumDiffFileBytes,
  );
  const diffManager = new DiffManager();
  const editorContexts = new EditorGitContextService(runner);
  const workingSnapshots = new WorkingSnapshotContentProvider(
    maximumDiffFileBytes,
    maximumDiffFileBytes * 8,
  );
  const fileComparisonEditor = new FileComparisonEditor(
    gitService,
    diffManager,
    workingSnapshots,
    repositories,
  );
  const shikiTokenizer = new ShikiHistoryCodeTokenizer();
  const syntaxHighlighter = new HistoryPatchSyntaxHighlighter(shikiTokenizer);
  const nativeDiffOpener = new HistoryNativeDiffOpener(gitService, diffManager, repositories);
  const fileHistoryEditor = new FileHistoryEditor(fileHistoryService, gitService, {
    initialPageSize: 100,
    pageSize: 100,
    syntaxHighlighter,
    nativeDiffOpener,
  });
  const lineHistoryEditor = new LineHistoryEditor(fileHistoryService, gitService, {
    syntaxHighlighter,
    nativeDiffOpener,
  });
  const compareFileCommand = new EditorFileComparisonCommand(
    editorContexts,
    gitService,
    fileComparisonEditor,
    {
      getActiveFile: () => {
        const editor = vscode.window.activeTextEditor;
        return editor?.document.uri.scheme === 'file'
          ? {
              fsPath: editor.document.uri.fsPath,
              ...(editor.document.isDirty ? { workingContent: editor.document.getText() } : {}),
            }
          : undefined;
      },
      pickRef: async (groups) => {
        const items = groups.flatMap((group) => [
          { label: group.label, kind: vscode.QuickPickItemKind.Separator },
          ...group.items,
        ]);
        const selected = await vscode.window.showQuickPick(items, {
          placeHolder: 'Select a branch or tag to compare with the current file',
          matchOnDescription: true,
          matchOnDetail: true,
        });
        return selected && 'ref' in selected ? selected.ref : undefined;
      },
      showErrorMessage: (message) => {
        void vscode.window.showErrorMessage(message);
      },
    },
  );
  const workbenchProvider = new WorkbenchViewProvider(
    context,
    output,
    runner,
    gitService,
    fileHistoryService,
    operationService,
    repositories,
    diffManager,
  );
  const workbenchViewRegistration = vscode.window.registerWebviewViewProvider(
    'gitLogWorkbench.log',
    workbenchProvider,
    { webviewOptions: { retainContextWhenHidden: true } },
  );
  const editorHistoryCommands = new EditorHistoryCommands(editorContexts, repositories, {
    getActiveEditor: () => {
      const editor = vscode.window.activeTextEditor;
      if (editor?.document.uri.scheme !== 'file') return undefined;
      return {
        fsPath: editor.document.uri.fsPath,
        selection: {
          startLine: editor.selection.start.line,
          startCharacter: editor.selection.start.character,
          endLine: editor.selection.end.line,
          endCharacter: editor.selection.end.character,
        },
        ...(editor.document.isDirty ? { workingContent: editor.document.getText() } : {}),
      };
    },
    openHistory: (request) => workbenchProvider.openEditorHistory(request),
    openFileHistory: (request) => fileHistoryEditor.open(request),
    openLineHistory: (request) => lineHistoryEditor.open(request),
    showErrorMessage: (message) => {
      void vscode.window.showErrorMessage(message);
    },
  });
  const registrations = registerExtension({
    registerCommand: (command, handler) => vscode.commands.registerCommand(command, handler),
    openWorkbench: () => {
      void vscode.commands.executeCommand('gitLogWorkbench.log.focus');
    },
    showLineHistory: () => editorHistoryCommands.showLineHistory(),
    showSelectionHistory: () => editorHistoryCommands.showSelectionHistory(),
    showFileHistory: () => editorHistoryCommands.showFileHistory(),
    compareFileWithRef: () => {
      void compareFileCommand.run();
    },
  });

  context.subscriptions.push(
    output,
    fileComparisonEditor,
    workingSnapshots,
    shikiTokenizer,
    nativeDiffOpener,
    fileHistoryEditor,
    lineHistoryEditor,
    workbenchProvider,
    workbenchViewRegistration,
    ...registrations,
    vscode.workspace.registerTextDocumentContentProvider(
      REVISION_SCHEME,
      new RevisionContentProvider(contentLoader),
    ),
    vscode.workspace.registerTextDocumentContentProvider(
      WORKING_SNAPSHOT_SCHEME,
      workingSnapshots,
    ),
    vscode.window.tabGroups.onDidChangeTabs((event) => {
      const closedTabs = new Set(event.closed);
      const openDiffInputs: vscode.TabInputTextDiff[] = [];
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          if (closedTabs.has(tab)) continue;
          if (tab.input instanceof vscode.TabInputTextDiff) {
            openDiffInputs.push(tab.input);
          }
        }
      }
      for (const tab of event.closed) {
        if (tab.input instanceof vscode.TabInputTextDiff) {
          releaseNativeDiffResourcesIfUnused(
            tab.input,
            openDiffInputs,
            repositories,
            workingSnapshots,
          );
        }
      }
    }),
  );
}

export function deactivate(): void {}
