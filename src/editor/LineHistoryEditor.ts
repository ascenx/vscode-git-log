import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as vscode from 'vscode';
import type { FileHistoryService } from '../git/FileHistoryService';
import type { GitService } from '../git/GitService';
import type { LineHistoryEntry } from '../git/parsers/parseLineHistory';
import type { EditorHistoryRequest, HistoryEntry, RefLabel } from '../shared/models';
import { createFileHistoryHtml } from './createFileHistoryHtml';
import type {
  HistoryDiffSupport,
  HistoryNativeDiffOpener,
  HistorySyntaxHighlighter,
} from './HistoryDiffSupport';

const WEBVIEW_LINE_PATCH_MAX_BYTES = 8 * 1024 * 1024;
const WEBVIEW_LINE_PATCH_MAX_LINES = 50_000;

interface LineHistorySession {
  panel: vscode.WebviewPanel;
  request: EditorHistoryRequest & { kind: 'line' };
  entries: LineHistoryEntry[];
  diffRequestId: number;
  diffAbortController?: AbortController;
  nativeDiffAbortController?: AbortController;
}

interface SelectCommitMessage {
  type: 'selectFileHistoryCommit';
  hash: string;
}

interface FileHistoryReadyMessage {
  type: 'fileHistoryReady';
}

interface OpenNativeDiffMessage {
  type: 'openFileHistoryNativeDiff';
  hash: string;
}

type LineHistoryMessage = SelectCommitMessage | FileHistoryReadyMessage | OpenNativeDiffMessage;

function isLineHistoryMessage(value: unknown): value is LineHistoryMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  return (
    message.type === 'fileHistoryReady' ||
    ((message.type === 'selectFileHistoryCommit' || message.type === 'openFileHistoryNativeDiff') &&
      typeof message.hash === 'string')
  );
}

function withoutLinePatch(entry: LineHistoryEntry): HistoryEntry {
  const { linePatch, ...summary } = entry;
  void linePatch;
  return summary;
}

function lineLabel(startLine: number, endLine: number): string {
  return startLine === endLine ? String(startLine) : `${String(startLine)}–${String(endLine)}`;
}

function canRenderLinePatch(patch: string): boolean {
  if (Buffer.byteLength(patch, 'utf8') > WEBVIEW_LINE_PATCH_MAX_BYTES) return false;
  let lines = 0;
  for (let index = 0; index < patch.length; index += 1) {
    if (patch.charCodeAt(index) === 10 && ++lines > WEBVIEW_LINE_PATCH_MAX_LINES) return false;
  }
  return true;
}

export class LineHistoryEditor implements vscode.Disposable {
  private session: LineHistorySession | undefined;
  private abortController: AbortController | undefined;
  private openRequestId = 0;
  private readonly syntaxHighlighter: HistorySyntaxHighlighter | undefined;
  private readonly nativeDiffOpener: HistoryNativeDiffOpener | undefined;

  constructor(
    private readonly fileHistoryService: FileHistoryService,
    private readonly gitService: GitService,
    support: HistoryDiffSupport = {},
  ) {
    this.syntaxHighlighter = support.syntaxHighlighter;
    this.nativeDiffOpener = support.nativeDiffOpener;
  }

  async open(request: EditorHistoryRequest & { kind: 'line' }): Promise<void> {
    const startLine = request.startLine;
    const endLine = request.endLine;
    if (startLine === undefined || endLine === undefined) {
      throw new Error('Line history requires a valid line range.');
    }

    const requestId = ++this.openRequestId;
    this.abortController?.abort();
    this.session?.diffAbortController?.abort();
    this.session?.nativeDiffAbortController?.abort();
    this.session?.panel.dispose();
    this.session = undefined;
    const abortController = new AbortController();
    this.abortController = abortController;
    const cwd = fileURLToPath(request.repository.rootUri);
    let entries: LineHistoryEntry[] = [];
    let notice: string | undefined;
    try {
      if (!request.repository.head) {
        notice = 'This repository has no commits yet.';
      } else {
        const refs: RefLabel[] = await this.gitService.getRefs(
          cwd,
          request.repository.currentBranch,
          abortController.signal,
        );
        const mapping = await this.fileHistoryService.resolveHeadLineRange(
          cwd,
          request.path,
          startLine,
          endLine,
          abortController.signal,
          request.workingContent,
        );
        if (requestId !== this.openRequestId) return;
        if (mapping.status === 'file-not-in-head') {
          notice = mapping.hasHistory
            ? 'This file does not exist in HEAD. Use File History instead.'
            : startLine === endLine
              ? 'This line has no committed history yet.'
              : 'These lines have no committed history yet.';
        } else if (mapping.status === 'uncommitted-only') {
          notice = startLine === endLine
            ? 'This line has no committed history yet.'
            : 'These lines have no committed history yet.';
        } else if (mapping.status === 'discontinuous') {
          notice = 'The selected lines do not map to a continuous committed range. Select a smaller range.';
        } else {
          const result = await this.fileHistoryService.getLineHistory(
            cwd,
            request.path,
            mapping.startLine,
            mapping.endLine,
            refs,
            abortController.signal,
          );
          if (requestId !== this.openRequestId) return;
          entries = result.entries;
          const notices: string[] = [];
          if (mapping.partiallyUncommitted) {
            notices.push('Part of the selection has not been committed; showing history for the committed lines.');
          }
          if (result.truncated) notices.push('Showing the first 500 matching commits.');
          notice = notices.length ? notices.join(' ') : undefined;
        }
      }
    } catch (error) {
      if (abortController.signal.aborted || requestId !== this.openRequestId) return;
      throw error;
    } finally {
      if (this.abortController === abortController) this.abortController = undefined;
    }

    const panel = vscode.window.createWebviewPanel(
      'gitLog.lineHistory',
      `${request.lineScope === 'selection' ? 'Selection' : 'Line'} History: ${basename(request.path)}:${lineLabel(startLine, endLine)}`,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    const session: LineHistorySession = { panel, request, entries, diffRequestId: 0 };
    this.session = session;
    const messageSubscription = panel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (this.session !== session || !isLineHistoryMessage(message)) return;
      const entry = message.type === 'fileHistoryReady'
        ? session.entries[0]
        : session.entries.find((candidate) => candidate.hash === message.hash);
      if (!entry) return;
      if (message.type === 'openFileHistoryNativeDiff') {
        if (this.nativeDiffOpener) {
          session.nativeDiffAbortController?.abort();
          const abortController = new AbortController();
          session.nativeDiffAbortController = abortController;
          try {
            await this.nativeDiffOpener.open(
              session.request.repository,
              fileURLToPath(session.request.repository.rootUri),
              entry,
              entry.parents[0],
              abortController.signal,
            );
          } catch (error) {
            if (abortController.signal.aborted || this.session !== session) return;
            await session.panel.webview.postMessage({
              type: 'fileHistoryError',
              hash: entry.hash,
              message: error instanceof Error ? error.message : String(error),
            });
          } finally {
            if (session.nativeDiffAbortController === abortController) {
              delete session.nativeDiffAbortController;
            }
          }
        }
        return;
      }
      await this.postLineDiff(session, entry);
    });
    panel.onDidDispose(() => {
      session.diffAbortController?.abort();
      session.nativeDiffAbortController?.abort();
      messageSubscription.dispose();
      if (this.session === session) this.session = undefined;
    });
    const emptyMessage = notice ?? (startLine === endLine
      ? 'This line has no committed history yet.'
      : 'These lines have no committed history yet.');
    panel.webview.html = createFileHistoryHtml({
      nonce: randomBytes(18).toString('base64url'),
      path: request.path,
      entries: entries.map(withoutLinePatch),
      hasMore: false,
      ...(request.lineScope === 'selection'
        ? { contentOnly: true }
        : { changesOnly: true }),
      emptyMessage,
      ...(entries.length > 0 && notice ? { notice } : {}),
    });
  }

  dispose(): void {
    this.openRequestId += 1;
    this.abortController?.abort();
    this.abortController = undefined;
    this.session?.diffAbortController?.abort();
    this.session?.nativeDiffAbortController?.abort();
    this.session?.panel.dispose();
    this.session = undefined;
  }

  private async postLineDiff(
    session: LineHistorySession,
    entry: LineHistoryEntry,
  ): Promise<void> {
    session.diffAbortController?.abort();
    const abortController = new AbortController();
    session.diffAbortController = abortController;
    const requestId = ++session.diffRequestId;
    const line = entry.newLineCount === 0
      ? entry.oldStartLine
      : entry.newStartLine ?? entry.oldStartLine ?? session.request.startLine;
    try {
      await session.panel.webview.postMessage({ type: 'fileHistoryDiffLoading', hash: entry.hash });
      if (!canRenderLinePatch(entry.linePatch)) {
        if (this.session !== session || requestId !== session.diffRequestId) return;
        await session.panel.webview.postMessage({
          type: 'fileHistoryError',
          hash: entry.hash,
          message: 'This line change is too large to render.',
        });
        return;
      }
      let highlightedLines;
      if (this.syntaxHighlighter) {
        try {
          highlightedLines = await this.syntaxHighlighter.highlightPatch(
            entry.path,
            entry.linePatch,
            abortController.signal,
          );
        } catch (error) {
          if (abortController.signal.aborted) return;
          void error;
          highlightedLines = undefined;
        }
      }
      if (this.session !== session || requestId !== session.diffRequestId) return;
      await session.panel.webview.postMessage({
        type: 'fileHistoryDiffLoaded',
        hash: entry.hash,
        subject: entry.subject,
        subtitle: line === undefined ? entry.path : `${entry.path} · line ${String(line)}`,
        patch: entry.linePatch,
        binary: entry.binary,
        ...(highlightedLines ? { highlightedLines } : {}),
      });
    } finally {
      if (session.diffAbortController === abortController) {
        delete session.diffAbortController;
      }
    }
  }
}
