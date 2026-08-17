import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileHistoryService } from '../../src/git/FileHistoryService';
import type { GitService } from '../../src/git/GitService';
import type { HistoryEntry, RepositorySummary } from '../../src/shared/models';

const { createWebviewPanel, panel, receiveMessage, disposePanel } = vi.hoisted(() => {
  let messageHandler: ((message: unknown) => Promise<void> | void) | undefined;
  let disposeHandler: (() => void) | undefined;
  const panel = {
    title: '',
    webview: {
      html: '',
      postMessage: vi.fn().mockResolvedValue(true),
      onDidReceiveMessage: vi.fn((handler: (message: unknown) => Promise<void> | void) => {
        messageHandler = handler;
        return { dispose: vi.fn() };
      }),
    },
    reveal: vi.fn(),
    dispose: vi.fn(),
    onDidDispose: vi.fn((handler: () => void) => {
      disposeHandler = handler;
      return { dispose: vi.fn() };
    }),
  };
  return {
    createWebviewPanel: vi.fn(() => panel),
    panel,
    receiveMessage: async (message: unknown) => messageHandler?.(message),
    disposePanel: () => disposeHandler?.(),
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

function historyEntry(hashCharacter: string, subject: string, parents: string[]): HistoryEntry {
  return {
    hash: hashCharacter.repeat(40),
    parents,
    subject,
    authorName: 'Alice',
    authorEmail: 'alice@example.com',
    authorTime: 1,
    commitTime: 2,
    refs: [],
    path: 'src/app.ts',
    additions: 2,
    deletions: 1,
    binary: false,
  };
}

describe('FileHistoryEditor', () => {
  beforeEach(() => {
    createWebviewPanel.mockClear();
    panel.webview.html = '';
    panel.webview.postMessage.mockClear();
    panel.reveal.mockClear();
    panel.dispose.mockClear();
  });

  it('opens a dedicated editor tab with a commit list and the first inline diff', async () => {
    const modulePath = '../../src/editor/FileHistoryEditor';
    const editorModule = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(editorModule, 'FileHistoryEditor must exist').toBeDefined();
    if (!editorModule) return;

    const parent = '1'.repeat(40);
    const first = historyEntry('2', 'update app', [parent]);
    const second = historyEntry('1', 'add app', []);
    const fileHistoryService = {
      getFileHistory: vi.fn().mockResolvedValue([first, second]),
    } as unknown as FileHistoryService;
    const gitService = {
      getRefs: vi.fn().mockResolvedValue([]),
      getChangedFiles: vi.fn().mockResolvedValue([
        { status: 'M', path: 'src/app.ts', additions: 2, deletions: 1, binary: false },
      ]),
      getFilePatch: vi.fn().mockResolvedValue('@@ -1 +1 @@\n-old\n+new\n'),
    } as unknown as GitService;
    const highlightPatch = vi.fn().mockResolvedValue([
      undefined,
      [{ content: '-old', light: '#111111', dark: '#eeeeee' }],
    ]);
    const openNativeDiff = vi.fn().mockResolvedValue(undefined);
    const editor = new editorModule.FileHistoryEditor(fileHistoryService, gitService, {
      initialPageSize: 20,
      pageSize: 50,
      syntaxHighlighter: { highlightPatch },
      nativeDiffOpener: { open: openNativeDiff },
    });

    await editor.open({ kind: 'file', repository, path: 'src/app.ts' });

    expect(createWebviewPanel).toHaveBeenCalledWith(
      'gitLog.fileHistory',
      'File History: app.ts',
      1,
      expect.objectContaining({ enableScripts: true, retainContextWhenHidden: true }),
    );
    expect(panel.webview.html).toContain('class="file-history-shell"');
    expect(panel.webview.html).toContain('data-history-hash="2222222222222222222222222222222222222222"');
    expect(panel.webview.html).toContain('update app');
    expect(panel.webview.html).toContain('Inline Diff');
    expect(fileHistoryService.getFileHistory).toHaveBeenCalledWith('/repo', 'src/app.ts', [], {
      limit: 21,
      skip: 0,
      signal: expect.any(AbortSignal),
    });
    expect(gitService.getFilePatch).not.toHaveBeenCalled();

    await receiveMessage({ type: 'fileHistoryReady' });

    expect(gitService.getFilePatch).toHaveBeenCalledWith(
      '/repo',
      first.hash,
      parent,
      'src/app.ts',
      undefined,
      expect.any(AbortSignal),
    );
    expect(panel.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'fileHistoryDiffLoaded',
        hash: first.hash,
        parent,
        patch: '@@ -1 +1 @@\n-old\n+new\n',
        highlightedLines: [
          undefined,
          [{ content: '-old', light: '#111111', dark: '#eeeeee' }],
        ],
      }),
    );
    expect(highlightPatch).toHaveBeenCalledWith(
      'src/app.ts',
      '@@ -1 +1 @@\n-old\n+new\n',
      expect.any(AbortSignal),
    );

    await receiveMessage({
      type: 'openFileHistoryNativeDiff',
      hash: first.hash,
      parent,
    });
    expect(openNativeDiff).toHaveBeenCalledWith(
      repository,
      '/repo',
      first,
      parent,
      expect.any(AbortSignal),
    );
  });

  it('ignores a native diff request with a parent outside the selected merge commit', async () => {
    const { FileHistoryEditor } = await import('../../src/editor/FileHistoryEditor');
    const firstParent = '1'.repeat(40);
    const secondParent = '2'.repeat(40);
    const entry = historyEntry('3', 'merge app', [firstParent, secondParent]);
    const openNativeDiff = vi.fn();
    const editor = new FileHistoryEditor(
      { getFileHistory: vi.fn().mockResolvedValue([entry]) } as unknown as FileHistoryService,
      { getRefs: vi.fn().mockResolvedValue([]) } as unknown as GitService,
      {
        initialPageSize: 20,
        pageSize: 50,
        nativeDiffOpener: { open: openNativeDiff },
      },
    );
    await editor.open({ kind: 'file', repository, path: 'src/app.ts' });

    await receiveMessage({
      type: 'openFileHistoryNativeDiff',
      hash: entry.hash,
      parent: '4'.repeat(40),
    });

    expect(openNativeDiff).not.toHaveBeenCalled();
  });

  it('cancels a pending native diff request when its history tab closes', async () => {
    const { FileHistoryEditor } = await import('../../src/editor/FileHistoryEditor');
    const entry = historyEntry('5', 'update app', ['4'.repeat(40)]);
    let nativeSignal: AbortSignal | undefined;
    let finishOpen: (() => void) | undefined;
    const openNativeDiff = vi.fn(
      (_repository, _cwd, _entry, _parent, signal: AbortSignal) => {
        nativeSignal = signal;
        return new Promise<void>((resolve) => {
          finishOpen = resolve;
        });
      },
    );
    const editor = new FileHistoryEditor(
      { getFileHistory: vi.fn().mockResolvedValue([entry]) } as unknown as FileHistoryService,
      { getRefs: vi.fn().mockResolvedValue([]) } as unknown as GitService,
      {
        initialPageSize: 20,
        pageSize: 50,
        nativeDiffOpener: { open: openNativeDiff },
      },
    );
    await editor.open({ kind: 'file', repository, path: entry.path });

    const pendingOpen = receiveMessage({ type: 'openFileHistoryNativeDiff', hash: entry.hash });
    await vi.waitFor(() => expect(nativeSignal).toBeDefined());
    disposePanel();
    finishOpen?.();
    await pendingOpen;

    expect(nativeSignal?.aborted).toBe(true);
  });

  it('lets the webview recover and retry when loading another history page fails', async () => {
    const { FileHistoryEditor } = await import('../../src/editor/FileHistoryEditor');
    const first = historyEntry('3', 'latest', ['2'.repeat(40)]);
    const getFileHistory = vi
      .fn()
      .mockResolvedValueOnce([first, historyEntry('2', 'older', ['1'.repeat(40)])])
      .mockRejectedValueOnce(new Error('history failed'));
    const editor = new FileHistoryEditor(
      { getFileHistory } as unknown as FileHistoryService,
      {
        getRefs: vi.fn().mockResolvedValue([]),
        getChangedFiles: vi.fn().mockResolvedValue([]),
      } as unknown as GitService,
      { initialPageSize: 1, pageSize: 1 },
    );
    await editor.open({ kind: 'file', repository, path: 'src/app.ts' });
    panel.webview.postMessage.mockClear();

    await receiveMessage({ type: 'requestMoreFileHistory' });

    expect(panel.webview.postMessage).toHaveBeenCalledWith({
      type: 'fileHistoryEntriesLoadFailed',
      message: 'history failed',
    });
  });

  it('does not let a slower previous open replace the latest file history tab', async () => {
    const { FileHistoryEditor } = await import('../../src/editor/FileHistoryEditor');
    let resolveFirst: ((entries: HistoryEntry[]) => void) | undefined;
    let firstOpenSignal: AbortSignal | undefined;
    const firstPage = new Promise<HistoryEntry[]>((resolve) => {
      resolveFirst = resolve;
    });
    const latest = { ...historyEntry('4', 'latest file', []), path: 'src/latest.ts' };
    const getFileHistory = vi
      .fn()
      .mockImplementationOnce((_cwd, _path, _refs, page: { signal?: AbortSignal }) => {
        firstOpenSignal = page.signal;
        return firstPage;
      })
      .mockResolvedValueOnce([latest]);
    const editor = new FileHistoryEditor(
      { getFileHistory } as unknown as FileHistoryService,
      { getRefs: vi.fn().mockResolvedValue([]) } as unknown as GitService,
      { initialPageSize: 20, pageSize: 50 },
    );

    const slowerOpen = editor.open({ kind: 'file', repository, path: 'src/slow.ts' });
    await vi.waitFor(() => expect(getFileHistory).toHaveBeenCalledOnce());
    await editor.open({ kind: 'file', repository, path: 'src/latest.ts' });
    resolveFirst?.([]);
    await slowerOpen;

    expect(firstOpenSignal?.aborted).toBe(true);
    expect(createWebviewPanel).toHaveBeenCalledOnce();
    expect(createWebviewPanel).toHaveBeenCalledWith(
      'gitLog.fileHistory',
      'File History: latest.ts',
      1,
      expect.any(Object),
    );
  });

  it('prefers the exact rename or copy record when the old path also changed', async () => {
    const { FileHistoryEditor } = await import('../../src/editor/FileHistoryEditor');
    const entry = {
      ...historyEntry('5', 'copy and update source', ['4'.repeat(40)]),
      path: 'B.txt',
      oldPath: 'A.txt',
    };
    const getFilePatch = vi.fn().mockResolvedValue('patch for B');
    const editor = new FileHistoryEditor(
      { getFileHistory: vi.fn().mockResolvedValue([entry]) } as unknown as FileHistoryService,
      {
        getRefs: vi.fn().mockResolvedValue([]),
        getChangedFiles: vi.fn().mockResolvedValue([
          { status: 'M', path: 'A.txt', additions: 1, deletions: 1, binary: false },
          {
            status: 'C',
            oldPath: 'A.txt',
            path: 'B.txt',
            additions: 2,
            deletions: 0,
            binary: false,
          },
        ]),
        getFilePatch,
      } as unknown as GitService,
      { initialPageSize: 20, pageSize: 50 },
    );
    await editor.open({ kind: 'file', repository, path: 'B.txt' });

    await receiveMessage({ type: 'fileHistoryReady' });

    expect(getFilePatch).toHaveBeenCalledWith(
      '/repo',
      entry.hash,
      entry.parents[0],
      'B.txt',
      'A.txt',
      expect.any(AbortSignal),
    );
  });

  it('cancels the previous Git diff query when another commit is selected', async () => {
    const { FileHistoryEditor } = await import('../../src/editor/FileHistoryEditor');
    const first = historyEntry('6', 'first', ['5'.repeat(40)]);
    const second = historyEntry('5', 'second', ['4'.repeat(40)]);
    let firstSignal: AbortSignal | undefined;
    let resolveFirst: ((files: []) => void) | undefined;
    const firstFiles = new Promise<[]>((resolve) => {
      resolveFirst = resolve;
    });
    const getChangedFiles = vi
      .fn()
      .mockImplementationOnce((_cwd, _hash, _parent, signal: AbortSignal | undefined) => {
        firstSignal = signal;
        return firstFiles;
      })
      .mockResolvedValueOnce([
        { status: 'M', path: 'src/app.ts', additions: 1, deletions: 1, binary: false },
      ]);
    const editor = new FileHistoryEditor(
      { getFileHistory: vi.fn().mockResolvedValue([first, second]) } as unknown as FileHistoryService,
      {
        getRefs: vi.fn().mockResolvedValue([]),
        getChangedFiles,
        getFilePatch: vi.fn().mockResolvedValue('second patch'),
      } as unknown as GitService,
      { initialPageSize: 20, pageSize: 50 },
    );
    await editor.open({ kind: 'file', repository, path: 'src/app.ts' });

    const firstLoad = receiveMessage({ type: 'fileHistoryReady' });
    await vi.waitFor(() => expect(getChangedFiles).toHaveBeenCalledOnce());
    await receiveMessage({ type: 'selectFileHistoryCommit', hash: second.hash });

    expect(firstSignal?.aborted).toBe(true);
    resolveFirst?.([]);
    await firstLoad;
  });

  it('loads the patch from the history path when changed-file metadata cannot be matched', async () => {
    const { FileHistoryEditor } = await import('../../src/editor/FileHistoryEditor');
    const entry = historyEntry('7', 'update app', ['6'.repeat(40)]);
    const getFilePatch = vi.fn().mockResolvedValue('@@ -1 +1 @@\n-old\n+new\n');
    const editor = new FileHistoryEditor(
      { getFileHistory: vi.fn().mockResolvedValue([entry]) } as unknown as FileHistoryService,
      {
        getRefs: vi.fn().mockResolvedValue([]),
        getChangedFiles: vi.fn().mockResolvedValue([]),
        getFilePatch,
      } as unknown as GitService,
      { initialPageSize: 20, pageSize: 50 },
    );
    await editor.open({ kind: 'file', repository, path: 'src/app.ts' });

    await receiveMessage({ type: 'fileHistoryReady' });

    expect(getFilePatch).toHaveBeenCalledWith(
      '/repo',
      entry.hash,
      entry.parents[0],
      entry.path,
      entry.oldPath,
      expect.any(AbortSignal),
    );
    expect(panel.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'fileHistoryDiffLoaded',
        hash: entry.hash,
        patch: '@@ -1 +1 @@\n-old\n+new\n',
      }),
    );
  });

  it('falls back to the plain patch when background syntax highlighting fails', async () => {
    const { FileHistoryEditor } = await import('../../src/editor/FileHistoryEditor');
    const entry = historyEntry('8', 'update app', ['7'.repeat(40)]);
    const patch = '@@ -1 +1 @@\n-old\n+new\n';
    const editor = new FileHistoryEditor(
      { getFileHistory: vi.fn().mockResolvedValue([entry]) } as unknown as FileHistoryService,
      {
        getRefs: vi.fn().mockResolvedValue([]),
        getChangedFiles: vi.fn().mockResolvedValue([
          { status: 'M', path: entry.path, additions: 1, deletions: 1, binary: false },
        ]),
        getFilePatch: vi.fn().mockResolvedValue(patch),
      } as unknown as GitService,
      {
        initialPageSize: 20,
        pageSize: 50,
        syntaxHighlighter: {
          highlightPatch: vi.fn().mockRejectedValue(
            new Error('History highlighting produced too many syntax tokens.'),
          ),
        },
      },
    );
    await editor.open({ kind: 'file', repository, path: entry.path });

    await receiveMessage({ type: 'fileHistoryReady' });

    expect(panel.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'fileHistoryDiffLoaded',
        hash: entry.hash,
        patch,
      }),
    );
    expect(panel.webview.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'fileHistoryError' }),
    );
  });

  it('updates the inline diff for a selected commit and appends later history pages', async () => {
    const { FileHistoryEditor } = await import('../../src/editor/FileHistoryEditor');
    const first = historyEntry('3', 'latest', ['2'.repeat(40)]);
    const second = historyEntry('2', 'middle', ['1'.repeat(40)]);
    const getFileHistory = vi
      .fn()
      .mockResolvedValueOnce([first, second])
      .mockResolvedValueOnce([second]);
    const getFilePatch = vi.fn(async (_cwd, hash: string) => `patch:${hash}`);
    const gitService = {
      getRefs: vi.fn().mockResolvedValue([]),
      getChangedFiles: vi.fn().mockResolvedValue([
        { status: 'M', path: 'src/app.ts', additions: 1, deletions: 1, binary: false },
      ]),
      getFilePatch,
    } as unknown as GitService;
    const editor = new FileHistoryEditor(
      { getFileHistory } as unknown as FileHistoryService,
      gitService,
      { initialPageSize: 1, pageSize: 1 },
    );
    await editor.open({ kind: 'file', repository, path: 'src/app.ts' });
    panel.webview.postMessage.mockClear();

    await receiveMessage({ type: 'requestMoreFileHistory' });
    await receiveMessage({ type: 'selectFileHistoryCommit', hash: second.hash });

    expect(getFilePatch).toHaveBeenCalledWith(
      '/repo',
      second.hash,
      second.parents[0],
      'src/app.ts',
      undefined,
      expect.any(AbortSignal),
    );
    expect(getFileHistory).toHaveBeenLastCalledWith('/repo', 'src/app.ts', [], {
      limit: 2,
      skip: 1,
      signal: expect.any(AbortSignal),
    });
    expect(panel.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'fileHistoryDiffLoaded',
        hash: second.hash,
        patch: `patch:${second.hash}`,
      }),
    );
    expect(panel.webview.postMessage).toHaveBeenCalledWith({
      type: 'fileHistoryEntriesAppended',
      entries: [second],
      hasMore: false,
    });
  });
});
