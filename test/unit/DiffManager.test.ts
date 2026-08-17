import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createWebviewPanel, executeCommand, panel, receiveMessage, revealRange } = vi.hoisted(() => {
  let messageHandler: ((message: unknown) => Promise<void> | void) | undefined;
  const panel = {
    webview: {
      cspSource: 'vscode-webview:',
      html: '',
      onDidReceiveMessage: vi.fn((handler: (message: unknown) => Promise<void> | void) => {
        messageHandler = handler;
        return { dispose: vi.fn() };
      }),
    },
    onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
    reveal: vi.fn(),
    dispose: vi.fn(),
  };
  return {
    createWebviewPanel: vi.fn(() => panel),
    executeCommand: vi.fn(),
    revealRange: vi.fn(),
    panel,
    receiveMessage: async (message: unknown) => messageHandler?.(message),
  };
});

vi.mock('vscode', () => ({
  commands: { executeCommand },
  workspace: {
    getConfiguration: vi.fn(() => ({ get: vi.fn((_key: string, fallback: boolean) => fallback) })),
  },
  ViewColumn: { One: 1, Two: 2, Beside: -2 },
  TextEditorRevealType: { InCenterIfOutsideViewport: 1 },
  Range: class Range {
    constructor(
      readonly startLine: number,
      readonly startCharacter: number,
      readonly endLine: number,
      readonly endCharacter: number,
    ) {}
  },
  window: { createWebviewPanel, activeTextEditor: { revealRange, document: { lineCount: 100 } } },
  Uri: {
    from(value: { scheme: string; path: string; query?: string }) {
      return { ...value };
    },
  },
}));

import { DiffManager } from '../../src/diff/DiffManager';
import * as vscode from 'vscode';

describe('DiffManager', () => {
  beforeEach(() => {
    createWebviewPanel.mockClear();
    executeCommand.mockReset();
    revealRange.mockReset();
    vi.mocked(vscode.workspace.getConfiguration).mockClear();
    panel.webview.html = '';
  });

  it('keeps every selected file diff in the same second editor group', async () => {
    await new DiffManager().openCommit(
      'repo-1',
      { parent: 'a'.repeat(40), hash: 'b'.repeat(40) },
      [
        {
          status: 'M',
          path: 'src/features/app.dart',
          additions: 2,
          deletions: 1,
          binary: false,
        },
        {
          status: 'M',
          path: 'src/other.ts',
          additions: 3,
          deletions: 4,
          binary: false,
        },
      ],
    );

    expect(createWebviewPanel).toHaveBeenCalledOnce();
    expect(executeCommand).not.toHaveBeenCalled();
    expect(panel.webview.html).toContain('<details class="file-directory" open>');
    expect(panel.webview.html).toContain('<summary>src</summary>');
    expect(panel.webview.html).toContain('<summary>features</summary>');
    expect(panel.webview.html).toContain('app.dart');
    expect(panel.webview.html).toContain('data-file-icon="dart"');
    expect(panel.webview.html).toContain('data-file-icon="typescript"');
    expect(panel.webview.html).toContain('<symbol id="file-icon-dart"');
    expect(panel.webview.html).toContain('<symbol id="file-icon-typescript"');
    expect(panel.webview.html).toContain('<use href="#file-icon-dart"');
    expect(panel.webview.html).not.toContain('class="file-icon-sheet"');
    expect(panel.webview.html).toContain('--explorer-row-height: 22px;');
    expect(panel.webview.html).toContain('.file-directory > summary::before');
    expect(panel.webview.html).toContain('.file-directory[open] > summary::before');
    expect(panel.webview.html).toContain('file-stat-additions">+2');
    expect(panel.webview.html).toContain('file-stat-deletions">-1');

    await receiveMessage({ type: 'openComparisonFile', index: 0 });
    await receiveMessage({ type: 'openComparisonFile', index: 1 });

    expect(executeCommand).toHaveBeenCalledTimes(2);
    for (const call of executeCommand.mock.calls) {
      expect(call[0]).toBe('vscode.diff');
      expect(call[4]).toEqual({ preview: true, viewColumn: 2 });
    }
  });

  it('compares a selected revision or empty side with the current working file', async () => {
    const manager = new DiffManager();
    const workingFile = { scheme: 'file', path: '/workspace/src/app.ts' };

    await manager.openWorkingFileAgainstRevision('repo-1', {
      revision: 'a'.repeat(40),
      revisionLabel: 'feature',
      path: 'src/app.ts',
      workingFileUri: workingFile as never,
      revisionExists: true,
    });
    await manager.openWorkingFileAgainstRevision('repo-1', {
      revision: 'b'.repeat(40),
      revisionLabel: 'v1.0.0',
      path: 'src/new.ts',
      workingFileUri: workingFile as never,
      revisionExists: false,
    });

    expect(executeCommand).toHaveBeenNthCalledWith(
      1,
      'vscode.diff',
      expect.objectContaining({ scheme: 'git-log-workbench' }),
      workingFile,
      'Compare: app.ts (feature ↔ Working Tree)',
      { preview: true },
    );
    expect(executeCommand).toHaveBeenNthCalledWith(
      2,
      'vscode.diff',
      expect.objectContaining({ query: expect.stringContaining('empty=1') }),
      workingFile,
      'Compare: new.ts (v1.0.0 ↔ Working Tree)',
      { preview: true },
    );
  });

  it('forces a working-file comparison into the native inline diff view', async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValueOnce({
      get: vi.fn().mockReturnValue(true),
    } as never);
    const workingFile = { scheme: 'file', path: '/workspace/src/app.ts' };

    await new DiffManager().openWorkingFileAgainstRevision('repo-1', {
      revision: 'a'.repeat(40),
      revisionLabel: 'feature',
      path: 'src/app.ts',
      workingFileUri: workingFile as never,
      revisionExists: true,
      forceInline: true,
      isCurrent: () => true,
    });

    expect(executeCommand).toHaveBeenNthCalledWith(
      1,
      'vscode.diff',
      expect.objectContaining({ scheme: 'git-log-workbench' }),
      workingFile,
      'Compare: app.ts (feature ↔ Working Tree)',
      { preview: true },
    );
    expect(vscode.workspace.getConfiguration).toHaveBeenCalledWith('diffEditor', workingFile);
    expect(executeCommand).toHaveBeenNthCalledWith(
      2,
      'toggle.diff.renderSideBySide',
      workingFile,
    );
  });

  it('does not toggle an obsolete native diff after a newer request starts', async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValueOnce({
      get: vi.fn().mockReturnValue(true),
    } as never);
    const workingFile = { scheme: 'file', path: '/workspace/src/app.ts' };

    await new DiffManager().openWorkingFileAgainstRevision('repo-1', {
      revision: 'a'.repeat(40),
      revisionLabel: 'feature',
      path: 'src/app.ts',
      workingFileUri: workingFile as never,
      revisionExists: true,
      forceInline: true,
      isCurrent: () => false,
    });

    expect(executeCommand).toHaveBeenCalledOnce();
    expect(vscode.workspace.getConfiguration).not.toHaveBeenCalled();
  });

  it('publishes the original URI before opening a working-file diff', async () => {
    const events: string[] = [];
    executeCommand.mockImplementationOnce(() => {
      events.push('open');
    });
    const onWillOpen = vi.fn(() => events.push('retain'));

    await new DiffManager().openWorkingFileAgainstRevision('repo-1', {
      revision: 'a'.repeat(40),
      revisionLabel: 'feature',
      path: 'src/app.ts',
      workingFileUri: { scheme: 'file', path: '/workspace/src/app.ts' } as never,
      revisionExists: true,
      onWillOpen,
    });

    expect(events).toEqual(['retain', 'open']);
    expect(onWillOpen).toHaveBeenCalledWith(
      expect.objectContaining({ scheme: 'git-log-workbench' }),
    );
  });

  it('reveals the changed line after opening a history diff', async () => {
    await new DiffManager().open('repo-1', {
      hash: 'b'.repeat(40),
      parent: 'a'.repeat(40),
      path: 'src/app.ts',
      status: 'M',
      revealLine: 12,
    });

    expect(revealRange).toHaveBeenCalledWith(
      expect.objectContaining({ startLine: 11, endLine: 11 }),
      1,
    );
  });

  it('publishes both revision URIs before opening a history diff', async () => {
    const events: string[] = [];
    executeCommand.mockImplementationOnce(() => {
      events.push('open');
    });
    const onWillOpen = vi.fn(() => events.push('retain'));

    await new DiffManager().open('repo-1', {
      hash: 'b'.repeat(40),
      parent: 'a'.repeat(40),
      path: 'src/app.ts',
      status: 'M',
      onWillOpen,
    });

    expect(events).toEqual(['retain', 'open']);
    expect(onWillOpen).toHaveBeenCalledWith(
      expect.objectContaining({ scheme: 'git-log-workbench' }),
      expect.objectContaining({ scheme: 'git-log-workbench' }),
    );
  });
});
