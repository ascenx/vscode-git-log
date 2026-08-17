import { describe, expect, it, vi } from 'vitest';
import type { DiffManager } from '../../src/diff/DiffManager';
import { nativeDiffResourceKey } from '../../src/diff/NativeDiffResources';
import type { GitService } from '../../src/git/GitService';
import { RepositoryRegistry } from '../../src/repositories/RepositoryRegistry';
import type { HistoryEntry, RepositorySummary } from '../../src/shared/models';

vi.mock('vscode', () => ({}));

const repository: RepositorySummary = {
  id: 'repo-1',
  rootUri: 'file:///repo',
  gitDirUri: 'file:///repo/.git',
  displayName: 'repo',
  isBare: false,
};

const entry: HistoryEntry = {
  hash: 'b'.repeat(40),
  parents: ['a'.repeat(40)],
  subject: 'copy file',
  authorName: 'Alice',
  authorEmail: 'alice@example.com',
  authorTime: 1,
  commitTime: 2,
  refs: [],
  path: 'src/copied.ts',
  oldPath: 'src/source.ts',
  additions: 2,
  deletions: 0,
  binary: false,
};

describe('HistoryNativeDiffOpener', () => {
  it('opens the exact history file in the built-in VS Code diff', async () => {
    const modulePath = '../../src/editor/HistoryNativeDiffOpener';
    const module = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(module, 'HistoryNativeDiffOpener must exist').toBeDefined();
    if (!module) return;
    const getChangedFiles = vi.fn().mockResolvedValue([
      { status: 'M', path: 'src/source.ts', additions: 1, deletions: 1, binary: false },
      {
        status: 'C',
        path: 'src/copied.ts',
        oldPath: 'src/source.ts',
        additions: 2,
        deletions: 0,
        binary: false,
      },
    ]);
    const original = { toString: () => 'git-log-workbench:/source.ts?side=old' };
    const modified = { toString: () => 'git-log-workbench:/copied.ts?side=new' };
    const open = vi.fn().mockImplementation((_repositoryId, request) => {
      request.onWillOpen(original, modified);
      repositories.replace([]);
      expect(repositories.getRoot('repo-1')).toBe('/repo');
      return Promise.resolve();
    });
    const repositories = new RepositoryRegistry();
    const opener = new module.HistoryNativeDiffOpener(
      { getChangedFiles } as unknown as GitService,
      { open } as unknown as DiffManager,
      repositories,
    );

    await opener.open(repository, '/repo', entry, entry.parents[0]);

    expect(repositories.getRoot('repo-1')).toBe('/repo');
    expect(open).toHaveBeenCalledWith('repo-1', {
      hash: entry.hash,
      parent: entry.parents[0],
      path: 'src/copied.ts',
      oldPath: 'src/source.ts',
      status: 'C',
      onWillOpen: expect.any(Function),
    });
    repositories.release(nativeDiffResourceKey(original as never, modified as never));
    expect(repositories.getRoot('repo-1')).toBeUndefined();
  });

  it('rejects binary history files before opening a text diff', async () => {
    const { HistoryNativeDiffOpener } = await import('../../src/editor/HistoryNativeDiffOpener');
    const open = vi.fn();
    const opener = new HistoryNativeDiffOpener(
      {
        getChangedFiles: vi.fn().mockResolvedValue([
          { status: 'M', path: 'image.png', binary: true },
        ]),
      } as unknown as GitService,
      { open } as unknown as DiffManager,
      new RepositoryRegistry(),
    );

    await expect(opener.open(repository, '/repo', { ...entry, path: 'image.png' }, entry.parents[0]))
      .rejects.toThrow('Binary files');
    expect(open).not.toHaveBeenCalled();
  });

  it('rejects a comparison parent that does not belong to the history entry', async () => {
    const { HistoryNativeDiffOpener } = await import('../../src/editor/HistoryNativeDiffOpener');
    const getChangedFiles = vi.fn();
    const open = vi.fn();
    const opener = new HistoryNativeDiffOpener(
      { getChangedFiles } as unknown as GitService,
      { open } as unknown as DiffManager,
      new RepositoryRegistry(),
    );

    await expect(opener.open(repository, '/repo', entry, 'c'.repeat(40)))
      .rejects.toThrow('not a parent');
    expect(getChangedFiles).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('does not let a slower previous request open after the latest request', async () => {
    const { HistoryNativeDiffOpener } = await import('../../src/editor/HistoryNativeDiffOpener');
    const first = { ...entry, hash: '1'.repeat(40), parents: ['0'.repeat(40)] };
    const second = { ...entry, hash: '2'.repeat(40), parents: ['1'.repeat(40)] };
    let firstSignal: AbortSignal | undefined;
    let resolveFirst: ((files: Array<{ status: 'M'; path: string; binary: false }>) => void) | undefined;
    const firstFiles = new Promise<Array<{ status: 'M'; path: string; binary: false }>>((resolve) => {
      resolveFirst = resolve;
    });
    const getChangedFiles = vi
      .fn()
      .mockImplementationOnce(
        (_cwd, _hash, _parent, signal: AbortSignal | undefined) => {
          firstSignal = signal;
          return firstFiles;
        },
      )
      .mockResolvedValueOnce([
        { status: 'M', path: second.path, binary: false },
      ]);
    const open = vi.fn().mockResolvedValue(undefined);
    const opener = new HistoryNativeDiffOpener(
      { getChangedFiles } as unknown as GitService,
      { open } as unknown as DiffManager,
      new RepositoryRegistry(),
    );

    const slowerOpen = opener.open(repository, '/repo', first, first.parents[0]);
    await vi.waitFor(() => expect(getChangedFiles).toHaveBeenCalledOnce());
    await opener.open(repository, '/repo', second, second.parents[0]);
    resolveFirst?.([{ status: 'M', path: first.path, binary: false }]);
    await slowerOpen;

    expect(firstSignal?.aborted).toBe(true);
    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith(
      repository.id,
      expect.objectContaining({ hash: second.hash }),
    );
  });

  it('serializes built-in diff opens while preserving the latest request order', async () => {
    const { HistoryNativeDiffOpener } = await import('../../src/editor/HistoryNativeDiffOpener');
    const first = { ...entry, hash: '3'.repeat(40), parents: ['2'.repeat(40)] };
    const second = { ...entry, hash: '4'.repeat(40), parents: ['3'.repeat(40)] };
    let finishFirst: (() => void) | undefined;
    let activeOpens = 0;
    let maximumActiveOpens = 0;
    const open = vi.fn().mockImplementation(async (_repositoryId, request) => {
      activeOpens += 1;
      maximumActiveOpens = Math.max(maximumActiveOpens, activeOpens);
      if (request.hash === first.hash) {
        await new Promise<void>((resolve) => {
          finishFirst = resolve;
        });
      }
      activeOpens -= 1;
    });
    const opener = new HistoryNativeDiffOpener(
      {
        getChangedFiles: vi.fn().mockResolvedValue([
          { status: 'M', path: entry.path, binary: false },
        ]),
      } as unknown as GitService,
      { open } as unknown as DiffManager,
      new RepositoryRegistry(),
    );

    const firstOpen = opener.open(repository, '/repo', first, first.parents[0]);
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    const secondOpen = opener.open(repository, '/repo', second, second.parents[0]);
    await Promise.resolve();
    expect(open).toHaveBeenCalledOnce();
    finishFirst?.();
    await Promise.all([firstOpen, secondOpen]);

    expect(maximumActiveOpens).toBe(1);
    expect(open.mock.calls.map((call) => call[1].hash)).toEqual([first.hash, second.hash]);
  });

  it('does not open a queued diff after the caller aborts the request', async () => {
    const { HistoryNativeDiffOpener } = await import('../../src/editor/HistoryNativeDiffOpener');
    let resolveFiles: ((files: Array<{ status: 'M'; path: string; binary: false }>) => void) | undefined;
    const files = new Promise<Array<{ status: 'M'; path: string; binary: false }>>((resolve) => {
      resolveFiles = resolve;
    });
    const open = vi.fn();
    const opener = new HistoryNativeDiffOpener(
      { getChangedFiles: vi.fn().mockReturnValue(files) } as unknown as GitService,
      { open } as unknown as DiffManager,
      new RepositoryRegistry(),
    );
    const abortController = new AbortController();

    const pending = opener.open(
      repository,
      '/repo',
      entry,
      entry.parents[0],
      abortController.signal,
    );
    abortController.abort();
    resolveFiles?.([{ status: 'M', path: entry.path, binary: false }]);
    await pending;

    expect(open).not.toHaveBeenCalled();
  });

  it('cancels pending work when the opener is disposed', async () => {
    const { HistoryNativeDiffOpener } = await import('../../src/editor/HistoryNativeDiffOpener');
    let signal: AbortSignal | undefined;
    let resolveFiles: ((files: Array<{ status: 'M'; path: string; binary: false }>) => void) | undefined;
    const files = new Promise<Array<{ status: 'M'; path: string; binary: false }>>((resolve) => {
      resolveFiles = resolve;
    });
    const open = vi.fn();
    const opener = new HistoryNativeDiffOpener(
      {
        getChangedFiles: vi.fn(
          (_cwd, _hash, _parent, requestSignal: AbortSignal) => {
            signal = requestSignal;
            return files;
          },
        ),
      } as unknown as GitService,
      { open } as unknown as DiffManager,
      new RepositoryRegistry(),
    );

    const pending = opener.open(repository, '/repo', entry, entry.parents[0]);
    await vi.waitFor(() => expect(signal).toBeDefined());
    opener.dispose();
    resolveFiles?.([{ status: 'M', path: entry.path, binary: false }]);
    await pending;

    expect(signal?.aborted).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });

  it('releases the repository lease when the built-in diff fails to open', async () => {
    const { HistoryNativeDiffOpener } = await import('../../src/editor/HistoryNativeDiffOpener');
    const repositories = new RepositoryRegistry();
    const original = { toString: () => 'git-log-workbench:/source.ts?side=old' };
    const modified = { toString: () => 'git-log-workbench:/copied.ts?side=new' };
    const opener = new HistoryNativeDiffOpener(
      {
        getChangedFiles: vi.fn().mockResolvedValue([
          {
            status: 'C',
            path: entry.path,
            oldPath: entry.oldPath,
            binary: false,
          },
        ]),
      } as unknown as GitService,
      {
        open: vi.fn().mockImplementation((_repositoryId, request) => {
          request.onWillOpen(original, modified);
          return Promise.reject(new Error('diff failed'));
        }),
      } as unknown as DiffManager,
      repositories,
    );

    await expect(opener.open(repository, '/repo', entry, entry.parents[0]))
      .rejects.toThrow('diff failed');
    expect(repositories.getRoot(repository.id)).toBeUndefined();
  });
});
