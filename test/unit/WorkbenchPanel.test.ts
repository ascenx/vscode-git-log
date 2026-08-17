import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  controllerDispose,
  controllerHandleMessage,
  controllerOpenHistory,
  executeCommand,
} = vi.hoisted(() => {
  return {
    controllerDispose: vi.fn(),
    controllerHandleMessage: vi.fn().mockResolvedValue(undefined),
    controllerOpenHistory: vi.fn().mockResolvedValue(undefined),
    executeCommand: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('vscode', () => ({
  commands: { executeCommand },
  Disposable: {
    from: (...disposables: Array<{ dispose(): void }>) => ({
      dispose() {
        for (const disposable of disposables) disposable.dispose();
      },
    }),
  },
  env: { clipboard: { writeText: vi.fn() } },
  ProgressLocation: { Notification: 1 },
  RelativePattern: class RelativePattern {
    constructor(
      readonly base: string,
      readonly pattern: string,
    ) {}
  },
  Uri: {
    joinPath(_base: unknown, ...parts: string[]) {
      return { toString: () => `file:///${parts.join('/')}` };
    },
  },
  window: {
    showWarningMessage: vi.fn(),
    withProgress: vi.fn(),
  },
  workspace: {
    workspaceFolders: [],
    createFileSystemWatcher: vi.fn(() => ({
      onDidCreate: vi.fn(() => ({ dispose: vi.fn() })),
      onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
      onDidDelete: vi.fn(() => ({ dispose: vi.fn() })),
      dispose: vi.fn(),
    })),
    getConfiguration: vi.fn(() => ({
      get: <T>(_key: string, fallback: T): T => fallback,
    })),
    onDidChangeWorkspaceFolders: vi.fn(() => ({ dispose: vi.fn() })),
  },
}));

vi.mock('../../src/webview/WorkbenchController', () => ({
  WorkbenchController: class WorkbenchController {
    handleMessage = controllerHandleMessage;
    openEditorHistory = controllerOpenHistory;
    dispose = controllerDispose;
    notifyRepositoryChanged = vi.fn();
    updateWorkspaceRoots = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('../../src/repositories/RepositoryWatchManager', () => ({
  RepositoryWatchManager: class RepositoryWatchManager {
    replace = vi.fn();
    dispose = vi.fn();
  },
}));

import { WorkbenchViewProvider } from '../../src/webview/WorkbenchPanel';
import type { EditorHistoryRequest } from '../../src/shared/models';

describe('WorkbenchViewProvider editor history handoff', () => {
  beforeEach(() => {
    controllerDispose.mockClear();
    controllerHandleMessage.mockClear();
    controllerOpenHistory.mockClear();
    executeCommand.mockClear();
  });

  it('keeps the latest pending history request until ready and forwards later requests immediately', async () => {
    let messageHandler: ((message: unknown) => void) | undefined;
    const webview = {
      cspSource: 'vscode-webview:',
      html: '',
      options: {},
      asWebviewUri: (uri: { toString(): string }) => uri,
      postMessage: vi.fn().mockResolvedValue(true),
      onDidReceiveMessage(handler: (message: unknown) => void) {
        messageHandler = handler;
        return { dispose: vi.fn() };
      },
    };
    const view = {
      webview,
      onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
    };
    const context = {
      extensionUri: {},
      workspaceState: {
        get: <T>(_key: string, fallback?: T): T | undefined => fallback,
        update: vi.fn().mockResolvedValue(undefined),
      },
    };
    const provider = new WorkbenchViewProvider(
      context as never,
      { appendLine: vi.fn(), show: vi.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const repository = {
      id: 'repo-1',
      rootUri: 'file:///repo',
      gitDirUri: 'file:///repo/.git',
      displayName: 'repo',
      isBare: false,
      currentBranch: 'main',
      head: 'a'.repeat(40),
    };
    const first: EditorHistoryRequest = {
      kind: 'file',
      repository,
      path: 'first.ts',
    };
    const latest: EditorHistoryRequest = {
      kind: 'line',
      repository,
      path: 'latest.ts',
      startLine: 4,
      endLine: 4,
    };

    await provider.openEditorHistory(first);
    await provider.openEditorHistory(latest);
    expect(controllerOpenHistory).not.toHaveBeenCalled();
    expect(executeCommand).toHaveBeenCalledTimes(2);

    provider.resolveWebviewView(view as never);
    messageHandler?.({ type: 'ready', requestId: 'ready-history-provider' });
    await vi.waitFor(() => expect(controllerOpenHistory).toHaveBeenCalledTimes(1));
    expect(controllerOpenHistory).toHaveBeenLastCalledWith(latest);

    const immediate: EditorHistoryRequest = {
      kind: 'file',
      repository,
      path: 'immediate.ts',
    };
    await provider.openEditorHistory(immediate);
    expect(controllerOpenHistory).toHaveBeenCalledTimes(2);
    expect(controllerOpenHistory).toHaveBeenLastCalledWith(immediate);

    provider.dispose();
    expect(controllerDispose).toHaveBeenCalledOnce();
  });
});
