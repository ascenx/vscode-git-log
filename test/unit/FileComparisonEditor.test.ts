import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiffManager } from '../../src/diff/DiffManager';
import type { WorkingSnapshotContentProvider } from '../../src/diff/WorkingSnapshotContentProvider';
import type { GitService } from '../../src/git/GitService';
import { RepositoryRegistry } from '../../src/repositories/RepositoryRegistry';

const { file } = vi.hoisted(() => ({
  file: vi.fn((path: string) => ({ scheme: 'file', fsPath: path })),
}));

vi.mock('vscode', () => ({ Uri: { file } }));

const repository = {
  id: 'repo-1',
  rootUri: 'file:///repo',
  gitDirUri: 'file:///repo/.git',
  displayName: 'repo',
  isBare: false,
  currentBranch: 'main',
};

describe('FileComparisonEditor', () => {
  beforeEach(() => {
    file.mockClear();
  });

  it('opens unsaved editor content in the native VS Code diff', async () => {
    const modulePath = '../../src/editor/FileComparisonEditor';
    const editorModule = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(editorModule, 'FileComparisonEditor must exist').toBeDefined();
    if (!editorModule) return;
    const snapshotUri = { scheme: 'git-log-workbench-working', path: '/src/app.ts', query: 'id=1' };
    const hasFileAtRevision = vi.fn().mockResolvedValue(true);
    const openWorkingFileAgainstRevision = vi.fn().mockResolvedValue(undefined);
    const create = vi.fn().mockReturnValue(snapshotUri);
    const repositories = new RepositoryRegistry();
    const editor = new editorModule.FileComparisonEditor(
      { hasFileAtRevision } as unknown as GitService,
      { openWorkingFileAgainstRevision } as unknown as DiffManager,
      { create } as unknown as WorkingSnapshotContentProvider,
      repositories,
    );

    await editor.open({
      repository,
      cwd: '/repo',
      revision: 'a'.repeat(40),
      revisionLabel: 'feature',
      path: 'src/app.ts',
      workingContent: 'unsaved editor content\n',
    });

    expect(repositories.getRoot('repo-1')).toBe('/repo');
    expect(hasFileAtRevision).toHaveBeenCalledWith(
      '/repo',
      'a'.repeat(40),
      'src/app.ts',
      expect.any(AbortSignal),
    );
    expect(create).toHaveBeenCalledWith('src/app.ts', 'unsaved editor content\n');
    expect(openWorkingFileAgainstRevision).toHaveBeenCalledWith('repo-1', {
      revision: 'a'.repeat(40),
      revisionLabel: 'feature',
      path: 'src/app.ts',
      workingFileUri: snapshotUri,
      revisionExists: true,
      forceInline: true,
      isCurrent: expect.any(Function),
      onWillOpen: expect.any(Function),
    });
    expect(file).not.toHaveBeenCalled();
  });

  it('uses the real file URI and an empty revision side for a saved new file', async () => {
    const { FileComparisonEditor } = await import('../../src/editor/FileComparisonEditor');
    const workingFileUri = { scheme: 'file', fsPath: '/repo/new.ts' };
    file.mockReturnValueOnce(workingFileUri);
    const openWorkingFileAgainstRevision = vi.fn().mockResolvedValue(undefined);
    const create = vi.fn();
    const editor = new FileComparisonEditor(
      { hasFileAtRevision: vi.fn().mockResolvedValue(false) } as unknown as GitService,
      { openWorkingFileAgainstRevision } as unknown as DiffManager,
      { create } as unknown as WorkingSnapshotContentProvider,
      new RepositoryRegistry(),
    );

    await editor.open({
      repository,
      cwd: '/repo',
      revision: 'b'.repeat(40),
      revisionLabel: 'v1',
      path: 'new.ts',
    });

    expect(file).toHaveBeenCalledWith('/repo/new.ts');
    expect(create).not.toHaveBeenCalled();
    expect(openWorkingFileAgainstRevision).toHaveBeenCalledWith('repo-1', {
      revision: 'b'.repeat(40),
      revisionLabel: 'v1',
      path: 'new.ts',
      workingFileUri,
      revisionExists: false,
      forceInline: true,
      isCurrent: expect.any(Function),
      onWillOpen: expect.any(Function),
    });
  });

  it('cancels a slower comparison and only opens the latest native diff', async () => {
    const { FileComparisonEditor } = await import('../../src/editor/FileComparisonEditor');
    let resolveFirst: ((exists: boolean) => void) | undefined;
    let firstSignal: AbortSignal | undefined;
    const firstResult = new Promise<boolean>((resolve) => {
      resolveFirst = resolve;
    });
    const hasFileAtRevision = vi
      .fn()
      .mockImplementationOnce((_cwd, _revision, _path, signal: AbortSignal) => {
        firstSignal = signal;
        return firstResult;
      })
      .mockResolvedValueOnce(true);
    const openWorkingFileAgainstRevision = vi.fn().mockResolvedValue(undefined);
    const editor = new FileComparisonEditor(
      { hasFileAtRevision } as unknown as GitService,
      { openWorkingFileAgainstRevision } as unknown as DiffManager,
      { create: vi.fn((path: string) => ({ scheme: 'snapshot', path })) } as unknown as WorkingSnapshotContentProvider,
      new RepositoryRegistry(),
    );

    const slower = editor.open({
      repository,
      cwd: '/repo',
      revision: 'a'.repeat(40),
      revisionLabel: 'old-ref',
      path: 'src/app.ts',
      workingContent: 'old snapshot\n',
    });
    await vi.waitFor(() => expect(hasFileAtRevision).toHaveBeenCalledOnce());
    await editor.open({
      repository,
      cwd: '/repo',
      revision: 'b'.repeat(40),
      revisionLabel: 'latest-ref',
      path: 'src/app.ts',
      workingContent: 'latest snapshot\n',
    });
    resolveFirst?.(true);
    await slower;

    expect(firstSignal?.aborted).toBe(true);
    expect(openWorkingFileAgainstRevision).toHaveBeenCalledOnce();
    expect(openWorkingFileAgainstRevision).toHaveBeenCalledWith(
      'repo-1',
      expect.objectContaining({ revisionLabel: 'latest-ref' }),
    );
  });

  it('serializes native diff opens so the latest request is shown last', async () => {
    const { FileComparisonEditor } = await import('../../src/editor/FileComparisonEditor');
    let resolveFirstOpen: (() => void) | undefined;
    const firstOpen = new Promise<void>((resolve) => {
      resolveFirstOpen = resolve;
    });
    const openWorkingFileAgainstRevision = vi
      .fn()
      .mockImplementationOnce(() => firstOpen)
      .mockResolvedValueOnce(undefined);
    const editor = new FileComparisonEditor(
      { hasFileAtRevision: vi.fn().mockResolvedValue(true) } as unknown as GitService,
      { openWorkingFileAgainstRevision } as unknown as DiffManager,
      { create: vi.fn((path: string) => ({ scheme: 'snapshot', path })) } as unknown as WorkingSnapshotContentProvider,
      new RepositoryRegistry(),
    );

    const first = editor.open({
      repository,
      cwd: '/repo',
      revision: 'a'.repeat(40),
      revisionLabel: 'old-ref',
      path: 'src/app.ts',
      workingContent: 'old\n',
    });
    await vi.waitFor(() => expect(openWorkingFileAgainstRevision).toHaveBeenCalledOnce());
    const latest = editor.open({
      repository,
      cwd: '/repo',
      revision: 'b'.repeat(40),
      revisionLabel: 'latest-ref',
      path: 'src/app.ts',
      workingContent: 'latest\n',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(openWorkingFileAgainstRevision).toHaveBeenCalledOnce();

    resolveFirstOpen?.();
    await Promise.all([first, latest]);

    expect(openWorkingFileAgainstRevision).toHaveBeenCalledTimes(2);
    expect(openWorkingFileAgainstRevision.mock.calls.map((call) => call[1].revisionLabel)).toEqual([
      'old-ref',
      'latest-ref',
    ]);
    expect(openWorkingFileAgainstRevision.mock.calls[0]?.[1].isCurrent()).toBe(false);
    expect(openWorkingFileAgainstRevision.mock.calls[1]?.[1].isCurrent()).toBe(true);
  });

  it('re-registers the repository immediately before the native diff opens', async () => {
    const { FileComparisonEditor } = await import('../../src/editor/FileComparisonEditor');
    const repositories = new RepositoryRegistry();
    const openWorkingFileAgainstRevision = vi.fn().mockImplementation((_repositoryId, request) => {
      request.onWillOpen({
        toString: () => 'git-log-workbench:/app.ts?repositoryId=repo-1',
      });
      repositories.replace([]);
      expect(repositories.getRoot('repo-1')).toBe('/repo');
    });
    const editor = new FileComparisonEditor(
      {
        hasFileAtRevision: vi.fn().mockResolvedValue(true),
      } as unknown as GitService,
      { openWorkingFileAgainstRevision } as unknown as DiffManager,
      { create: vi.fn((path: string) => ({ scheme: 'snapshot', path })) } as unknown as WorkingSnapshotContentProvider,
      repositories,
    );

    await editor.open({
      repository,
      cwd: '/repo',
      revision: 'a'.repeat(40),
      revisionLabel: 'feature',
      path: 'src/app.ts',
      workingContent: 'working\n',
    });

    expect(openWorkingFileAgainstRevision).toHaveBeenCalledOnce();
  });

  it('releases an unsaved snapshot when the native diff fails to open', async () => {
    const { FileComparisonEditor } = await import('../../src/editor/FileComparisonEditor');
    const snapshotUri = { scheme: 'snapshot', path: '/src/app.ts', query: 'id=1' };
    const release = vi.fn();
    const repositories = new RepositoryRegistry();
    const editor = new FileComparisonEditor(
      { hasFileAtRevision: vi.fn().mockResolvedValue(true) } as unknown as GitService,
      {
        openWorkingFileAgainstRevision: vi.fn().mockImplementation((_repositoryId, request) => {
          request.onWillOpen({ toString: () => 'git-log-workbench:/app.ts?repositoryId=repo-1' });
          return Promise.reject(new Error('open failed'));
        }),
      } as unknown as DiffManager,
      {
        create: vi.fn().mockReturnValue(snapshotUri),
        release,
      } as unknown as WorkingSnapshotContentProvider,
      repositories,
    );

    await expect(editor.open({
      repository,
      cwd: '/repo',
      revision: 'a'.repeat(40),
      revisionLabel: 'feature',
      path: 'src/app.ts',
      workingContent: 'working\n',
    })).rejects.toThrow('open failed');

    expect(release).toHaveBeenCalledWith(snapshotUri);
    repositories.replace([]);
    expect(repositories.getRoot('repo-1')).toBeUndefined();
  });
});
