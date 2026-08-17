import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileHistoryService } from '../../src/git/FileHistoryService';
import type { GitService } from '../../src/git/GitService';
import type { RepositorySummary } from '../../src/shared/models';

const { createWebviewPanel, panel, receiveMessage } = vi.hoisted(() => {
  let messageHandler: ((message: unknown) => Promise<void>) | undefined;
  const panel = {
    webview: {
      html: '',
      postMessage: vi.fn().mockResolvedValue(true),
      onDidReceiveMessage: vi.fn((handler: (message: unknown) => Promise<void>) => {
        messageHandler = handler;
        return { dispose: vi.fn() };
      }),
    },
    reveal: vi.fn(),
    dispose: vi.fn(),
    onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
  };
  return {
    createWebviewPanel: vi.fn(() => panel),
    panel,
    receiveMessage: async (message: unknown) => messageHandler?.(message),
  };
});

vi.mock('vscode', () => ({
  ViewColumn: { One: 1 },
  window: { createWebviewPanel },
}));

const repository: RepositorySummary = {
  id: 'repo-1',
  rootUri: 'file:///repo',
  gitDirUri: 'file:///repo/.git',
  displayName: 'repo',
  isBare: false,
  currentBranch: 'main',
  head: 'f'.repeat(40),
};

describe('LineHistoryEditor', () => {
  beforeEach(() => {
    createWebviewPanel.mockClear();
    panel.webview.html = '';
    panel.webview.postMessage.mockClear();
  });

  it('opens current-line history in a File History-style tab and sends only its patch', async () => {
    const modulePath = '../../src/editor/LineHistoryEditor';
    const editorModule = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(editorModule, 'LineHistoryEditor must exist').toBeDefined();
    if (!editorModule) return;

    const hash = 'a'.repeat(40);
    const linePatch = '@@ -8 +8 @@\n-old target\n+new target\n';
    const fileHistoryService = {
      resolveHeadLineRange: vi.fn().mockResolvedValue({
        status: 'mapped',
        startLine: 8,
        endLine: 8,
        partiallyUncommitted: false,
      }),
      getLineHistory: vi.fn().mockResolvedValue({
        entries: [{
          hash,
          parents: ['b'.repeat(40)],
          subject: 'update target',
          authorName: 'Alice',
          authorEmail: 'alice@example.com',
          authorTime: 1,
          commitTime: 2,
          refs: [],
          path: 'src/app.ts',
          additions: 1,
          deletions: 1,
          binary: false,
          oldStartLine: 8,
          oldLineCount: 1,
          newStartLine: 0,
          newLineCount: 0,
          linePatch,
        }],
        truncated: false,
      }),
    } as unknown as FileHistoryService;
    const gitService = { getRefs: vi.fn().mockResolvedValue([]) } as unknown as GitService;
    const highlightPatch = vi.fn().mockResolvedValue([
      undefined,
      [{ content: '-old target', light: '#111111', dark: '#eeeeee' }],
    ]);
    const openNativeDiff = vi.fn().mockResolvedValue(undefined);
    const editor = new editorModule.LineHistoryEditor(fileHistoryService, gitService, {
      syntaxHighlighter: { highlightPatch },
      nativeDiffOpener: { open: openNativeDiff },
    });

    await editor.open({
      kind: 'line',
      repository,
      path: 'src/app.ts',
      startLine: 8,
      endLine: 8,
    });

    expect(createWebviewPanel).toHaveBeenCalledWith(
      'gitLog.lineHistory',
      'Line History: app.ts:8',
      1,
      expect.objectContaining({ enableScripts: true, retainContextWhenHidden: true }),
    );
    expect(panel.webview.html).toContain('class="file-history-shell"');
    expect(panel.webview.html).toContain('data-history-hash="' + hash + '"');
    expect(panel.webview.html).not.toContain('-old target');

    await receiveMessage({ type: 'fileHistoryReady' });

    expect(panel.webview.postMessage).toHaveBeenCalledWith({
      type: 'fileHistoryDiffLoaded',
      hash,
      subject: 'update target',
      subtitle: 'src/app.ts · line 8',
      patch: linePatch,
      binary: false,
      highlightedLines: [
        undefined,
        [{ content: '-old target', light: '#111111', dark: '#eeeeee' }],
      ],
    });

    await receiveMessage({ type: 'openFileHistoryNativeDiff', hash });
    expect(openNativeDiff).toHaveBeenCalledWith(
      repository,
      '/repo',
      expect.objectContaining({ hash, linePatch }),
      'b'.repeat(40),
      expect.any(AbortSignal),
    );
  });

  it.each([
    ['byte limit', 'x'.repeat(8 * 1024 * 1024 + 1)],
    ['line limit', '+x\n'.repeat(50_001)],
  ])('shows a status instead of sending a line patch over the %s', async (_label, oversizedPatch) => {
    const { LineHistoryEditor } = await import('../../src/editor/LineHistoryEditor');
    const hash = 'c'.repeat(40);
    const editor = new LineHistoryEditor(
      {
        resolveHeadLineRange: vi.fn().mockResolvedValue({
          status: 'mapped',
          startLine: 1,
          endLine: 1,
          partiallyUncommitted: false,
        }),
        getLineHistory: vi.fn().mockResolvedValue({
          entries: [{
            hash,
            parents: [],
            subject: 'large line change',
            authorName: 'Alice',
            authorEmail: 'alice@example.com',
            authorTime: 1,
            commitTime: 2,
            refs: [],
            path: 'large.txt',
            additions: 1,
            deletions: 1,
            binary: false,
            linePatch: oversizedPatch,
          }],
          truncated: false,
        }),
      } as unknown as FileHistoryService,
      { getRefs: vi.fn().mockResolvedValue([]) } as unknown as GitService,
    );

    await editor.open({
      kind: 'line',
      repository,
      path: 'large.txt',
      startLine: 1,
      endLine: 1,
    });
    await receiveMessage({ type: 'fileHistoryReady' });

    expect(panel.webview.postMessage).toHaveBeenCalledWith({
      type: 'fileHistoryError',
      hash,
      message: 'This line change is too large to render.',
    });
    expect(panel.webview.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'fileHistoryDiffLoaded', patch: oversizedPatch }),
    );
  });

  it('opens an empty current-line history tab when the repository has no commits', async () => {
    const { LineHistoryEditor } = await import('../../src/editor/LineHistoryEditor');
    const resolveHeadLineRange = vi.fn();
    const getRefs = vi.fn();
    const editor = new LineHistoryEditor(
      { resolveHeadLineRange } as unknown as FileHistoryService,
      { getRefs } as unknown as GitService,
    );
    const { head, ...emptyRepository } = repository;
    void head;

    await editor.open({
      kind: 'line',
      repository: emptyRepository,
      path: 'new.txt',
      startLine: 1,
      endLine: 1,
    });

    expect(createWebviewPanel).toHaveBeenCalledWith(
      'gitLog.lineHistory',
      'Line History: new.txt:1',
      1,
      expect.any(Object),
    );
    expect(panel.webview.html).toContain('This repository has no commits yet.');
    expect(resolveHeadLineRange).not.toHaveBeenCalled();
    expect(getRefs).not.toHaveBeenCalled();
  });

  it('opens a selection range with a Selection History title and full tracked content', async () => {
    const { LineHistoryEditor } = await import('../../src/editor/LineHistoryEditor');
    const editor = new LineHistoryEditor(
      {
        resolveHeadLineRange: vi.fn().mockResolvedValue({
          status: 'mapped',
          startLine: 37,
          endLine: 55,
          partiallyUncommitted: false,
        }),
        getLineHistory: vi.fn().mockResolvedValue({ entries: [], truncated: false }),
      } as unknown as FileHistoryService,
      { getRefs: vi.fn().mockResolvedValue([]) } as unknown as GitService,
    );

    await editor.open({
      kind: 'line',
      lineScope: 'selection',
      repository,
      path: 'referral_v3_home.page.dart',
      startLine: 37,
      endLine: 55,
    });

    expect(createWebviewPanel).toHaveBeenCalledWith(
      'gitLog.lineHistory',
      'Selection History: referral_v3_home.page.dart:37–55',
      1,
      expect.any(Object),
    );
    expect(panel.webview.html).toContain('const contentOnly = true');
  });

  it('cancels stale syntax highlighting when another line-history commit is selected', async () => {
    const { LineHistoryEditor } = await import('../../src/editor/LineHistoryEditor');
    const firstHash = 'a'.repeat(40);
    const secondHash = 'b'.repeat(40);
    let firstSignal: AbortSignal | undefined;
    let resolveFirst: ((value: []) => void) | undefined;
    const firstHighlight = new Promise<[]>((resolve) => {
      resolveFirst = resolve;
    });
    const highlightPatch = vi
      .fn()
      .mockImplementationOnce((_path, _patch, signal: AbortSignal) => {
        firstSignal = signal;
        return firstHighlight;
      })
      .mockResolvedValueOnce([]);
    const entries = [firstHash, secondHash].map((hash) => ({
      hash,
      parents: ['c'.repeat(40)],
      subject: hash === firstHash ? 'first' : 'second',
      authorName: 'Alice',
      authorEmail: 'alice@example.com',
      authorTime: 1,
      commitTime: 2,
      refs: [],
      path: 'src/app.ts',
      additions: 1,
      deletions: 1,
      binary: false,
      linePatch: `@@ -1 +1 @@\n-${hash}\n+new`,
    }));
    const editor = new LineHistoryEditor(
      {
        resolveHeadLineRange: vi.fn().mockResolvedValue({
          status: 'mapped', startLine: 1, endLine: 1, partiallyUncommitted: false,
        }),
        getLineHistory: vi.fn().mockResolvedValue({ entries, truncated: false }),
      } as unknown as FileHistoryService,
      { getRefs: vi.fn().mockResolvedValue([]) } as unknown as GitService,
      { syntaxHighlighter: { highlightPatch } },
    );
    await editor.open({
      kind: 'line', repository, path: 'src/app.ts', startLine: 1, endLine: 1,
    });

    const staleLoad = receiveMessage({ type: 'fileHistoryReady' });
    await vi.waitFor(() => expect(highlightPatch).toHaveBeenCalledOnce());
    await receiveMessage({ type: 'selectFileHistoryCommit', hash: secondHash });
    resolveFirst?.([]);
    await staleLoad;

    expect(firstSignal?.aborted).toBe(true);
    const loaded = panel.webview.postMessage.mock.calls
      .map((call) => call[0])
      .filter((message) => message.type === 'fileHistoryDiffLoaded');
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual(expect.objectContaining({ hash: secondHash }));
  });
});
