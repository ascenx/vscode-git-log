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
import {
  CurrentLineBlameController,
  type CurrentLineBlamePresentation,
  type CurrentLineEditorSnapshot,
} from './editor/CurrentLineBlameController';
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
import { LineBlameService } from './git/LineBlameService';
import { registerExtension } from './registerExtension';
import { RepositoryRegistry } from './repositories/RepositoryRegistry';
import { WorkbenchViewProvider } from './webview/WorkbenchPanel';

const MAX_DIRTY_BLAME_CHARACTERS = 2 * 1024 * 1024;
const MAX_EDIT_TIME_DOCUMENTS = 50;
const MAX_EDIT_TIME_LINES_PER_DOCUMENT = 500;

interface LineEditTime {
  text: string;
  editTime: number;
}

interface GitRepository {
  readonly state: {
    onDidChange(listener: () => void): vscode.Disposable;
  };
}

interface GitApi {
  readonly repositories: readonly GitRepository[];
  onDidOpenRepository(listener: (repository: GitRepository) => void): vscode.Disposable;
  onDidCloseRepository(listener: (repository: GitRepository) => void): vscode.Disposable;
}

interface GitExtension {
  getAPI(version: 1): GitApi;
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Git Log');
  const configuration = vscode.workspace.getConfiguration('gitLogWorkbench');
  const runner = new GitRunner({
    executable: configuration.get<string>('git.path', 'git'),
    logLevel: configuration.get<'off' | 'error' | 'debug'>('debug.logLevel', 'off'),
    onDiagnostic: (line) => output.appendLine(line),
  });
  const gitService = new GitService(runner);
  const lineBlameService = new LineBlameService(runner);
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
  const lineBlameDecoration = vscode.window.createTextEditorDecorationType({
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    after: {
      color: new vscode.ThemeColor('editorGhostText.foreground'),
      margin: '0 0 0 3em',
    },
  });
  const lineEditTimes = new Map<string, Map<number, LineEditTime>>();
  const editorKey = (editor: vscode.TextEditor): string => {
    const line = editor.selection.active.line;
    return `${editor.document.uri.toString()}:${String(editor.viewColumn ?? 0)}:${String(editor.document.version)}:${String(line)}`;
  };
  const editorSnapshot = (): CurrentLineEditorSnapshot | undefined => {
    if (
      !vscode.workspace
        .getConfiguration('gitLogWorkbench')
        .get<boolean>('currentLineBlame.enabled', true)
    ) {
      return undefined;
    }
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.uri.scheme !== 'file') return undefined;
    if (editor.document.isDirty) {
      const finalLine = editor.document.lineAt(editor.document.lineCount - 1);
      if (
        editor.document.offsetAt(finalLine.rangeIncludingLineBreak.end) > MAX_DIRTY_BLAME_CHARACTERS
      ) {
        return undefined;
      }
    }
    const line = editor.selection.active.line;
    const lineText = editor.document.lineAt(line).text;
    const trackedEdit = lineEditTimes.get(editor.document.uri.toString())?.get(line);
    return {
      key: editorKey(editor),
      fsPath: editor.document.uri.fsPath,
      line,
      ...(editor.document.isDirty ? { workingContent: editor.document.getText() } : {}),
      ...(trackedEdit?.text === lineText ? { editTime: trackedEdit.editTime } : {}),
    };
  };
  const createBlameHover = (presentation: CurrentLineBlamePresentation): vscode.MarkdownString => {
    const hover = new vscode.MarkdownString();
    hover.isTrusted = false;
    hover.appendMarkdown('**Author:** ');
    hover.appendText(
      presentation.authorEmail
        ? `${presentation.authorName} <${presentation.authorEmail}>`
        : presentation.authorName,
    );
    hover.appendMarkdown('\n\n**Time:** ');
    hover.appendText(`${presentation.authoredAt} (${presentation.relativeTime})`);
    if (presentation.committed) {
      hover.appendMarkdown('\n\n**Commit:** `');
      hover.appendText(presentation.hash);
      hover.appendMarkdown('`\n\n---\n\n');
      hover.appendText(presentation.message);
    } else {
      hover.appendMarkdown('\n\n---\n\n');
      hover.appendText(presentation.message);
    }
    return hover;
  };
  const clearLineBlame = (): void => {
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(lineBlameDecoration, []);
    }
  };
  const currentLineBlame = new CurrentLineBlameController(
    editorContexts,
    lineBlameService,
    gitService,
    {
      getActiveEditor: editorSnapshot,
      render: (snapshot, presentation) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editorKey(editor) !== snapshot.key) return;
        const line = editor.document.lineAt(snapshot.line);
        const position = line.range.end;
        editor.setDecorations(lineBlameDecoration, [
          {
            range: new vscode.Range(position, position),
            hoverMessage: createBlameHover(presentation),
            renderOptions: { after: { contentText: presentation.contentText } },
          },
        ]);
      },
      clear: clearLineBlame,
      locale: vscode.env.language,
      now: () => Date.now(),
    },
  );
  let lineBlameTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleLineBlame = (delayMs = 150): void => {
    if (lineBlameTimer) clearTimeout(lineBlameTimer);
    lineBlameTimer = setTimeout(() => {
      lineBlameTimer = undefined;
      void currentLineBlame.refresh();
    }, delayMs);
  };
  const gitRepositorySubscriptions = new Map<GitRepository, vscode.Disposable>();
  const gitApiSubscriptions: vscode.Disposable[] = [];
  let gitStateDisposed = false;
  const disposeGitStateSubscriptions = new vscode.Disposable(() => {
    gitStateDisposed = true;
    for (const disposable of gitApiSubscriptions.splice(0)) disposable.dispose();
    for (const disposable of gitRepositorySubscriptions.values()) disposable.dispose();
    gitRepositorySubscriptions.clear();
  });
  const attachGitRepository = (repository: GitRepository): void => {
    if (gitStateDisposed || gitRepositorySubscriptions.has(repository)) return;
    gitRepositorySubscriptions.set(
      repository,
      repository.state.onDidChange(() => {
        currentLineBlame.invalidate();
        scheduleLineBlame(0);
      }),
    );
  };
  void (async () => {
    const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!extension) return;
    const exports = extension.isActive ? extension.exports : await extension.activate();
    if (gitStateDisposed) return;
    const api = exports.getAPI(1);
    for (const repository of api.repositories) attachGitRepository(repository);
    gitApiSubscriptions.push(
      api.onDidOpenRepository(attachGitRepository),
      api.onDidCloseRepository((repository) => {
        gitRepositorySubscriptions.get(repository)?.dispose();
        gitRepositorySubscriptions.delete(repository);
      }),
    );
  })().catch((error: unknown) => {
    output.appendLine(
      `[git] unable to subscribe to repository changes: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
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
    disposeGitStateSubscriptions,
    new vscode.Disposable(() => {
      if (lineBlameTimer) clearTimeout(lineBlameTimer);
    }),
    currentLineBlame,
    lineBlameDecoration,
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
    vscode.window.onDidChangeActiveTextEditor(() => scheduleLineBlame()),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (event.textEditor === vscode.window.activeTextEditor) scheduleLineBlame();
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document === vscode.window.activeTextEditor?.document) {
        const documentKey = event.document.uri.toString();
        const editTime = Date.now();
        const editedLines = new Set<number>();
        for (const change of event.contentChanges) {
          const insertedLineCount = change.text.split(/\r\n|\r|\n/u).length;
          for (let offset = 0; offset < insertedLineCount; offset += 1) {
            editedLines.add(change.range.start.line + offset);
          }
        }
        editedLines.add(vscode.window.activeTextEditor.selection.active.line);
        const documentEdits = lineEditTimes.get(documentKey) ?? new Map<number, LineEditTime>();
        lineEditTimes.delete(documentKey);
        lineEditTimes.set(documentKey, documentEdits);
        for (const line of editedLines) {
          if (line < 0 || line >= event.document.lineCount) continue;
          documentEdits.set(line, { text: event.document.lineAt(line).text, editTime });
        }
        while (documentEdits.size > MAX_EDIT_TIME_LINES_PER_DOCUMENT) {
          const oldestLine = documentEdits.keys().next().value as number | undefined;
          if (oldestLine === undefined) break;
          documentEdits.delete(oldestLine);
        }
        while (lineEditTimes.size > MAX_EDIT_TIME_DOCUMENTS) {
          const oldestDocument = lineEditTimes.keys().next().value as string | undefined;
          if (!oldestDocument) break;
          lineEditTimes.delete(oldestDocument);
        }
        scheduleLineBlame(300);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('gitLogWorkbench.currentLineBlame.enabled')) {
        scheduleLineBlame(0);
      }
    }),
  );
  scheduleLineBlame(0);
}

export function deactivate(): void {}
