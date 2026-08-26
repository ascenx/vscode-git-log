import { describe, expect, it, vi } from 'vitest';
import type { EditorGitContextService } from '../../src/editor/EditorGitContextService';
import { RepositoryRegistry } from '../../src/repositories/RepositoryRegistry';

describe('EditorHistoryCommands', () => {
  it('opens file history in a dedicated editor tab without opening the bottom history view', async () => {
    const modulePath = '../../src/editor/EditorHistoryCommands';
    const commandModule = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(commandModule, 'EditorHistoryCommands must exist').toBeDefined();
    if (!commandModule) return;

    const repository = {
      id: 'repo-1',
      rootUri: 'file:///workspace/project',
      gitDirUri: 'file:///workspace/project/.git',
      displayName: 'project',
      isBare: false,
      currentBranch: 'main',
    };
    const resolve = vi.fn().mockResolvedValue({
      repository,
      repositoryRoot: '/workspace/project',
      repositoryPath: 'src/app.ts',
      absolutePath: '/workspace/project/src/app.ts',
    });
    const openHistory = vi.fn().mockResolvedValue(undefined);
    const openFileHistory = vi.fn().mockResolvedValue(undefined);
    const openLineHistory = vi.fn().mockResolvedValue(undefined);
    const showErrorMessage = vi.fn();
    const registry = new RepositoryRegistry();
    const commands = new commandModule.EditorHistoryCommands(
      { resolve } as unknown as EditorGitContextService,
      registry,
      {
        getActiveEditor: () => ({ fsPath: '/workspace/project/src/app.ts' }),
        openHistory,
        openFileHistory,
        openLineHistory,
        showErrorMessage,
      },
    );

    await commands.showFileHistory();

    expect(resolve).toHaveBeenCalledWith('/workspace/project/src/app.ts');
    expect(registry.getRoot('repo-1')).toBe('/workspace/project');
    expect(openFileHistory).toHaveBeenCalledWith({
      kind: 'file',
      repository,
      path: 'src/app.ts',
    });
    expect(openHistory).not.toHaveBeenCalled();
    expect(showErrorMessage).not.toHaveBeenCalled();
  });

  it('uses an Explorer file resource instead of the active editor', async () => {
    const { EditorHistoryCommands } = await import('../../src/editor/EditorHistoryCommands');
    const repository = {
      id: 'repo-1',
      rootUri: 'file:///workspace/project',
      gitDirUri: 'file:///workspace/project/.git',
      displayName: 'project',
      isBare: false,
      currentBranch: 'main',
    };
    const resolve = vi.fn().mockResolvedValue({
      repository,
      repositoryRoot: '/workspace/project',
      repositoryPath: 'src/explorer.ts',
      absolutePath: '/workspace/project/src/explorer.ts',
    });
    const openFileHistory = vi.fn().mockResolvedValue(undefined);
    const commands = new EditorHistoryCommands(
      { resolve } as unknown as EditorGitContextService,
      new RepositoryRegistry(),
      {
        getActiveEditor: () => ({ fsPath: '/workspace/project/src/active.ts' }),
        openHistory: vi.fn(),
        openFileHistory,
        openLineHistory: vi.fn(),
        showErrorMessage: vi.fn(),
      },
    );

    await commands.showFileHistory('/workspace/project/src/explorer.ts');

    expect(resolve).toHaveBeenCalledWith('/workspace/project/src/explorer.ts');
    expect(openFileHistory).toHaveBeenCalledWith({
      kind: 'file',
      repository,
      path: 'src/explorer.ts',
    });
  });

  it('opens an Explorer folder as a folder-history request', async () => {
    const { EditorHistoryCommands } = await import('../../src/editor/EditorHistoryCommands');
    const repository = {
      id: 'repo-1',
      rootUri: 'file:///workspace/project',
      gitDirUri: 'file:///workspace/project/.git',
      displayName: 'project',
      isBare: false,
      currentBranch: 'main',
    };
    const resolveDirectory = vi.fn().mockResolvedValue({
      repository,
      repositoryRoot: '/workspace/project',
      repositoryPath: 'src',
      absolutePath: '/workspace/project/src',
    });
    const openFolderHistory = vi.fn().mockResolvedValue(undefined);
    const commands = new EditorHistoryCommands(
      { resolve: vi.fn(), resolveDirectory } as unknown as EditorGitContextService,
      new RepositoryRegistry(),
      {
        getActiveEditor: () => undefined,
        openHistory: vi.fn(),
        openFileHistory: vi.fn(),
        openFolderHistory,
        openLineHistory: vi.fn(),
        showErrorMessage: vi.fn(),
      },
    );

    await commands.showFolderHistory('/workspace/project/src');

    expect(resolveDirectory).toHaveBeenCalledWith('/workspace/project/src');
    expect(openFolderHistory).toHaveBeenCalledWith({ repository, path: 'src' });
  });

  it('shows a clear error when there is no active local file', async () => {
    const { EditorHistoryCommands } = await import('../../src/editor/EditorHistoryCommands');
    const openHistory = vi.fn();
    const showErrorMessage = vi.fn();
    const commands = new EditorHistoryCommands(
      { resolve: vi.fn() } as unknown as EditorGitContextService,
      new RepositoryRegistry(),
      {
        getActiveEditor: () => undefined,
        openHistory,
        openFileHistory: vi.fn(),
        openLineHistory: vi.fn(),
        showErrorMessage,
      },
    );

    await commands.showFileHistory();

    expect(openHistory).not.toHaveBeenCalled();
    expect(showErrorMessage).toHaveBeenCalledWith('Open a local file before viewing its Git history.');
  });

  it('normalizes the current cursor line to a one-based line history request', async () => {
    const { EditorHistoryCommands } = await import('../../src/editor/EditorHistoryCommands');
    const repository = {
      id: 'repo-1',
      rootUri: 'file:///repo',
      gitDirUri: 'file:///repo/.git',
      displayName: 'repo',
      isBare: false,
      currentBranch: 'main',
    };
    const openHistory = vi.fn().mockResolvedValue(undefined);
    const openLineHistory = vi.fn().mockResolvedValue(undefined);
    const commands = new EditorHistoryCommands(
      {
        resolve: vi.fn().mockResolvedValue({
          repository,
          repositoryRoot: '/repo',
          repositoryPath: 'src/app.ts',
          absolutePath: '/repo/src/app.ts',
        }),
      } as unknown as EditorGitContextService,
      new RepositoryRegistry(),
      {
        getActiveEditor: () => ({
          fsPath: '/repo/src/app.ts',
          selection: { startLine: 7, startCharacter: 3, endLine: 7, endCharacter: 3 },
        }),
        openHistory,
        openFileHistory: vi.fn(),
        openLineHistory,
        showErrorMessage: vi.fn(),
      },
    );

    await commands.showLineHistory();

    expect(openLineHistory).toHaveBeenCalledWith({
      kind: 'line',
      lineScope: 'current',
      repository,
      path: 'src/app.ts',
      startLine: 8,
      endLine: 8,
    });
    expect(openHistory).not.toHaveBeenCalled();
  });

  it('excludes an empty ending line from a selection history request', async () => {
    const { EditorHistoryCommands } = await import('../../src/editor/EditorHistoryCommands');
    const repository = {
      id: 'repo-1',
      rootUri: 'file:///repo',
      gitDirUri: 'file:///repo/.git',
      displayName: 'repo',
      isBare: false,
      currentBranch: 'main',
    };
    const openHistory = vi.fn().mockResolvedValue(undefined);
    const openLineHistory = vi.fn().mockResolvedValue(undefined);
    const commands = new EditorHistoryCommands(
      {
        resolve: vi.fn().mockResolvedValue({
          repository,
          repositoryRoot: '/repo',
          repositoryPath: 'src/app.ts',
          absolutePath: '/repo/src/app.ts',
        }),
      } as unknown as EditorGitContextService,
      new RepositoryRegistry(),
      {
        getActiveEditor: () => ({
          fsPath: '/repo/src/app.ts',
          selection: { startLine: 4, startCharacter: 2, endLine: 7, endCharacter: 0 },
        }),
        openHistory,
        openFileHistory: vi.fn(),
        openLineHistory,
        showErrorMessage: vi.fn(),
      },
    );

    await commands.showSelectionHistory();

    expect(openLineHistory).toHaveBeenCalledWith({
      kind: 'line',
      lineScope: 'selection',
      repository,
      path: 'src/app.ts',
      startLine: 5,
      endLine: 7,
    });
    expect(openHistory).not.toHaveBeenCalled();
  });

  it('passes the dirty editor text snapshot to line history without saving the document', async () => {
    const { EditorHistoryCommands } = await import('../../src/editor/EditorHistoryCommands');
    const repository = {
      id: 'repo-1',
      rootUri: 'file:///repo',
      gitDirUri: 'file:///repo/.git',
      displayName: 'repo',
      isBare: false,
      currentBranch: 'main',
    };
    const openHistory = vi.fn().mockResolvedValue(undefined);
    const openLineHistory = vi.fn().mockResolvedValue(undefined);
    const commands = new EditorHistoryCommands(
      {
        resolve: vi.fn().mockResolvedValue({
          repository,
          repositoryRoot: '/repo',
          repositoryPath: 'src/app.ts',
          absolutePath: '/repo/src/app.ts',
        }),
      } as unknown as EditorGitContextService,
      new RepositoryRegistry(),
      {
        getActiveEditor: () => ({
          fsPath: '/repo/src/app.ts',
          selection: { startLine: 2, startCharacter: 0, endLine: 2, endCharacter: 0 },
          workingContent: 'inserted\nfirst\ntarget\n',
        }),
        openHistory,
        openFileHistory: vi.fn(),
        openLineHistory,
        showErrorMessage: vi.fn(),
      },
    );

    await commands.showLineHistory();

    expect(openLineHistory).toHaveBeenCalledWith({
      kind: 'line',
      lineScope: 'current',
      repository,
      path: 'src/app.ts',
      startLine: 3,
      endLine: 3,
      workingContent: 'inserted\nfirst\ntarget\n',
    });
    expect(openHistory).not.toHaveBeenCalled();
  });
});
