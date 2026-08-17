import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as vscode from 'vscode';
import type { FileHistoryService } from '../git/FileHistoryService';
import type { GitService } from '../git/GitService';
import type { EditorHistoryRequest, HistoryEntry, RefLabel } from '../shared/models';
import { createFileHistoryHtml } from './createFileHistoryHtml';
import type {
  HistoryDiffSupport,
  HistoryHighlightedLine,
  HistoryNativeDiffOpener,
  HistorySyntaxHighlighter,
} from './HistoryDiffSupport';

export interface FileHistoryEditorOptions extends HistoryDiffSupport {
  initialPageSize: number;
  pageSize: number;
}

interface FileHistorySession {
  panel: vscode.WebviewPanel;
  request: EditorHistoryRequest & { kind: 'file' };
  cwd: string;
  refs: RefLabel[];
  entries: HistoryEntry[];
  hasMore: boolean;
  loadingMore: boolean;
  diffRequestId: number;
  diffAbortController?: AbortController;
  historyAbortController?: AbortController;
  nativeDiffAbortController?: AbortController;
}

interface SelectCommitMessage {
  type: 'selectFileHistoryCommit';
  hash: string;
  parent?: string;
}

interface RequestMoreMessage {
  type: 'requestMoreFileHistory';
}

interface FileHistoryReadyMessage {
  type: 'fileHistoryReady';
}

interface OpenNativeDiffMessage {
  type: 'openFileHistoryNativeDiff';
  hash: string;
  parent?: string;
}

type FileHistoryMessage =
  | SelectCommitMessage
  | RequestMoreMessage
  | FileHistoryReadyMessage
  | OpenNativeDiffMessage;

function isFileHistoryMessage(value: unknown): value is FileHistoryMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  if (message.type === 'requestMoreFileHistory' || message.type === 'fileHistoryReady') return true;
  return (
    (message.type === 'selectFileHistoryCommit' || message.type === 'openFileHistoryNativeDiff') &&
    typeof message.hash === 'string' &&
    (message.parent === undefined || typeof message.parent === 'string')
  );
}

function validatePageSize(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 4999) {
    throw new Error(`${name} must be an integer between 1 and 4999.`);
  }
}

export class FileHistoryEditor implements vscode.Disposable {
  private session: FileHistorySession | undefined;
  private openRequestId = 0;
  private openAbortController: AbortController | undefined;
  private readonly options: FileHistoryEditorOptions;
  private readonly syntaxHighlighter: HistorySyntaxHighlighter | undefined;
  private readonly nativeDiffOpener: HistoryNativeDiffOpener | undefined;

  constructor(
    private readonly fileHistoryService: FileHistoryService,
    private readonly gitService: GitService,
    options: FileHistoryEditorOptions,
  ) {
    validatePageSize('initialPageSize', options.initialPageSize);
    validatePageSize('pageSize', options.pageSize);
    this.options = options;
    this.syntaxHighlighter = options.syntaxHighlighter;
    this.nativeDiffOpener = options.nativeDiffOpener;
  }

  async open(request: EditorHistoryRequest & { kind: 'file' }): Promise<void> {
    const openRequestId = ++this.openRequestId;
    this.openAbortController?.abort();
    const openAbortController = new AbortController();
    this.openAbortController = openAbortController;
    this.session?.diffAbortController?.abort();
    this.session?.historyAbortController?.abort();
    this.session?.nativeDiffAbortController?.abort();
    this.session?.panel.dispose();
    this.session = undefined;

    const cwd = fileURLToPath(request.repository.rootUri);
    let refs: RefLabel[];
    let page: HistoryEntry[];
    try {
      refs = await this.gitService.getRefs(
        cwd,
        request.repository.currentBranch,
        openAbortController.signal,
      );
      if (openRequestId !== this.openRequestId) return;
      page = await this.fileHistoryService.getFileHistory(cwd, request.path, refs, {
        limit: this.options.initialPageSize + 1,
        skip: 0,
        signal: openAbortController.signal,
      });
      if (openRequestId !== this.openRequestId) return;
    } catch (error) {
      if (openAbortController.signal.aborted || openRequestId !== this.openRequestId) return;
      throw error;
    } finally {
      if (this.openAbortController === openAbortController) {
        this.openAbortController = undefined;
      }
    }
    const hasMore = page.length > this.options.initialPageSize;
    const entries = page.slice(0, this.options.initialPageSize);
    const panel = vscode.window.createWebviewPanel(
      'gitLog.fileHistory',
      `File History: ${basename(request.path)}`,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );
    const session: FileHistorySession = {
      panel,
      request,
      cwd,
      refs,
      entries,
      hasMore,
      loadingMore: false,
      diffRequestId: 0,
    };
    this.session = session;
    const messageSubscription = panel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (this.session !== session || !isFileHistoryMessage(message)) return;
      if (message.type === 'fileHistoryReady') {
        const first = session.entries[0];
        if (first && session.diffRequestId === 0) {
          await this.loadDiff(session, first.hash, first.parents[0]);
        }
        return;
      }
      if (message.type === 'requestMoreFileHistory') {
        await this.loadMore(session);
        return;
      }
      if (message.type === 'openFileHistoryNativeDiff') {
        const entry = session.entries.find((candidate) => candidate.hash === message.hash);
        if (entry && this.nativeDiffOpener) {
          const parent = message.parent ?? entry.parents[0];
          if (parent !== undefined && !entry.parents.includes(parent)) return;
          session.nativeDiffAbortController?.abort();
          const abortController = new AbortController();
          session.nativeDiffAbortController = abortController;
          try {
            await this.nativeDiffOpener.open(
              session.request.repository,
              session.cwd,
              entry,
              parent,
              abortController.signal,
            );
          } catch (error) {
            if (abortController.signal.aborted || this.session !== session) return;
            await this.postError(session, error);
          } finally {
            if (session.nativeDiffAbortController === abortController) {
              delete session.nativeDiffAbortController;
            }
          }
        }
        return;
      }
      await this.loadDiff(session, message.hash, message.parent);
    });
    panel.onDidDispose(() => {
      session.diffAbortController?.abort();
      session.historyAbortController?.abort();
      session.nativeDiffAbortController?.abort();
      messageSubscription.dispose();
      if (this.session === session) this.session = undefined;
    });
    panel.webview.html = createFileHistoryHtml({
      nonce: randomBytes(18).toString('base64url'),
      path: request.path,
      entries,
      hasMore,
    });
  }

  dispose(): void {
    this.openRequestId += 1;
    this.openAbortController?.abort();
    this.openAbortController = undefined;
    this.session?.diffAbortController?.abort();
    this.session?.historyAbortController?.abort();
    this.session?.nativeDiffAbortController?.abort();
    this.session?.panel.dispose();
    this.session = undefined;
  }

  private async loadMore(session: FileHistorySession): Promise<void> {
    if (this.session !== session || session.loadingMore || !session.hasMore) return;
    session.loadingMore = true;
    const abortController = new AbortController();
    session.historyAbortController = abortController;
    try {
      const page = await this.fileHistoryService.getFileHistory(
        session.cwd,
        session.request.path,
        session.refs,
        {
          limit: this.options.pageSize + 1,
          skip: session.entries.length,
          signal: abortController.signal,
        },
      );
      if (this.session !== session) return;
      const hasMore = page.length > this.options.pageSize;
      const entries = page.slice(0, this.options.pageSize);
      session.entries.push(...entries);
      session.hasMore = hasMore;
      await session.panel.webview.postMessage({
        type: 'fileHistoryEntriesAppended',
        entries,
        hasMore,
      });
    } catch (error) {
      if (abortController.signal.aborted) return;
      if (this.session !== session) return;
      await session.panel.webview.postMessage({
        type: 'fileHistoryEntriesLoadFailed',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      session.loadingMore = false;
      if (session.historyAbortController === abortController) {
        delete session.historyAbortController;
      }
    }
  }

  private async loadDiff(
    session: FileHistorySession,
    hash: string,
    requestedParent?: string,
  ): Promise<void> {
    const entry = session.entries.find((candidate) => candidate.hash === hash);
    if (!entry) return;
    const parent = requestedParent ?? entry.parents[0];
    if (parent !== undefined && !entry.parents.includes(parent)) return;
    session.diffAbortController?.abort();
    const abortController = new AbortController();
    session.diffAbortController = abortController;
    const requestId = ++session.diffRequestId;
    await session.panel.webview.postMessage({ type: 'fileHistoryDiffLoading', hash });
    try {
      const files = await this.gitService.getChangedFiles(
        session.cwd,
        entry.hash,
        parent,
        abortController.signal,
      );
      const file =
        files.find(
          (candidate) =>
            candidate.path === entry.path && candidate.oldPath === entry.oldPath,
        ) ??
        files.find((candidate) => candidate.path === entry.path) ??
        (entry.oldPath === undefined
          ? undefined
          : files.find((candidate) => candidate.oldPath === entry.oldPath) ??
            files.find((candidate) => candidate.path === entry.oldPath));
      if (this.session !== session || requestId !== session.diffRequestId) return;
      if (file?.binary) {
        await session.panel.webview.postMessage({
          type: 'fileHistoryDiffLoaded',
          hash,
          parent,
          subject: entry.subject,
          subtitle: file.oldPath ? `${file.oldPath} → ${file.path}` : file.path,
          patch: '',
          binary: true,
        });
        return;
      }
      const patch = await this.gitService.getFilePatch(
        session.cwd,
        entry.hash,
        parent,
        file?.path ?? entry.path,
        file?.oldPath ?? entry.oldPath,
        abortController.signal,
      );
      if (this.session !== session || requestId !== session.diffRequestId) return;
      const highlightedLines = await this.highlightPatch(
        file?.path ?? entry.path,
        patch,
        abortController.signal,
      );
      if (this.session !== session || requestId !== session.diffRequestId) return;
      await session.panel.webview.postMessage({
        type: 'fileHistoryDiffLoaded',
        hash,
        parent,
        subject: entry.subject,
        subtitle:
          (file?.oldPath ?? entry.oldPath) !== undefined
            ? `${file?.oldPath ?? entry.oldPath} → ${file?.path ?? entry.path}`
            : file?.path ?? entry.path,
        patch,
        ...(highlightedLines ? { highlightedLines } : {}),
      });
    } catch (error) {
      if (abortController.signal.aborted) return;
      if (this.session !== session || requestId !== session.diffRequestId) return;
      await this.postError(session, error);
    } finally {
      if (session.diffAbortController === abortController) {
        delete session.diffAbortController;
      }
    }
  }

  private async highlightPatch(
    path: string,
    patch: string,
    signal: AbortSignal,
  ): Promise<readonly HistoryHighlightedLine[] | undefined> {
    if (!this.syntaxHighlighter) return undefined;
    try {
      return await this.syntaxHighlighter.highlightPatch(path, patch, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      return undefined;
    }
  }

  private async postError(session: FileHistorySession, error: unknown): Promise<void> {
    await session.panel.webview.postMessage({
      type: 'fileHistoryError',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
