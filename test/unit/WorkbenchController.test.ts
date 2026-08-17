import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitCommandError, GitRunner } from '../../src/git/GitRunner';
import { FileHistoryService } from '../../src/git/FileHistoryService';
import { GitService } from '../../src/git/GitService';
import {
  getOperationConfirmation,
  GitOperationService,
  type GitOperationRunOptions,
} from '../../src/git/GitOperationService';
import type { LogQuery } from '../../src/git/GitService';
import type { CommitSummary, RepositorySummary } from '../../src/shared/models';
import type {
  ExtensionToWebviewMessage,
  GitOperationRequest,
  PersistedWorkbenchState,
} from '../../src/protocol/messages';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function createRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), 'git-log-workbench-controller-'));
  temporaryDirectories.push(repository);
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: repository });
  await writeFile(join(repository, 'app.txt'), 'hello\n');
  await execFileAsync('git', ['add', 'app.txt'], { cwd: repository });
  await execFileAsync('git', ['commit', '-m', 'first commit'], {
    cwd: repository,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Alice',
      GIT_AUTHOR_EMAIL: 'alice@example.com',
      GIT_COMMITTER_NAME: 'Alice',
      GIT_COMMITTER_EMAIL: 'alice@example.com',
    },
  });
  return repository;
}

describe('WorkbenchController', () => {
  it('confirms a successful clipboard write back to the webview', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const copyToClipboard = vi.fn().mockResolvedValue(undefined);
    const controller = new (await import('../../src/webview/WorkbenchController')).WorkbenchController({
      workspaceRoots: [],
      gitService: new GitService(new GitRunner()),
      gitRunner: new GitRunner(),
      scanDepth: 0,
      initialPageSize: 200,
      pageSize: 500,
      initialLayout: {
        refsWidth: 220,
        filesWidth: 320,
        detailsHeight: 156,
        filesViewMode: 'tree',
      },
      postMessage(message: ExtensionToWebviewMessage) {
        messages.push(message);
        return Promise.resolve(true);
      },
      persistLayout: () => Promise.resolve(),
      copyToClipboard,
    });

    await controller.handleMessage({
      type: 'copyToClipboard',
      requestId: 'copy-details-hash',
      text: 'a'.repeat(40),
    });

    expect(copyToClipboard).toHaveBeenCalledWith('a'.repeat(40));
    expect(messages).toContainEqual({
      type: 'clipboardCopied',
      requestId: 'copy-details-hash',
    });
  });

  it('loads an empty repository without reporting a Git revision error', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'git-log-workbench-empty-controller-'));
    temporaryDirectories.push(repository);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repository });
    const messages: ExtensionToWebviewMessage[] = [];
    const runner = new GitRunner();
    const controller = new (await import('../../src/webview/WorkbenchController')).WorkbenchController({
      workspaceRoots: [repository],
      gitService: new GitService(runner),
      gitRunner: runner,
      scanDepth: 0,
      initialPageSize: 200,
      pageSize: 500,
      initialLayout: {
        refsWidth: 220,
        filesWidth: 320,
        detailsHeight: 156,
        filesViewMode: 'tree',
      },
      postMessage(message: ExtensionToWebviewMessage) {
        messages.push(message);
        return Promise.resolve(true);
      },
      persistLayout: () => Promise.resolve(),
    });

    await controller.handleMessage({ type: 'ready', requestId: 'ready-empty-repository' });

    expect(messages.find((message) => message.type === 'error')).toBeUndefined();
    expect(messages.find((message) => message.type === 'repositoryData')).toMatchObject({
      type: 'repositoryData',
      commits: [],
      replace: true,
      hasMore: false,
    });
  });

  it('opens file history in an empty repository as a clear empty state', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'git-log-workbench-empty-history-'));
    temporaryDirectories.push(repository);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repository });
    await writeFile(join(repository, 'untracked.txt'), 'new file\n');
    const messages: ExtensionToWebviewMessage[] = [];
    const runner = new GitRunner();
    const getFileHistory = vi.fn();
    const controller = new (await import('../../src/webview/WorkbenchController')).WorkbenchController({
      workspaceRoots: [repository],
      gitService: new GitService(runner),
      fileHistoryService: { getFileHistory } as unknown as FileHistoryService,
      gitRunner: runner,
      scanDepth: 0,
      initialPageSize: 200,
      pageSize: 500,
      initialLayout: {
        refsWidth: 220,
        filesWidth: 320,
        detailsHeight: 156,
        filesViewMode: 'tree',
      },
      postMessage(message: ExtensionToWebviewMessage) {
        messages.push(message);
        return Promise.resolve(true);
      },
      persistLayout: () => Promise.resolve(),
    });
    await controller.handleMessage({ type: 'ready', requestId: 'ready-empty-history' });
    const initialized = messages.find((message) => message.type === 'initialize');
    expect(initialized?.type).toBe('initialize');
    if (!initialized || initialized.type !== 'initialize') return;
    const targetRepository = initialized.repositories[0];
    expect(targetRepository).toBeDefined();
    if (!targetRepository) return;

    await controller.openEditorHistory({
      kind: 'file',
      repository: targetRepository,
      path: 'untracked.txt',
    });

    expect(getFileHistory).not.toHaveBeenCalled();
    expect(messages.filter((message) => message.type === 'historyOpened').at(-1)).toMatchObject({
      type: 'historyOpened',
      kind: 'file',
      entries: [],
      replace: true,
      hasMore: false,
      notice: 'This repository has no commits yet.',
    });
  });

  it('initializes repositories and loads commit details on selection', async () => {
    const modulePath = '../../src/webview/WorkbenchController';
    const controllerModule = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(controllerModule, 'WorkbenchController must exist').toBeDefined();
    if (!controllerModule) return;

    const repository = await createRepository();
    const messages: ExtensionToWebviewMessage[] = [];
    const openFile = vi.fn().mockResolvedValue(undefined);
    const controller = new controllerModule.WorkbenchController({
      workspaceRoots: [repository],
      gitService: new GitService(new GitRunner()),
      gitRunner: new GitRunner(),
      scanDepth: 2,
      initialPageSize: 200,
      pageSize: 500,
      initialLayout: {
        refsWidth: 220,
        filesWidth: 320,
        detailsHeight: 156,
        filesViewMode: 'tree',
      },
      postMessage(message: ExtensionToWebviewMessage) {
        messages.push(message);
        return Promise.resolve(true);
      },
      persistLayout() {
        return Promise.resolve();
      },
      openFile,
    });

    await controller.handleMessage({ type: 'ready', requestId: 'ready-1' });

    const initialize = messages.find((message) => message.type === 'initialize');
    const repositoryData = messages.find((message) => message.type === 'repositoryData');
    expect(initialize).toMatchObject({ type: 'initialize', requestId: 'ready-1', pageSize: 500 });
    expect(repositoryData).toMatchObject({ type: 'repositoryData', replace: true, hasMore: false });
    if (!repositoryData || repositoryData.type !== 'repositoryData') return;
    expect(repositoryData.commits).toHaveLength(1);
    const commit = repositoryData.commits[0];
    expect(commit).toBeDefined();
    if (!commit) return;

    await controller.handleMessage({
      type: 'selectCommit',
      requestId: 'selection-1',
      repositoryId: repositoryData.repositoryId,
      hash: commit.hash,
    });

    expect(messages.at(-1)).toMatchObject({
      type: 'selectionDetailsLoaded',
      requestId: 'selection-1',
      details: { subject: 'first commit' },
      files: [expect.objectContaining({ status: 'A', path: 'app.txt', additions: 1 })],
    });

    await controller.handleMessage({
      type: 'openFile',
      requestId: 'open-file-1',
      repositoryId: repositoryData.repositoryId,
      hash: commit.hash,
      path: 'app.txt',
      status: 'A',
      mode: 'revision',
    });
    expect(openFile).toHaveBeenCalledWith(
      expect.objectContaining({ id: repositoryData.repositoryId }),
      expect.objectContaining({ type: 'openFile', path: 'app.txt', mode: 'revision' }),
    );

    await controller.handleMessage({
      type: 'updateFilters',
      requestId: 'filter-1',
      repositoryId: repositoryData.repositoryId,
      filters: {
        text: 'does-not-match',
        branches: [],
        authors: [],
        paths: [],
      },
    });

    expect(messages.at(-1)).toMatchObject({
      type: 'repositoryData',
      requestId: 'filter-1',
      commits: [],
      filters: { text: 'does-not-match' },
      replace: true,
    });
  });

  it('restores filters and the selected commit independently for each repository', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'git-log-workbench-controller-multi-'));
    temporaryDirectories.push(workspace);
    const firstRepository = join(workspace, 'first');
    const secondRepository = join(workspace, 'second');
    await execFileAsync('git', ['init', '-b', 'main', firstRepository]);
    await execFileAsync('git', ['init', '-b', 'main', secondRepository]);
    for (const repository of [firstRepository, secondRepository]) {
      await writeFile(join(repository, 'app.txt'), `${repository}\n`);
      await execFileAsync('git', ['add', 'app.txt'], { cwd: repository });
      await execFileAsync('git', ['commit', '-m', `commit ${repository}`], {
        cwd: repository,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Alice',
          GIT_AUTHOR_EMAIL: 'alice@example.com',
          GIT_COMMITTER_NAME: 'Alice',
          GIT_COMMITTER_EMAIL: 'alice@example.com',
        },
      });
    }

    const messages: ExtensionToWebviewMessage[] = [];
    const controller = new (await import('../../src/webview/WorkbenchController')).WorkbenchController({
      workspaceRoots: [workspace],
      gitService: new GitService(new GitRunner()),
      gitRunner: new GitRunner(),
      scanDepth: 1,
      initialPageSize: 200,
      pageSize: 500,
      initialLayout: {
        refsWidth: 220,
        filesWidth: 320,
        detailsHeight: 156,
        filesViewMode: 'tree',
      },
      postMessage(message: ExtensionToWebviewMessage) {
        messages.push(message);
        return Promise.resolve(true);
      },
      persistLayout() {
        return Promise.resolve();
      },
    });

    await controller.handleMessage({ type: 'ready', requestId: 'ready-multi' });
    const initialized = messages.find((message) => message.type === 'initialize');
    expect(initialized?.type).toBe('initialize');
    if (!initialized || initialized.type !== 'initialize') return;
    const first = initialized.repositories[0];
    const second = initialized.repositories[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (!first || !second) return;
    const firstData = messages.find(
      (message) => message.type === 'repositoryData' && message.repositoryId === first.id,
    );
    expect(firstData?.type).toBe('repositoryData');
    if (!firstData || firstData.type !== 'repositoryData') return;
    const firstHash = firstData.commits[0]?.hash;
    expect(firstHash).toBeDefined();
    if (!firstHash) return;

    await controller.handleMessage({
      type: 'selectCommit',
      requestId: 'select-first',
      repositoryId: first.id,
      hash: firstHash,
    });
    await controller.handleMessage({
      type: 'updateFilters',
      requestId: 'filter-first',
      repositoryId: first.id,
      filters: { text: 'commit', branches: [], authors: [], paths: [] },
    });
    await controller.handleMessage({
      type: 'selectRepository',
      requestId: 'switch-second',
      repositoryId: second.id,
    });
    await controller.handleMessage({
      type: 'selectRepository',
      requestId: 'switch-first',
      repositoryId: first.id,
    });

    const restored = [...messages]
      .reverse()
      .find(
        (message) =>
          message.type === 'repositoryData' &&
          message.repositoryId === first.id &&
          message.requestId === 'switch-first',
      );
    expect(restored).toMatchObject({
      type: 'repositoryData',
      filters: { text: 'commit' },
      selectedHash: firstHash,
    });
  });

  it('does not let an older filter persistence delay abort a newer same-repository query', async () => {
    const repository = await createRepository();
    const messages: ExtensionToWebviewMessage[] = [];
    let releaseSlow: (() => void) | undefined;
    let markSlowStarted: (() => void) | undefined;
    const slowStarted = new Promise<void>((resolve) => {
      markSlowStarted = resolve;
    });
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const controller = new (await import('../../src/webview/WorkbenchController')).WorkbenchController({
      workspaceRoots: [repository],
      gitService: new GitService(new GitRunner()),
      gitRunner: new GitRunner(),
      scanDepth: 2,
      initialPageSize: 200,
      pageSize: 500,
      initialLayout: { refsWidth: 220, filesWidth: 320, detailsHeight: 156, filesViewMode: 'tree' },
      postMessage: (message) => {
        messages.push(message);
        return Promise.resolve(true);
      },
      persistLayout: () => Promise.resolve(),
      persistState: async (state) => {
        if (Object.values(state.repositories).some(({ filters }) => filters.text === 'slow')) {
          markSlowStarted?.();
          await slowGate;
        }
      },
    });
    await controller.handleMessage({ type: 'ready', requestId: 'ready-filter-order' });
    const initialized = messages.find((message) => message.type === 'initialize');
    const repositoryId = initialized?.type === 'initialize' ? initialized.selectedRepositoryId : undefined;
    expect(repositoryId).toBeDefined();
    if (!repositoryId) return;

    const slow = controller.handleMessage({
      type: 'updateFilters',
      requestId: 'slow-filter-order',
      repositoryId,
      filters: { text: 'slow', branches: [], authors: [], paths: [] },
    });
    await slowStarted;
    await controller.handleMessage({
      type: 'updateFilters',
      requestId: 'fast-filter-order',
      repositoryId,
      filters: { text: 'fast', branches: [], authors: [], paths: [] },
    });
    releaseSlow?.();
    await slow;

    expect(
      messages.filter(
        (message) => message.type === 'repositoryData' && message.requestId === 'slow-filter-order',
      ),
    ).toHaveLength(0);
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: 'repositoryData',
        requestId: 'fast-filter-order',
        filters: expect.objectContaining({ text: 'fast' }),
      }),
    );
  });

  it('rejects remote deletion targets that are absent from the repository ref snapshot', async () => {
    const repository = await createRepository();
    const messages: ExtensionToWebviewMessage[] = [];
    const runOperation = vi.fn();
    const controller = new (await import('../../src/webview/WorkbenchController')).WorkbenchController({
      workspaceRoots: [repository],
      gitService: new GitService(new GitRunner()),
      gitRunner: new GitRunner(),
      scanDepth: 2,
      initialPageSize: 200,
      pageSize: 500,
      initialLayout: { refsWidth: 220, filesWidth: 320, detailsHeight: 156, filesViewMode: 'tree' },
      postMessage: (message) => {
        messages.push(message);
        return Promise.resolve(true);
      },
      persistLayout: () => Promise.resolve(),
      operationService: { run: runOperation },
    });
    await controller.handleMessage({ type: 'ready', requestId: 'ready-delete-validation' });
    const initialized = messages.find((message) => message.type === 'initialize');
    const repositoryId = initialized?.type === 'initialize' ? initialized.selectedRepositoryId : undefined;
    expect(repositoryId).toBeDefined();
    if (!repositoryId) return;

    await controller.handleMessage({
      type: 'runOperation',
      requestId: 'forged-delete-remote',
      repositoryId,
      operation: { kind: 'deleteRemoteBranch', remote: 'origin', branch: 'feature' },
    });

    expect(runOperation).not.toHaveBeenCalled();
    expect(messages.at(-1)).toMatchObject({ type: 'error', requestId: 'forged-delete-remote' });
  });

  it('ignores an older workspace initialization that finishes after a newer one', async () => {
    const firstRepository = await createRepository();
    const secondRepository = await createRepository();
    let releaseFirst: (() => void) | undefined;
    let markFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const realRunner = new GitRunner();
    let delayed = false;
    const runner = {
      async run(args: readonly string[], options: Parameters<GitRunner['run']>[1]) {
        if (!delayed && options.cwd === firstRepository) {
          delayed = true;
          markFirstStarted?.();
          await firstGate;
        }
        return realRunner.run(args, options);
      },
    } as GitRunner;
    const messages: ExtensionToWebviewMessage[] = [];
    const controller = new (await import('../../src/webview/WorkbenchController')).WorkbenchController({
      workspaceRoots: [firstRepository],
      gitService: new GitService(runner),
      gitRunner: runner,
      scanDepth: 2,
      initialPageSize: 200,
      pageSize: 500,
      initialLayout: { refsWidth: 220, filesWidth: 320, detailsHeight: 156, filesViewMode: 'tree' },
      postMessage: (message) => {
        messages.push(message);
        return Promise.resolve(true);
      },
      persistLayout: () => Promise.resolve(),
    });

    const older = controller.handleMessage({ type: 'ready', requestId: 'older-initialize' });
    await firstStarted;
    await controller.updateWorkspaceRoots([secondRepository]);
    releaseFirst?.();
    await older;

    const initializeMessages = messages.filter((message) => message.type === 'initialize');
    expect(initializeMessages.at(-1)).toMatchObject({
      type: 'initialize',
      repositories: [expect.objectContaining({ rootUri: expect.stringContaining(secondRepository) })],
    });
    expect(initializeMessages.some((message) => message.requestId === 'older-initialize')).toBe(false);
  });

  it('does not let a delayed repository-selection acknowledgement reverse a newer selection', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'git-log-workbench-selection-order-'));
    temporaryDirectories.push(workspace);
    const firstRepository = join(workspace, 'first');
    const secondRepository = join(workspace, 'second');
    await execFileAsync('git', ['init', '-b', 'main', firstRepository]);
    await execFileAsync('git', ['init', '-b', 'main', secondRepository]);
    const messages: ExtensionToWebviewMessage[] = [];
    let delaySelections = false;
    let releaseSecondPersist: (() => void) | undefined;
    let secondPersistStarted: (() => void) | undefined;
    const secondPersistGate = new Promise<void>((resolve) => {
      releaseSecondPersist = resolve;
    });
    const secondPersistStartedPromise = new Promise<void>((resolve) => {
      secondPersistStarted = resolve;
    });
    let secondId = '';
    const controller = new (await import('../../src/webview/WorkbenchController')).WorkbenchController({
      workspaceRoots: [workspace],
      gitService: new GitService(new GitRunner()),
      gitRunner: new GitRunner(),
      scanDepth: 1,
      initialPageSize: 200,
      pageSize: 500,
      initialLayout: {
        refsWidth: 220,
        filesWidth: 320,
        detailsHeight: 156,
        filesViewMode: 'tree',
      },
      postMessage(message: ExtensionToWebviewMessage) {
        messages.push(message);
        return Promise.resolve(true);
      },
      persistLayout: () => Promise.resolve(),
      persistState(state: PersistedWorkbenchState) {
        if (delaySelections && state.selectedRepositoryId === secondId) {
          secondPersistStarted?.();
          return secondPersistGate;
        }
        return Promise.resolve();
      },
    });
    await controller.handleMessage({ type: 'ready', requestId: 'ready-selection-order' });
    const initialized = messages.find((message) => message.type === 'initialize');
    expect(initialized?.type).toBe('initialize');
    if (!initialized || initialized.type !== 'initialize') return;
    const first = initialized.repositories[0];
    const second = initialized.repositories[1];
    if (!first || !second) return;
    secondId = second.id;
    delaySelections = true;

    const selectSecond = controller.handleMessage({
      type: 'selectRepository',
      requestId: 'select-second-slow',
      repositoryId: second.id,
    });
    await secondPersistStartedPromise;
    await controller.handleMessage({
      type: 'selectRepository',
      requestId: 'select-first-newer',
      repositoryId: first.id,
    });
    releaseSecondPersist?.();
    await selectSecond;

    expect(messages.filter((message) => message.type === 'repositoriesUpdated').at(-1)).toMatchObject({
      requestId: 'select-first-newer',
      selectedRepositoryId: first.id,
    });
    expect(messages.filter((message) => message.type === 'repositoryData').at(-1)).toMatchObject({
      requestId: 'select-first-newer',
      repositoryId: first.id,
    });
  });

  it('restores persisted repository, filters, and selected commit after reopening the panel', async () => {
    const repository = await createRepository();
    const firstMessages: ExtensionToWebviewMessage[] = [];
    let persistedState: PersistedWorkbenchState | undefined;
    const createController = async (
      messages: ExtensionToWebviewMessage[],
      initialState?: PersistedWorkbenchState,
    ) =>
      new (await import('../../src/webview/WorkbenchController')).WorkbenchController({
        workspaceRoots: [repository],
        gitService: new GitService(new GitRunner()),
        gitRunner: new GitRunner(),
        scanDepth: 0,
        initialPageSize: 200,
        pageSize: 500,
        initialLayout: {
          refsWidth: 220,
          filesWidth: 320,
          detailsHeight: 156,
          filesViewMode: 'tree',
        },
        ...(initialState ? { initialState } : {}),
        postMessage(message: ExtensionToWebviewMessage) {
          messages.push(message);
          return Promise.resolve(true);
        },
        persistLayout: () => Promise.resolve(),
        persistState(state: PersistedWorkbenchState) {
          persistedState = state;
          return Promise.resolve();
        },
      });

    const first = await createController(firstMessages);
    await first.handleMessage({ type: 'ready', requestId: 'ready-persist-first' });
    const data = firstMessages.find((message) => message.type === 'repositoryData');
    expect(data?.type).toBe('repositoryData');
    if (!data || data.type !== 'repositoryData' || !data.commits[0]) return;
    await first.handleMessage({
      type: 'selectCommit',
      requestId: 'persist-selection',
      repositoryId: data.repositoryId,
      hash: data.commits[0].hash,
    });
    await first.handleMessage({
      type: 'updateFilters',
      requestId: 'persist-filter',
      repositoryId: data.repositoryId,
      filters: { text: 'first', branches: [], authors: [], paths: [] },
    });
    expect(persistedState).toBeDefined();
    if (!persistedState) return;

    const reopenedMessages: ExtensionToWebviewMessage[] = [];
    const reopened = await createController(reopenedMessages, persistedState);
    await reopened.handleMessage({ type: 'ready', requestId: 'ready-persist-reopen' });
    const restored = reopenedMessages.find(
      (message) => message.type === 'repositoryData' && message.requestId === 'ready-persist-reopen',
    );
    expect(restored).toMatchObject({
      type: 'repositoryData',
      repositoryId: data.repositoryId,
      filters: { text: 'first' },
      selectedHash: data.commits[0].hash,
    });
  });

  it('loads enough history to restore a deep selected commit and workspace scroll anchor', async () => {
    const repository = await createRepository();
    const commits = Array.from({ length: 5400 }, (_, index): CommitSummary => {
      const hash = (index + 1).toString(16).padStart(40, '0');
      const parent = (index + 2).toString(16).padStart(40, '0');
      return {
        hash,
        parents: index < 5399 ? [parent] : [],
        subject: `commit ${String(index)}`,
        authorName: 'Alice',
        authorEmail: 'alice@example.com',
        authorTime: 1_700_000_000 - index,
        commitTime: 1_700_000_000 - index,
        refs: [],
      };
    });
    const getLog = vi.fn((_cwd: string, query: LogQuery) =>
      Promise.resolve(commits.slice(query.skip, query.skip + query.limit)),
    );
    const fakeService = {
      getRefs: () => Promise.resolve([]),
      getLog,
      getCommitDetails: (_cwd: string, hash: string) => {
        const commit = commits.find((candidate) => candidate.hash === hash);
        if (!commit) return Promise.reject(new Error(`Unknown commit ${hash}`));
        return Promise.resolve({
          ...commit,
          body: `${commit.subject}\n`,
          committerName: commit.authorName,
          committerEmail: commit.authorEmail,
          signature: 'none' as const,
        });
      },
      getChangedFiles: () => Promise.resolve([]),
    } as unknown as GitService;
    let persistedState: PersistedWorkbenchState | undefined;
    const createController = async (
      messages: ExtensionToWebviewMessage[],
      initialState?: PersistedWorkbenchState,
    ) =>
      new (await import('../../src/webview/WorkbenchController')).WorkbenchController({
        workspaceRoots: [repository],
        gitService: fakeService,
        gitRunner: new GitRunner(),
        scanDepth: 0,
        initialPageSize: 200,
        pageSize: 500,
        maxCachedCommits: 5000,
        initialLayout: {
          refsWidth: 220,
          filesWidth: 320,
          detailsHeight: 156,
          filesViewMode: 'tree',
        },
        ...(initialState ? { initialState } : {}),
        postMessage(message: ExtensionToWebviewMessage) {
          messages.push(message);
          return Promise.resolve(true);
        },
        persistLayout: () => Promise.resolve(),
        persistState(state: PersistedWorkbenchState) {
          persistedState = state;
          return Promise.resolve();
        },
      } as never);

    const firstMessages: ExtensionToWebviewMessage[] = [];
    const first = await createController(firstMessages);
    await first.handleMessage({ type: 'ready', requestId: 'ready-deep-first' });
    const initialized = firstMessages.find((message) => message.type === 'initialize');
    expect(initialized?.type).toBe('initialize');
    if (!initialized || initialized.type !== 'initialize' || !initialized.selectedRepositoryId) return;
    const selected = commits[5200];
    expect(selected).toBeDefined();
    if (!selected) return;
    const graphContinuation = {
      lanes: [{ id: 2, target: selected.hash, colorIndex: 3 }],
      nextLaneId: 4,
      nextColorIndex: 5,
    };
    await first.handleMessage({
      type: 'selectCommit',
      requestId: 'select-deep-commit',
      repositoryId: initialized.selectedRepositoryId,
      hash: selected.hash,
    });
    await first.handleMessage({
      type: 'updateScrollAnchor',
      requestId: 'persist-deep-scroll',
      repositoryId: initialized.selectedRepositoryId,
      scrollTop: 200 * 28,
      logOffset: 5000,
      graphContinuation,
    } as never);
    expect(persistedState).toBeDefined();
    if (!persistedState) return;

    getLog.mockClear();
    const reopenedMessages: ExtensionToWebviewMessage[] = [];
    const reopened = await createController(reopenedMessages, persistedState);
    await reopened.handleMessage({ type: 'ready', requestId: 'ready-deep-reopen' });

    expect(getLog.mock.calls.map(([, query]) => ({ limit: query.limit, skip: query.skip }))).toEqual([
      { limit: 400, skip: 5000 },
    ]);
    expect(persistedState.repositories[initialized.selectedRepositoryId]).toMatchObject({
      logOffset: 5000,
      graphContinuation,
    });
    expect(reopenedMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'repositoryData',
          repositoryId: initialized.selectedRepositoryId,
          selectedHash: selected.hash,
          scrollTop: 200 * 28,
          startLogOffset: 5000,
          graphContinuation,
        }),
        expect.objectContaining({
          type: 'selectionDetailsLoaded',
          repositoryId: initialized.selectedRepositoryId,
          details: expect.objectContaining({ hash: selected.hash }),
        }),
      ]),
    );
  });

  it('does not publish a stale log response after a newer filter query wins', async () => {
    const repository = await createRepository();
    const messages: ExtensionToWebviewMessage[] = [];
    let resolveSlow: ((commits: CommitSummary[]) => void) | undefined;
    let slowStarted: (() => void) | undefined;
    const slowStartedPromise = new Promise<void>((resolve) => {
      slowStarted = resolve;
    });
    const slowPromise = new Promise<CommitSummary[]>((resolve) => {
      resolveSlow = resolve;
    });
    const commit = (subject: string, hashCharacter: string): CommitSummary => ({
      hash: hashCharacter.repeat(40),
      parents: [],
      subject,
      authorName: 'Alice',
      authorEmail: 'alice@example.com',
      authorTime: 1_700_000_000,
      commitTime: 1_700_000_000,
      refs: [],
    });
    const initialCommit = commit('initial', 'a');
    const fastCommit = commit('fast result', 'b');
    const staleCommit = commit('stale result', 'c');
    const fakeService = {
      getRefs: () => Promise.resolve([]),
      getLog: (_cwd: string, query: LogQuery) => {
        if (query.filters?.text === 'slow') {
          slowStarted?.();
          return slowPromise;
        }
        return Promise.resolve(query.filters?.text === 'fast' ? [fastCommit] : [initialCommit]);
      },
    } as unknown as GitService;
    const controller = new (await import('../../src/webview/WorkbenchController')).WorkbenchController({
      workspaceRoots: [repository],
      gitService: fakeService,
      gitRunner: new GitRunner(),
      scanDepth: 0,
      initialPageSize: 200,
      pageSize: 500,
      initialLayout: {
        refsWidth: 220,
        filesWidth: 320,
        detailsHeight: 156,
        filesViewMode: 'tree',
      },
      postMessage(message: ExtensionToWebviewMessage) {
        messages.push(message);
        return Promise.resolve(true);
      },
      persistLayout: () => Promise.resolve(),
    });
    await controller.handleMessage({ type: 'ready', requestId: 'ready-race' });
    const initialized = messages.find((message) => message.type === 'initialize');
    expect(initialized?.type).toBe('initialize');
    if (!initialized || initialized.type !== 'initialize' || !initialized.selectedRepositoryId) return;
    const repositoryId = initialized.selectedRepositoryId;
    messages.length = 0;

    const slowRequest = controller.handleMessage({
      type: 'updateFilters',
      requestId: 'slow',
      repositoryId,
      filters: { text: 'slow', branches: [], authors: [], paths: [] },
    });
    await slowStartedPromise;
    await controller.handleMessage({
      type: 'updateFilters',
      requestId: 'fast',
      repositoryId,
      filters: { text: 'fast', branches: [], authors: [], paths: [] },
    });
    resolveSlow?.([staleCommit]);
    await slowRequest;

    const dataMessages = messages.filter((message) => message.type === 'repositoryData');
    expect(dataMessages).toHaveLength(1);
    expect(dataMessages[0]).toMatchObject({
      requestId: 'fast',
      commits: [{ subject: 'fast result' }],
    });
  });

  it('does not publish selection details or run a selection-bound operation after switching repositories', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'git-log-workbench-selection-race-'));
    temporaryDirectories.push(workspace);
    const firstRepository = join(workspace, 'first');
    const secondRepository = join(workspace, 'second');
    await execFileAsync('git', ['init', '-b', 'main', firstRepository]);
    await execFileAsync('git', ['init', '-b', 'main', secondRepository]);

    const firstHash = 'a'.repeat(40);
    const secondHash = 'b'.repeat(40);
    let resolveDetails: ((details: Awaited<ReturnType<GitService['getCommitDetails']>>) => void) | undefined;
    let detailsStarted: (() => void) | undefined;
    const detailsStartedPromise = new Promise<void>((resolve) => {
      detailsStarted = resolve;
    });
    const detailsPromise = new Promise<Awaited<ReturnType<GitService['getCommitDetails']>>>((resolve) => {
      resolveDetails = resolve;
    });
    const commit = (hash: string, subject: string): CommitSummary => ({
      hash,
      parents: [],
      subject,
      authorName: 'Alice',
      authorEmail: 'alice@example.com',
      authorTime: 1_700_000_000,
      commitTime: 1_700_000_000,
      refs: [],
    });
    const getLog = vi.fn((cwd: string) =>
      Promise.resolve([cwd === firstRepository ? commit(firstHash, 'first') : commit(secondHash, 'second')]),
    );
    const fakeService = {
      getRefs: () => Promise.resolve([]),
      getLog,
      getCommitDetails: () => {
        detailsStarted?.();
        return detailsPromise;
      },
      getChangedFiles: () => Promise.resolve([]),
    } as unknown as GitService;
    const messages: ExtensionToWebviewMessage[] = [];
    const run = vi.fn().mockResolvedValue({ message: 'completed.' });
    const controller = new (await import('../../src/webview/WorkbenchController')).WorkbenchController({
      workspaceRoots: [workspace],
      gitService: fakeService,
      gitRunner: new GitRunner(),
      operationService: { run } as never,
      scanDepth: 1,
      initialPageSize: 200,
      pageSize: 500,
      initialLayout: {
        refsWidth: 220,
        filesWidth: 320,
        detailsHeight: 156,
        filesViewMode: 'tree',
      },
      postMessage(message: ExtensionToWebviewMessage) {
        messages.push(message);
        return Promise.resolve(true);
      },
      persistLayout: () => Promise.resolve(),
    });

    await controller.handleMessage({ type: 'ready', requestId: 'ready-selection-race' });
    const initialized = messages.find((message) => message.type === 'initialize');
    expect(initialized?.type).toBe('initialize');
    if (!initialized || initialized.type !== 'initialize') return;
    const first = initialized.repositories.find((repository) => repository.rootUri.endsWith('/first'));
    const second = initialized.repositories.find((repository) => repository.rootUri.endsWith('/second'));
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (!first || !second) return;

    const selection = controller.handleMessage({
      type: 'selectCommit',
      requestId: 'select-first-slow',
      repositoryId: first.id,
      hash: firstHash,
    });
    await detailsStartedPromise;
    await controller.handleMessage({
      type: 'selectRepository',
      requestId: 'switch-to-second',
      repositoryId: second.id,
    });
    resolveDetails?.({
      ...commit(firstHash, 'first'),
      body: 'first\n',
      committerName: 'Alice',
      committerEmail: 'alice@example.com',
      signature: 'none',
    });
    await selection;

    expect(
      messages.some(
        (message) =>
          message.type === 'selectionDetailsLoaded' && message.requestId === 'select-first-slow',
      ),
    ).toBe(false);

    await controller.handleMessage({
      type: 'runOperation',
      requestId: 'stale-operation',
      repositoryId: first.id,
      operation: { kind: 'cherryPick', hash: firstHash },
    });
    expect(run).not.toHaveBeenCalled();
    expect(messages.at(-1)).toMatchObject({
      type: 'error',
      requestId: 'stale-operation',
      repositoryId: first.id,
    });

    const logCallsAfterSwitch = getLog.mock.calls.length;
    await controller.handleMessage({
      type: 'requestLogPage',
      requestId: 'stale-page',
      repositoryId: first.id,
      skip: 200,
    });
    await controller.handleMessage({
      type: 'updateFilters',
      requestId: 'stale-filter',
      repositoryId: first.id,
      filters: { text: 'stale', branches: [], authors: [], paths: [] },
    });
    expect(getLog).toHaveBeenCalledTimes(logCallsAfterSwitch);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'error',
          requestId: 'stale-page',
          repositoryId: first.id,
        }),
        expect.objectContaining({
          type: 'error',
          requestId: 'stale-filter',
          repositoryId: first.id,
        }),
      ]),
    );
  });

  it('confirms destructive operations, reports progress, and refreshes after completion', async () => {
    const repository = await createRepository();
    const messages: ExtensionToWebviewMessage[] = [];
    const run = vi.fn(async (
      candidate: RepositorySummary,
      operation: GitOperationRequest,
      options: GitOperationRunOptions,
    ) => {
      const confirmation = getOperationConfirmation(candidate, operation);
      if (confirmation && options.confirm && !(await options.confirm(confirmation))) {
        return { message: '', cancelled: true };
      }
      return { message: 'checkout completed.' };
    });
    const confirmOperation = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    let progressCalls = 0;
    const withProgress = async <T>(_title: string, task: () => Promise<T>): Promise<T> => {
      progressCalls += 1;
      return task();
    };
    const controller = new (await import('../../src/webview/WorkbenchController')).WorkbenchController({
      workspaceRoots: [repository],
      gitService: new GitService(new GitRunner()),
      gitRunner: new GitRunner(),
      operationService: { run } as never,
      confirmOperation,
      withProgress,
      scanDepth: 0,
      initialPageSize: 200,
      pageSize: 500,
      initialLayout: {
        refsWidth: 220,
        filesWidth: 320,
        detailsHeight: 156,
        filesViewMode: 'tree',
      },
      postMessage(message: ExtensionToWebviewMessage) {
        messages.push(message);
        return Promise.resolve(true);
      },
      persistLayout: () => Promise.resolve(),
    });
    await controller.handleMessage({ type: 'ready', requestId: 'ready-operation' });
    const initialized = messages.find((message) => message.type === 'initialize');
    expect(initialized?.type).toBe('initialize');
    if (!initialized || initialized.type !== 'initialize' || !initialized.selectedRepositoryId) return;
    const repositoryId = initialized.selectedRepositoryId;
    const repositoryDataCount = messages.filter((message) => message.type === 'repositoryData').length;

    await controller.handleMessage({
      type: 'runOperation',
      requestId: 'cancel-hard-reset',
      repositoryId,
      operation: { kind: 'reset', mode: 'hard', hash: 'a'.repeat(40) },
    });
    expect(run).toHaveBeenCalledOnce();
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: 'operationCancelled',
        requestId: 'cancel-hard-reset',
        repositoryId,
      }),
    );

    await controller.handleMessage({
      type: 'runOperation',
      requestId: 'run-hard-reset',
      repositoryId,
      operation: { kind: 'reset', mode: 'hard', hash: 'a'.repeat(40) },
    });

    expect(confirmOperation).toHaveBeenCalledTimes(2);
    expect(progressCalls).toBe(2);
    expect(run).toHaveBeenCalledTimes(2);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'loading',
          requestId: 'run-hard-reset',
          repositoryId,
          scope: 'operation',
        }),
        expect.objectContaining({
          type: 'operationCompleted',
          requestId: 'run-hard-reset',
          message: 'checkout completed.',
        }),
      ]),
    );
    expect(messages.filter((message) => message.type === 'repositoryData').length).toBe(
      repositoryDataCount + 1,
    );
    const operationRefresh = messages
      .filter((message) => message.type === 'repositoryData')
      .at(-1);
    expect(operationRefresh).toMatchObject({
      type: 'repositoryData',
      requestId: 'run-hard-reset-refresh',
    });
  });

  it('delegates force-push preparation and confirmation to the serialized operation service', async () => {
    const repository = await createRepository();
    const messages: ExtensionToWebviewMessage[] = [];
    const run = vi.fn(async (
      _candidate: RepositorySummary,
      _operation: GitOperationRequest,
      options: GitOperationRunOptions,
    ) => {
      if (options.confirm) {
        await options.confirm({
          title: 'Force push with lease?',
          detail: 'Rewrite origin/refs/heads/main',
          confirmLabel: 'Force Push with Lease',
          destructive: true,
        });
      }
      return { message: 'push completed.' };
    });
    const confirmOperation = vi.fn().mockResolvedValue(true);
    const controller = new (await import('../../src/webview/WorkbenchController')).WorkbenchController({
      workspaceRoots: [repository],
      gitService: new GitService(new GitRunner()),
      gitRunner: new GitRunner(),
      operationService: { run } as never,
      confirmOperation,
      scanDepth: 0,
      initialPageSize: 200,
      pageSize: 500,
      initialLayout: {
        refsWidth: 220,
        filesWidth: 320,
        detailsHeight: 156,
        filesViewMode: 'tree',
      },
      postMessage(message: ExtensionToWebviewMessage) {
        messages.push(message);
        return Promise.resolve(true);
      },
      persistLayout: () => Promise.resolve(),
    });
    await controller.handleMessage({ type: 'ready', requestId: 'ready-force-push' });
    const initialized = messages.find((message) => message.type === 'initialize');
    expect(initialized?.type).toBe('initialize');
    if (!initialized || initialized.type !== 'initialize' || !initialized.selectedRepositoryId) return;

    await controller.handleMessage({
      type: 'runOperation',
      requestId: 'force-push',
      repositoryId: initialized.selectedRepositoryId,
      operation: { kind: 'push', forceWithLease: true },
    });

    expect(confirmOperation).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.stringContaining('origin/refs/heads/main') }),
    );
    expect(run).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        kind: 'push',
        forceWithLease: true,
      }),
      expect.objectContaining({ confirm: expect.any(Function) }),
    );
  });

  it('caps each appended page to the Webview commit-cache capacity', async () => {
    const repository = await createRepository();
    for (let index = 0; index < 7; index += 1) {
      await execFileAsync('git', ['commit', '--allow-empty', '-m', `commit ${String(index)}`], {
        cwd: repository,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Alice',
          GIT_AUTHOR_EMAIL: 'alice@example.com',
          GIT_COMMITTER_NAME: 'Alice',
          GIT_COMMITTER_EMAIL: 'alice@example.com',
        },
      });
    }
    const messages: ExtensionToWebviewMessage[] = [];
    const runner = new GitRunner();
    const controller = new (await import('../../src/webview/WorkbenchController')).WorkbenchController({
      workspaceRoots: [repository],
      gitService: new GitService(runner),
      gitRunner: runner,
      scanDepth: 0,
      initialPageSize: 2,
      pageSize: 5,
      maxCachedCommits: 3,
      initialLayout: {
        refsWidth: 220,
        filesWidth: 320,
        detailsHeight: 156,
        filesViewMode: 'tree',
      },
      postMessage(message: ExtensionToWebviewMessage) {
        messages.push(message);
        return Promise.resolve(true);
      },
      persistLayout: () => Promise.resolve(),
    });

    await controller.handleMessage({ type: 'ready', requestId: 'ready-page-cap' });
    const initialized = messages.find((message) => message.type === 'initialize');
    if (!initialized || initialized.type !== 'initialize' || !initialized.selectedRepositoryId) return;
    await controller.handleMessage({
      type: 'requestLogPage',
      requestId: 'page-cap',
      repositoryId: initialized.selectedRepositoryId,
      skip: 2,
    });

    const appended = messages.find(
      (message) => message.type === 'repositoryData' && message.requestId === 'page-cap',
    );
    expect(appended).toMatchObject({ type: 'repositoryData', replace: false });
    if (!appended || appended.type !== 'repositoryData') return;
    expect(appended.commits).toHaveLength(3);
  });

  it('opens a file-list comparison for the selected commit and parent', async () => {
    const repository = await createRepository();
    await writeFile(join(repository, 'app.txt'), 'hello\nsecond\n');
    await execFileAsync('git', ['add', 'app.txt'], { cwd: repository });
    await execFileAsync('git', ['commit', '-m', 'second commit'], {
      cwd: repository,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Alice',
        GIT_AUTHOR_EMAIL: 'alice@example.com',
        GIT_COMMITTER_NAME: 'Alice',
        GIT_COMMITTER_EMAIL: 'alice@example.com',
      },
    });
    const messages: ExtensionToWebviewMessage[] = [];
    const openCommitComparison = vi.fn().mockResolvedValue(undefined);
    const controller = new (await import('../../src/webview/WorkbenchController')).WorkbenchController({
      workspaceRoots: [repository],
      gitService: new GitService(new GitRunner()),
      gitRunner: new GitRunner(),
      scanDepth: 0,
      initialPageSize: 200,
      pageSize: 500,
      initialLayout: {
        refsWidth: 220,
        filesWidth: 320,
        detailsHeight: 156,
        filesViewMode: 'tree',
      },
      postMessage(message: ExtensionToWebviewMessage) {
        messages.push(message);
        return Promise.resolve(true);
      },
      persistLayout: () => Promise.resolve(),
      openCommitComparison,
    } as never);
    await controller.handleMessage({ type: 'ready', requestId: 'ready-compare' });
    const data = messages.find((message) => message.type === 'repositoryData');
    expect(data?.type).toBe('repositoryData');
    if (!data || data.type !== 'repositoryData' || !data.commits[0]) return;
    const hash = data.commits[0].hash;
    await controller.handleMessage({
      type: 'selectCommit',
      requestId: 'select-compare',
      repositoryId: data.repositoryId,
      hash,
    });
    await controller.handleMessage({
      type: 'openCommitComparison',
      requestId: 'compare-parent',
      repositoryId: data.repositoryId,
      hash,
      mode: 'parent',
    } as never);

    expect(openCommitComparison).toHaveBeenCalledWith(
      expect.objectContaining({ id: data.repositoryId }),
      expect.objectContaining({ hash }),
      expect.arrayContaining([expect.objectContaining({ path: 'app.txt' })]),
    );
  });

  it('coalesces watcher refreshes while a Git operation is active', async () => {
    const repository = await createRepository();
    const messages: ExtensionToWebviewMessage[] = [];
    let finishOperation: (() => void) | undefined;
    let operationStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      operationStarted = resolve;
    });
    const operation = new Promise<void>((resolve) => {
      finishOperation = resolve;
    });
    const controller = new (await import('../../src/webview/WorkbenchController')).WorkbenchController({
      workspaceRoots: [repository],
      gitService: new GitService(new GitRunner()),
      gitRunner: new GitRunner(),
      operationService: {
        async run() {
          operationStarted?.();
          await operation;
          return { message: 'fetch completed.' };
        },
      } as never,
      scanDepth: 0,
      initialPageSize: 200,
      pageSize: 500,
      initialLayout: {
        refsWidth: 220,
        filesWidth: 320,
        detailsHeight: 156,
        filesViewMode: 'tree',
      },
      postMessage(message: ExtensionToWebviewMessage) {
        messages.push(message);
        return Promise.resolve(true);
      },
      persistLayout: () => Promise.resolve(),
    });
    await controller.handleMessage({ type: 'ready', requestId: 'ready-watcher-operation' });
    const initialized = messages.find((message) => message.type === 'initialize');
    expect(initialized?.type).toBe('initialize');
    if (!initialized || initialized.type !== 'initialize' || !initialized.selectedRepositoryId) return;
    const repositoryId = initialized.selectedRepositoryId;
    const initialDataCount = messages.filter((message) => message.type === 'repositoryData').length;

    const run = controller.handleMessage({
      type: 'runOperation',
      requestId: 'long-fetch',
      repositoryId,
      operation: { kind: 'fetch' },
    });
    await started;
    await controller.notifyRepositoryChanged(repositoryId);
    await controller.notifyRepositoryChanged(repositoryId);
    expect(messages.filter((message) => message.type === 'repositoryData')).toHaveLength(initialDataCount);

    finishOperation?.();
    await run;
    expect(messages.filter((message) => message.type === 'repositoryData')).toHaveLength(
      initialDataCount + 1,
    );
  });

  it('refreshes active file history after a Git operation completes', async () => {
    const repository = await createRepository();
    const messages: ExtensionToWebviewMessage[] = [];
    const runner = new GitRunner();
    const controller = new (await import('../../src/webview/WorkbenchController')).WorkbenchController({
      workspaceRoots: [repository],
      gitService: new GitService(runner),
      fileHistoryService: new FileHistoryService(runner),
      gitRunner: runner,
      operationService: {
        async run() {
          await writeFile(join(repository, 'app.txt'), 'hello\nfrom operation\n');
          await execFileAsync('git', ['add', 'app.txt'], { cwd: repository });
          await execFileAsync('git', ['commit', '-m', 'operation commit'], {
            cwd: repository,
            env: {
              ...process.env,
              GIT_AUTHOR_NAME: 'Alice',
              GIT_AUTHOR_EMAIL: 'alice@example.com',
              GIT_COMMITTER_NAME: 'Alice',
              GIT_COMMITTER_EMAIL: 'alice@example.com',
            },
          });
          return { message: 'fetch completed.' };
        },
      } as never,
      scanDepth: 0,
      initialPageSize: 200,
      pageSize: 500,
      initialLayout: {
        refsWidth: 220,
        filesWidth: 320,
        detailsHeight: 156,
        filesViewMode: 'tree',
      },
      postMessage(message: ExtensionToWebviewMessage) {
        messages.push(message);
        return Promise.resolve(true);
      },
      persistLayout: () => Promise.resolve(),
    });
    await controller.handleMessage({ type: 'ready', requestId: 'ready-history-operation' });
    const initialized = messages.find((message) => message.type === 'initialize');
    expect(initialized?.type).toBe('initialize');
    if (!initialized || initialized.type !== 'initialize' || !initialized.selectedRepositoryId) return;
    const targetRepository = initialized.repositories.find(
      (candidate) => candidate.id === initialized.selectedRepositoryId,
    );
    expect(targetRepository).toBeDefined();
    if (!targetRepository) return;

    await controller.openEditorHistory({
      kind: 'file',
      repository: targetRepository,
      path: 'app.txt',
    });
    const historyCount = messages.filter((message) => message.type === 'historyOpened').length;

    await controller.handleMessage({
      type: 'runOperation',
      requestId: 'history-operation',
      repositoryId: targetRepository.id,
      operation: { kind: 'fetch' },
    });

    const histories = messages.filter((message) => message.type === 'historyOpened');
    expect(histories).toHaveLength(historyCount + 1);
    expect(histories.at(-1)).toMatchObject({
      type: 'historyOpened',
      kind: 'file',
      replace: true,
      entries: expect.arrayContaining([
        expect.objectContaining({ subject: 'operation commit' }),
      ]),
    });
  });

  it('coalesces watcher refreshes across linked worktrees by their common Git directory', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'git-log-workbench-linked-watchers-'));
    temporaryDirectories.push(workspace);
    const mainWorktree = join(workspace, 'main');
    const linkedWorktree = join(workspace, 'linked');
    await execFileAsync('git', ['init', '-b', 'main', mainWorktree]);
    await execFileAsync('git', ['commit', '--allow-empty', '-m', 'base'], {
      cwd: mainWorktree,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Alice',
        GIT_AUTHOR_EMAIL: 'alice@example.com',
        GIT_COMMITTER_NAME: 'Alice',
        GIT_COMMITTER_EMAIL: 'alice@example.com',
      },
    });
    await execFileAsync('git', ['worktree', 'add', '-b', 'linked', linkedWorktree], {
      cwd: mainWorktree,
    });

    let finishOperation: (() => void) | undefined;
    let operationStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      operationStarted = resolve;
    });
    const operation = new Promise<void>((resolve) => {
      finishOperation = resolve;
    });
    const messages: ExtensionToWebviewMessage[] = [];
    const controller = new (await import('../../src/webview/WorkbenchController')).WorkbenchController({
      workspaceRoots: [mainWorktree, linkedWorktree],
      gitService: new GitService(new GitRunner()),
      gitRunner: new GitRunner(),
      operationService: {
        async run() {
          operationStarted?.();
          await operation;
          return { message: 'fetch completed.' };
        },
      } as never,
      scanDepth: 0,
      initialPageSize: 200,
      pageSize: 500,
      initialLayout: {
        refsWidth: 220,
        filesWidth: 320,
        detailsHeight: 156,
        filesViewMode: 'tree',
      },
      postMessage(message: ExtensionToWebviewMessage) {
        messages.push(message);
        return Promise.resolve(true);
      },
      persistLayout: () => Promise.resolve(),
    });
    await controller.handleMessage({ type: 'ready', requestId: 'ready-linked-watchers' });
    const initialized = messages.find((message) => message.type === 'initialize');
    expect(initialized?.type).toBe('initialize');
    if (!initialized || initialized.type !== 'initialize' || !initialized.selectedRepositoryId) return;
    const operationRepository = initialized.repositories.find(
      (repository) => repository.id === initialized.selectedRepositoryId,
    );
    const selectedWorktree = initialized.repositories.find(
      (repository) => repository.id !== initialized.selectedRepositoryId,
    );
    expect(operationRepository?.commonGitDirUri).toBe(selectedWorktree?.commonGitDirUri);
    if (!operationRepository || !selectedWorktree) return;

    const run = controller.handleMessage({
      type: 'runOperation',
      requestId: 'linked-operation',
      repositoryId: operationRepository.id,
      operation: { kind: 'fetch' },
    });
    await started;
    await controller.handleMessage({
      type: 'selectRepository',
      requestId: 'select-linked-worktree',
      repositoryId: selectedWorktree.id,
    });
    const countAfterSelection = messages.filter((message) => message.type === 'repositoryData').length;
    await controller.notifyRepositoryChanged(selectedWorktree.id);
    expect(messages.filter((message) => message.type === 'repositoryData')).toHaveLength(
      countAfterSelection,
    );

    finishOperation?.();
    await run;
    const repositoryData = messages.filter((message) => message.type === 'repositoryData');
    expect(repositoryData).toHaveLength(countAfterSelection + 1);
    expect(repositoryData.at(-1)).toMatchObject({ repositoryId: selectedWorktree.id });
  });

  it('does not switch back to an operation repository after the user selects another repository', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'git-log-workbench-operation-switch-'));
    temporaryDirectories.push(workspace);
    const firstRepository = join(workspace, 'first');
    const secondRepository = join(workspace, 'second');
    for (const repository of [firstRepository, secondRepository]) {
      await execFileAsync('git', ['init', '-b', 'main', repository]);
      await execFileAsync('git', ['commit', '--allow-empty', '-m', 'base'], {
        cwd: repository,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Alice',
          GIT_AUTHOR_EMAIL: 'alice@example.com',
          GIT_COMMITTER_NAME: 'Alice',
          GIT_COMMITTER_EMAIL: 'alice@example.com',
        },
      });
    }
    await execFileAsync('git', ['branch', 'feature'], { cwd: firstRepository });
    let finishOperation: (() => void) | undefined;
    let operationStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      operationStarted = resolve;
    });
    const operation = new Promise<void>((resolve) => {
      finishOperation = resolve;
    });
    const messages: ExtensionToWebviewMessage[] = [];
    const controller = new (await import('../../src/webview/WorkbenchController')).WorkbenchController({
      workspaceRoots: [workspace],
      gitService: new GitService(new GitRunner()),
      gitRunner: new GitRunner(),
      operationService: {
        async run() {
          operationStarted?.();
          await operation;
          await execFileAsync('git', ['checkout', 'feature'], { cwd: firstRepository });
          return { message: 'checkout completed.' };
        },
      } as never,
      scanDepth: 1,
      initialPageSize: 200,
      pageSize: 500,
      initialLayout: {
        refsWidth: 220,
        filesWidth: 320,
        detailsHeight: 156,
        filesViewMode: 'tree',
      },
      postMessage(message: ExtensionToWebviewMessage) {
        messages.push(message);
        return Promise.resolve(true);
      },
      persistLayout: () => Promise.resolve(),
    });
    await controller.handleMessage({ type: 'ready', requestId: 'ready-operation-switch' });
    const initialized = messages.find((message) => message.type === 'initialize');
    expect(initialized?.type).toBe('initialize');
    if (!initialized || initialized.type !== 'initialize') return;
    const first = initialized.repositories[0];
    const second = initialized.repositories[1];
    if (!first || !second) return;

    const run = controller.handleMessage({
      type: 'runOperation',
      requestId: 'operation-first',
      repositoryId: first.id,
      operation: { kind: 'checkout', ref: 'feature' },
    });
    await started;
    await controller.handleMessage({
      type: 'selectRepository',
      requestId: 'switch-second-during-operation',
      repositoryId: second.id,
    });
    finishOperation?.();
    await run;

    const lastRepositoryUpdate = messages
      .filter((message) => message.type === 'repositoriesUpdated')
      .at(-1);
    expect(lastRepositoryUpdate).toMatchObject({ selectedRepositoryId: second.id });
    const lastData = messages.filter((message) => message.type === 'repositoryData').at(-1);
    expect(lastData).toMatchObject({ repositoryId: second.id });

    await controller.handleMessage({
      type: 'selectRepository',
      requestId: 'switch-back-to-first',
      repositoryId: first.id,
    });
    const refreshedFirst = messages
      .filter((message) => message.type === 'repositoriesUpdated')
      .at(-1);
    expect(refreshedFirst).toMatchObject({
      selectedRepositoryId: first.id,
      repositories: expect.arrayContaining([
        expect.objectContaining({ id: first.id, currentBranch: 'feature' }),
      ]),
    });
  });

  it('re-inspects the repository and follows the new HEAD after checkout', async () => {
    const repository = await createRepository();
    const commitEnvironment = {
      ...process.env,
      GIT_AUTHOR_NAME: 'Alice',
      GIT_AUTHOR_EMAIL: 'alice@example.com',
      GIT_COMMITTER_NAME: 'Alice',
      GIT_COMMITTER_EMAIL: 'alice@example.com',
    };
    await execFileAsync('git', ['switch', '-c', 'feature'], { cwd: repository });
    await writeFile(join(repository, 'feature.txt'), 'feature\n');
    await execFileAsync('git', ['add', 'feature.txt'], { cwd: repository });
    await execFileAsync('git', ['commit', '-m', 'feature commit'], {
      cwd: repository,
      env: commitEnvironment,
    });
    const featureHash = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim();
    await execFileAsync('git', ['switch', 'main'], { cwd: repository });
    await writeFile(join(repository, 'main.txt'), 'main\n');
    await execFileAsync('git', ['add', 'main.txt'], { cwd: repository });
    await execFileAsync('git', ['commit', '-m', 'main commit'], {
      cwd: repository,
      env: commitEnvironment,
    });
    const mainHash = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim();
    const messages: ExtensionToWebviewMessage[] = [];
    const runner = new GitRunner();
    const controller = new (await import('../../src/webview/WorkbenchController')).WorkbenchController({
      workspaceRoots: [repository],
      gitService: new GitService(runner),
      gitRunner: runner,
      operationService: new GitOperationService(runner),
      scanDepth: 0,
      initialPageSize: 200,
      pageSize: 500,
      initialLayout: {
        refsWidth: 220,
        filesWidth: 320,
        detailsHeight: 156,
        filesViewMode: 'tree',
      },
      postMessage(message: ExtensionToWebviewMessage) {
        messages.push(message);
        return Promise.resolve(true);
      },
      persistLayout: () => Promise.resolve(),
    });
    await controller.handleMessage({ type: 'ready', requestId: 'ready-checkout' });
    const initialized = messages.find((message) => message.type === 'initialize');
    expect(initialized?.type).toBe('initialize');
    if (!initialized || initialized.type !== 'initialize' || !initialized.selectedRepositoryId) return;
    await controller.handleMessage({
      type: 'selectCommit',
      requestId: 'select-main-before-checkout',
      repositoryId: initialized.selectedRepositoryId,
      hash: mainHash,
    });
    await controller.handleMessage({
      type: 'updateScrollAnchor',
      requestId: 'scroll-main-before-checkout',
      repositoryId: initialized.selectedRepositoryId,
      scrollTop: 84,
      logOffset: 1,
    });

    await controller.handleMessage({
      type: 'runOperation',
      requestId: 'checkout-feature',
      repositoryId: initialized.selectedRepositoryId,
      operation: { kind: 'checkout', ref: 'feature' },
    });

    const repositoryUpdate = (messages as unknown as Array<Record<string, unknown>>)
      .filter((message) => message.type === 'repositoriesUpdated')
      .at(-1);
    expect(repositoryUpdate).toMatchObject({
      repositories: [expect.objectContaining({ currentBranch: 'feature', head: featureHash })],
    });
    const refreshedLog = messages
      .filter(
        (message) =>
          message.type === 'repositoryData' && message.requestId === 'checkout-feature-refresh',
      )
      .at(-1);
    expect(refreshedLog).toMatchObject({
      selectedHash: featureHash,
      scrollTop: 0,
      startLogOffset: 0,
      replace: true,
    });
    if (!refreshedLog || refreshedLog.type !== 'repositoryData') return;
    expect(refreshedLog.commits.map((commit) => commit.hash)).toContain(featureHash);
    expect(refreshedLog.commits.map((commit) => commit.hash)).not.toContain(mainHash);
    expect(messages.at(-2)).toMatchObject({
      type: 'selectionDetailsLoaded',
      requestId: 'checkout-feature-refresh',
      details: { hash: featureHash, subject: 'feature commit' },
    });
  });

  it('opens file history without replacing normal log state and opens the selected file diff', async () => {
    const repository = await createRepository();
    await writeFile(join(repository, 'app.txt'), 'hello\nsecond\n');
    await execFileAsync('git', ['add', 'app.txt'], { cwd: repository });
    await execFileAsync('git', ['commit', '-m', 'second file change'], {
      cwd: repository,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Alice',
        GIT_AUTHOR_EMAIL: 'alice@example.com',
        GIT_COMMITTER_NAME: 'Alice',
        GIT_COMMITTER_EMAIL: 'alice@example.com',
      },
    });
    const runner = new GitRunner();
    const gitService = new GitService(runner);
    const messages: ExtensionToWebviewMessage[] = [];
    const openDiff = vi.fn().mockResolvedValue(undefined);
    const controller = new (await import('../../src/webview/WorkbenchController')).WorkbenchController({
      workspaceRoots: [repository],
      gitService,
      fileHistoryService: new FileHistoryService(runner),
      gitRunner: runner,
      scanDepth: 0,
      initialPageSize: 200,
      pageSize: 500,
      initialLayout: { refsWidth: 220, filesWidth: 320, detailsHeight: 156, filesViewMode: 'tree' },
      postMessage(message: ExtensionToWebviewMessage) {
        messages.push(message);
        return Promise.resolve(true);
      },
      persistLayout: () => Promise.resolve(),
      openDiff,
    });
    await controller.handleMessage({ type: 'ready', requestId: 'ready-history' });
    const initialized = messages.find((message) => message.type === 'initialize');
    expect(initialized?.type).toBe('initialize');
    if (!initialized || initialized.type !== 'initialize') return;
    const targetRepository = initialized.repositories[0];
    expect(targetRepository).toBeDefined();
    if (!targetRepository) return;
    const normalData = messages.find((message) => message.type === 'repositoryData');

    await controller.openEditorHistory({
      kind: 'file',
      repository: targetRepository,
      path: 'app.txt',
    });

    const history = messages.filter((message) => message.type === 'historyOpened').at(-1);
    expect(history).toMatchObject({
      type: 'historyOpened',
      kind: 'file',
      path: 'app.txt',
      replace: true,
      entries: [
        expect.objectContaining({ subject: 'second file change', additions: 1, deletions: 0 }),
        expect.objectContaining({ subject: 'first commit', additions: 1, deletions: 0 }),
      ],
    });
    expect(messages.find((message) => message.type === 'repositoryData')).toBe(normalData);
    if (!history || history.type !== 'historyOpened') return;
    const selected = history.entries[0];
    expect(selected).toBeDefined();
    if (!selected) return;
    await controller.handleMessage({
      type: 'openHistoryDiff',
      requestId: 'history-diff',
      repositoryId: targetRepository.id,
      hash: selected.hash,
    });
    expect(openDiff).toHaveBeenCalledWith(
      expect.objectContaining({ id: targetRepository.id }),
      expect.objectContaining({ path: 'app.txt', hash: selected.hash, status: 'M' }),
    );

    await controller.updateWorkspaceRoots([]);
    expect(messages.filter((message) => message.type === 'historyClosed').at(-1)).toMatchObject({
      type: 'historyClosed',
      repositoryId: targetRepository.id,
      reason: 'The repository for this editor history is no longer available.',
    });
  });

  it('opens mapped line history and reports a purely uncommitted line', async () => {
    const repository = await createRepository();
    await writeFile(join(repository, 'app.txt'), 'HELLO\n');
    await execFileAsync('git', ['add', 'app.txt'], { cwd: repository });
    await execFileAsync('git', ['commit', '-m', 'update line'], {
      cwd: repository,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Alice',
        GIT_AUTHOR_EMAIL: 'alice@example.com',
        GIT_COMMITTER_NAME: 'Alice',
        GIT_COMMITTER_EMAIL: 'alice@example.com',
      },
    });
    await writeFile(join(repository, 'app.txt'), 'uncommitted\nHELLO\n');
    const runner = new GitRunner();
    const messages: ExtensionToWebviewMessage[] = [];
    const controller = new (await import('../../src/webview/WorkbenchController')).WorkbenchController({
      workspaceRoots: [repository],
      gitService: new GitService(runner),
      fileHistoryService: new FileHistoryService(runner),
      gitRunner: runner,
      scanDepth: 0,
      initialPageSize: 200,
      pageSize: 500,
      initialLayout: { refsWidth: 220, filesWidth: 320, detailsHeight: 156, filesViewMode: 'tree' },
      postMessage(message: ExtensionToWebviewMessage) {
        messages.push(message);
        return Promise.resolve(true);
      },
      persistLayout: () => Promise.resolve(),
    });
    await controller.handleMessage({ type: 'ready', requestId: 'ready-line-history' });
    const initialized = messages.find((message) => message.type === 'initialize');
    expect(initialized?.type).toBe('initialize');
    if (!initialized || initialized.type !== 'initialize') return;
    const targetRepository = initialized.repositories[0];
    expect(targetRepository).toBeDefined();
    if (!targetRepository) return;

    await controller.openEditorHistory({
      kind: 'line',
      repository: targetRepository,
      path: 'app.txt',
      startLine: 2,
      endLine: 2,
    });

    expect(messages.filter((message) => message.type === 'historyOpened').at(-1)).toMatchObject({
      type: 'historyOpened',
      kind: 'line',
      path: 'app.txt',
      startLine: 2,
      endLine: 2,
      replace: true,
      hasMore: false,
      entries: [
        expect.objectContaining({ subject: 'update line', additions: 1, deletions: 1 }),
        expect.objectContaining({ subject: 'first commit', additions: 1, deletions: 0 }),
      ],
    });

    await controller.openEditorHistory({
      kind: 'line',
      repository: targetRepository,
      path: 'app.txt',
      startLine: 1,
      endLine: 1,
    });

    expect(messages.filter((message) => message.type === 'historyOpened').at(-1)).toMatchObject({
      type: 'historyOpened',
      kind: 'line',
      entries: [],
      notice: 'This line has no committed history yet.',
      replace: true,
      hasMore: false,
    });

    await controller.handleMessage({
      type: 'switchHistoryToFile',
      requestId: 'line-history-file-fallback',
      repositoryId: targetRepository.id,
    });
    expect(messages.filter((message) => message.type === 'historyOpened').at(-1)).toMatchObject({
      type: 'historyOpened',
      kind: 'file',
      path: 'app.txt',
      entries: expect.arrayContaining([expect.objectContaining({ subject: 'update line' })]),
      replace: true,
    });
  });

  it('reports partial and discontinuous worktree line mappings without merging unrelated lines', async () => {
    const hash = 'a'.repeat(40);
    const repository: RepositorySummary = {
      id: 'repo-line-mapping-notices',
      rootUri: 'file:///repo',
      gitDirUri: 'file:///repo/.git',
      displayName: 'repo',
      isBare: false,
      currentBranch: 'main',
      head: hash,
    };
    const messages: ExtensionToWebviewMessage[] = [];
    const resolveHeadLineRange = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'mapped',
        startLine: 4,
        endLine: 5,
        partiallyUncommitted: true,
      })
      .mockResolvedValueOnce({ status: 'discontinuous' });
    const getLineHistory = vi.fn().mockResolvedValue({
      entries: [
        {
          hash,
          parents: [],
          subject: 'committed part',
          authorName: 'Alice',
          authorEmail: 'alice@example.com',
          authorTime: 1,
          commitTime: 1,
          refs: [],
          path: 'src/app.ts',
          additions: 1,
          deletions: 1,
          binary: false,
          linePatch: '@@ -4 +4 @@\n-old\n+new\n',
        },
      ],
      truncated: false,
    });
    const controller = new (await import('../../src/webview/WorkbenchController')).WorkbenchController({
      workspaceRoots: [],
      gitService: { getRefs: vi.fn().mockResolvedValue([]) } as unknown as GitService,
      fileHistoryService: {
        resolveHeadLineRange,
        getLineHistory,
      } as unknown as FileHistoryService,
      gitRunner: {} as GitRunner,
      scanDepth: 0,
      initialPageSize: 200,
      pageSize: 500,
      initialLayout: { refsWidth: 220, filesWidth: 320, detailsHeight: 156, filesViewMode: 'tree' },
      postMessage(message: ExtensionToWebviewMessage) {
        messages.push(message);
        return Promise.resolve(true);
      },
      persistLayout: () => Promise.resolve(),
    });

    await controller.openEditorHistory({
      kind: 'line',
      repository,
      path: 'src/app.ts',
      startLine: 4,
      endLine: 6,
    });
    expect(messages.filter((message) => message.type === 'historyOpened').at(-1)).toMatchObject({
      entries: [expect.objectContaining({ subject: 'committed part' })],
      notice:
        'Part of the selection has not been committed; showing history for the committed lines.',
    });
    const opened = messages.filter((message) => message.type === 'historyOpened').at(-1);
    expect(opened?.type === 'historyOpened' ? opened.entries[0] : undefined).not.toHaveProperty(
      'linePatch',
    );
    expect(getLineHistory).toHaveBeenCalledWith('/repo', 'src/app.ts', 4, 5, [], expect.anything());

    await controller.openEditorHistory({
      kind: 'line',
      repository,
      path: 'src/app.ts',
      startLine: 4,
      endLine: 6,
    });
    expect(messages.filter((message) => message.type === 'historyOpened').at(-1)).toMatchObject({
      entries: [],
      notice:
        'The selected lines do not map to a continuous committed range. Select a smaller range.',
    });
    expect(getLineHistory).toHaveBeenCalledTimes(1);
  });

  it('directs a line request for a deleted historical file to File History', async () => {
    const hash = 'a'.repeat(40);
    const repository: RepositorySummary = {
      id: 'repo-deleted-line-history',
      rootUri: 'file:///repo',
      gitDirUri: 'file:///repo/.git',
      displayName: 'repo',
      isBare: false,
      currentBranch: 'main',
      head: hash,
    };
    const messages: ExtensionToWebviewMessage[] = [];
    const controller = new (await import('../../src/webview/WorkbenchController')).WorkbenchController({
      workspaceRoots: [],
      gitService: { getRefs: vi.fn().mockResolvedValue([]) } as unknown as GitService,
      fileHistoryService: {
        resolveHeadLineRange: vi.fn().mockResolvedValue({
          status: 'file-not-in-head',
          hasHistory: true,
        }),
      } as unknown as FileHistoryService,
      gitRunner: {} as GitRunner,
      scanDepth: 0,
      initialPageSize: 200,
      pageSize: 500,
      initialLayout: { refsWidth: 220, filesWidth: 320, detailsHeight: 156, filesViewMode: 'tree' },
      postMessage(message: ExtensionToWebviewMessage) {
        messages.push(message);
        return Promise.resolve(true);
      },
      persistLayout: () => Promise.resolve(),
    });

    await controller.openEditorHistory({
      kind: 'line',
      repository,
      path: 'deleted.txt',
      startLine: 1,
      endLine: 1,
    });

    expect(messages.at(-1)).toMatchObject({
      type: 'historyOpened',
      kind: 'line',
      entries: [],
      notice: 'This file does not exist in HEAD. Use File History instead.',
    });
  });

  it('opens a recoverable line-history error state that can switch to file history', async () => {
    const hash = 'a'.repeat(40);
    const repository: RepositorySummary = {
      id: 'repo-line-history-binary',
      rootUri: 'file:///repo',
      gitDirUri: 'file:///repo/.git',
      displayName: 'repo',
      isBare: false,
      currentBranch: 'main',
      head: hash,
    };
    const messages: ExtensionToWebviewMessage[] = [];
    const controller = new (await import('../../src/webview/WorkbenchController')).WorkbenchController({
      workspaceRoots: [],
      gitService: { getRefs: vi.fn().mockResolvedValue([]) } as unknown as GitService,
      fileHistoryService: {
        resolveHeadLineRange: vi.fn().mockRejectedValue(
          new GitCommandError(
            'Git command exited with code 128.',
            ['log', '-L'],
            '/repo',
            128,
            Buffer.alloc(0),
            Buffer.from('fatal: file image.png is binary'),
            false,
            false,
          ),
        ),
      } as unknown as FileHistoryService,
      gitRunner: {} as GitRunner,
      scanDepth: 0,
      initialPageSize: 200,
      pageSize: 500,
      initialLayout: { refsWidth: 220, filesWidth: 320, detailsHeight: 156, filesViewMode: 'tree' },
      postMessage(message: ExtensionToWebviewMessage) {
        messages.push(message);
        return Promise.resolve(true);
      },
      persistLayout: () => Promise.resolve(),
    });

    await controller.openEditorHistory({
      kind: 'line',
      repository,
      path: 'image.png',
      startLine: 1,
      endLine: 1,
    });

    expect(messages.at(-1)).toMatchObject({
      type: 'historyOpened',
      repositoryId: repository.id,
      kind: 'line',
      path: 'image.png',
      entries: [],
      replace: true,
      hasMore: false,
      notice: 'Binary files do not support line history.',
    });
    expect(messages.find((message) => message.type === 'error')).toBeUndefined();
  });

  it('uses the selected merge parent when opening a history diff', async () => {
    const hash = 'a'.repeat(40);
    const firstParent = 'b'.repeat(40);
    const secondParent = 'c'.repeat(40);
    const getChangedFiles = vi.fn().mockResolvedValue([
      { status: 'M', path: 'src/app.ts', additions: 1, deletions: 0, binary: false },
    ]);
    const openDiff = vi.fn().mockResolvedValue(undefined);
    const repository: RepositorySummary = {
      id: 'repo-merge-history',
      rootUri: 'file:///repo',
      gitDirUri: 'file:///repo/.git',
      displayName: 'repo',
      isBare: false,
      currentBranch: 'main',
      head: hash,
    };
    const controller = new (await import('../../src/webview/WorkbenchController')).WorkbenchController({
      workspaceRoots: [],
      gitService: {
        getRefs: vi.fn().mockResolvedValue([]),
        getChangedFiles,
      } as unknown as GitService,
      fileHistoryService: {
        getFileHistory: vi.fn().mockResolvedValue([
          {
            hash,
            parents: [firstParent, secondParent],
            subject: 'merge change',
            authorName: 'Alice',
            authorEmail: 'alice@example.com',
            authorTime: 1,
            commitTime: 1,
            refs: [],
            path: 'src/app.ts',
            additions: 1,
            deletions: 0,
            binary: false,
          },
        ]),
      } as unknown as FileHistoryService,
      gitRunner: {} as GitRunner,
      scanDepth: 0,
      initialPageSize: 200,
      pageSize: 500,
      initialLayout: { refsWidth: 220, filesWidth: 320, detailsHeight: 156, filesViewMode: 'tree' },
      postMessage: () => Promise.resolve(true),
      persistLayout: () => Promise.resolve(),
      openDiff,
    });
    await controller.openEditorHistory({ kind: 'file', repository, path: 'src/app.ts' });

    await controller.handleMessage({
      type: 'openHistoryDiff',
      requestId: 'merge-history-diff',
      repositoryId: repository.id,
      hash,
      parent: secondParent,
    });

    expect(getChangedFiles).toHaveBeenCalledWith('/repo', hash, secondParent);
    expect(openDiff).toHaveBeenCalledWith(
      repository,
      expect.objectContaining({ hash, parent: secondParent, path: 'src/app.ts' }),
    );
  });

  it('opens the exact history path when a root commit changed multiple files', async () => {
    const hash = 'a'.repeat(40);
    const repository: RepositorySummary = {
      id: 'repo-root-history-path',
      rootUri: 'file:///repo',
      gitDirUri: 'file:///repo/.git',
      displayName: 'repo',
      isBare: false,
      currentBranch: 'main',
      head: hash,
    };
    const getChangedFiles = vi.fn().mockResolvedValue([
      { status: 'A', path: '.github/workflows/ci.yml', binary: false },
      { status: 'A', path: 'src/app.ts', binary: false },
    ]);
    const openDiff = vi.fn().mockResolvedValue(undefined);
    const controller = new (await import('../../src/webview/WorkbenchController')).WorkbenchController({
      workspaceRoots: [],
      gitService: {
        getRefs: vi.fn().mockResolvedValue([]),
        getChangedFiles,
      } as unknown as GitService,
      fileHistoryService: {
        getFileHistory: vi.fn().mockResolvedValue([
          {
            hash,
            parents: [],
            subject: 'root commit',
            authorName: 'Alice',
            authorEmail: 'alice@example.com',
            authorTime: 1,
            commitTime: 1,
            refs: [],
            path: 'src/app.ts',
            additions: 1,
            deletions: 0,
            binary: false,
          },
        ]),
      } as unknown as FileHistoryService,
      gitRunner: {} as GitRunner,
      scanDepth: 0,
      initialPageSize: 200,
      pageSize: 500,
      initialLayout: { refsWidth: 220, filesWidth: 320, detailsHeight: 156, filesViewMode: 'tree' },
      postMessage: () => Promise.resolve(true),
      persistLayout: () => Promise.resolve(),
      openDiff,
    });
    await controller.openEditorHistory({ kind: 'file', repository, path: 'src/app.ts' });

    await controller.handleMessage({
      type: 'openHistoryDiff',
      requestId: 'root-history-diff',
      repositoryId: repository.id,
      hash,
    });

    expect(getChangedFiles).toHaveBeenCalledWith('/repo', hash, undefined);
    expect(openDiff).toHaveBeenCalledWith(
      repository,
      expect.objectContaining({ hash, path: 'src/app.ts', status: 'A' }),
    );
  });

  it('reports binary file-history entries without opening a text diff', async () => {
    const hash = 'a'.repeat(40);
    const repository: RepositorySummary = {
      id: 'repo-binary-history',
      rootUri: 'file:///repo',
      gitDirUri: 'file:///repo/.git',
      displayName: 'repo',
      isBare: false,
      currentBranch: 'main',
      head: hash,
    };
    const messages: ExtensionToWebviewMessage[] = [];
    const getChangedFiles = vi.fn();
    const openDiff = vi.fn();
    const controller = new (await import('../../src/webview/WorkbenchController')).WorkbenchController({
      workspaceRoots: [],
      gitService: {
        getRefs: vi.fn().mockResolvedValue([]),
        getChangedFiles,
      } as unknown as GitService,
      fileHistoryService: {
        getFileHistory: vi.fn().mockResolvedValue([
          {
            hash,
            parents: [],
            subject: 'update image',
            authorName: 'Alice',
            authorEmail: 'alice@example.com',
            authorTime: 1,
            commitTime: 1,
            refs: [],
            path: 'image.png',
            binary: true,
          },
        ]),
      } as unknown as FileHistoryService,
      gitRunner: {} as GitRunner,
      scanDepth: 0,
      initialPageSize: 200,
      pageSize: 500,
      initialLayout: { refsWidth: 220, filesWidth: 320, detailsHeight: 156, filesViewMode: 'tree' },
      postMessage(message: ExtensionToWebviewMessage) {
        messages.push(message);
        return Promise.resolve(true);
      },
      persistLayout: () => Promise.resolve(),
      openDiff,
    });
    await controller.openEditorHistory({ kind: 'file', repository, path: 'image.png' });

    await controller.handleMessage({
      type: 'openHistoryDiff',
      requestId: 'binary-history-diff',
      repositoryId: repository.id,
      hash,
    });

    expect(getChangedFiles).not.toHaveBeenCalled();
    expect(openDiff).not.toHaveBeenCalled();
    expect(messages.at(-1)).toMatchObject({
      type: 'error',
      requestId: 'binary-history-diff',
      message: 'Binary files cannot be opened in the text diff editor.',
    });
  });

  it('refreshes active editor history when its repository changes even if it is not selected', async () => {
    const hash = 'a'.repeat(40);
    const repository: RepositorySummary = {
      id: 'repo-watched-history',
      rootUri: 'file:///repo',
      gitDirUri: 'file:///repo/.git',
      displayName: 'repo',
      isBare: false,
      currentBranch: 'main',
      head: hash,
    };
    const getFileHistory = vi.fn().mockResolvedValue([
      {
        hash,
        parents: [],
        subject: 'history',
        authorName: 'Alice',
        authorEmail: 'alice@example.com',
        authorTime: 1,
        commitTime: 1,
        refs: [],
        path: 'src/app.ts',
        additions: 1,
        deletions: 0,
        binary: false,
      },
    ]);
    const invalidate = vi.fn();
    const controller = new (await import('../../src/webview/WorkbenchController')).WorkbenchController({
      workspaceRoots: [],
      gitService: { getRefs: vi.fn().mockResolvedValue([]) } as unknown as GitService,
      fileHistoryService: { getFileHistory, invalidate } as unknown as FileHistoryService,
      gitRunner: {} as GitRunner,
      scanDepth: 0,
      initialPageSize: 200,
      pageSize: 500,
      initialLayout: { refsWidth: 220, filesWidth: 320, detailsHeight: 156, filesViewMode: 'tree' },
      postMessage: () => Promise.resolve(true),
      persistLayout: () => Promise.resolve(),
    });
    await controller.openEditorHistory({ kind: 'file', repository, path: 'src/app.ts' });

    await controller.notifyRepositoryChanged(repository.id);

    expect(getFileHistory).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenCalledWith('/repo');
  });

  it('cancels an older direct editor-history request without surfacing a cancellation error', async () => {
    const repository: RepositorySummary = {
      id: 'repo-history-cancel',
      rootUri: 'file:///repo',
      gitDirUri: 'file:///repo/.git',
      displayName: 'repo',
      isBare: false,
      currentBranch: 'main',
      head: 'd'.repeat(40),
    };
    let call = 0;
    let signalFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      signalFirstStarted = resolve;
    });
    const getFileHistory = vi.fn(
      (_cwd: string, _path: string, _refs: unknown, page: { signal?: AbortSignal }) => {
        call += 1;
        if (call > 1) return Promise.resolve([]);
        signalFirstStarted?.();
        return new Promise<never>((_resolve, reject) => {
          page.signal?.addEventListener(
            'abort',
            () =>
              reject(
                new GitCommandError(
                  'Git command was cancelled.',
                  ['log'],
                  '/repo',
                  null,
                  Buffer.alloc(0),
                  Buffer.alloc(0),
                  true,
                  false,
                ),
              ),
            { once: true },
          );
        });
      },
    );
    const controller = new (await import('../../src/webview/WorkbenchController')).WorkbenchController({
      workspaceRoots: [],
      gitService: { getRefs: vi.fn().mockResolvedValue([]) } as unknown as GitService,
      fileHistoryService: { getFileHistory } as unknown as FileHistoryService,
      gitRunner: {} as GitRunner,
      scanDepth: 0,
      initialPageSize: 200,
      pageSize: 500,
      initialLayout: { refsWidth: 220, filesWidth: 320, detailsHeight: 156, filesViewMode: 'tree' },
      postMessage: () => Promise.resolve(true),
      persistLayout: () => Promise.resolve(),
    });
    const first = controller.openEditorHistory({ kind: 'file', repository, path: 'first.ts' });
    await firstStarted;
    const second = controller.openEditorHistory({ kind: 'file', repository, path: 'second.ts' });

    await expect(Promise.all([first, second])).resolves.toBeDefined();
  });

  it('loads file history in bounded pages and detects the final page without an empty request', async () => {
    const repository: RepositorySummary = {
      id: 'repo-history-pages',
      rootUri: 'file:///repo',
      gitDirUri: 'file:///repo/.git',
      displayName: 'repo',
      isBare: false,
      currentBranch: 'main',
      head: '1'.repeat(40),
    };
    const allEntries = ['one', 'two', 'three'].map((subject, index) => ({
      hash: String(index + 1).repeat(40),
      parents: [],
      subject,
      authorName: 'Alice',
      authorEmail: 'alice@example.com',
      authorTime: index + 1,
      commitTime: index + 1,
      refs: [],
      path: 'src/app.ts',
      additions: 1,
      deletions: 0,
      binary: false,
    }));
    const getFileHistory = vi.fn(
      (_cwd: string, _path: string, _refs: unknown, page: { limit: number; skip: number }) =>
        Promise.resolve(allEntries.slice(page.skip, page.skip + page.limit)),
    );
    const messages: ExtensionToWebviewMessage[] = [];
    const controller = new (await import('../../src/webview/WorkbenchController')).WorkbenchController({
      workspaceRoots: [],
      gitService: { getRefs: vi.fn().mockResolvedValue([]) } as unknown as GitService,
      fileHistoryService: { getFileHistory } as unknown as FileHistoryService,
      gitRunner: {} as GitRunner,
      scanDepth: 0,
      initialPageSize: 2,
      pageSize: 2,
      initialLayout: { refsWidth: 220, filesWidth: 320, detailsHeight: 156, filesViewMode: 'tree' },
      postMessage: (message: ExtensionToWebviewMessage) => {
        messages.push(message);
        return Promise.resolve(true);
      },
      persistLayout: () => Promise.resolve(),
    });
    await controller.openEditorHistory({ kind: 'file', repository, path: 'src/app.ts' });
    const firstPage = messages.filter((message) => message.type === 'historyOpened').at(-1);
    expect(firstPage).toMatchObject({
      type: 'historyOpened',
      entries: [expect.objectContaining({ subject: 'one' }), expect.objectContaining({ subject: 'two' })],
      replace: true,
      hasMore: true,
    });

    await controller.handleMessage({
      type: 'requestHistoryPage',
      requestId: 'history-page-duplicate',
      repositoryId: repository.id,
      skip: 0,
    });
    await controller.handleMessage({
      type: 'requestHistoryPage',
      requestId: 'history-page-stale-repository',
      repositoryId: 'old-repository',
      skip: 2,
    });
    expect(getFileHistory).toHaveBeenCalledTimes(1);

    await controller.handleMessage({
      type: 'requestHistoryPage',
      requestId: 'history-page-two',
      repositoryId: repository.id,
      skip: 2,
    });

    expect(messages.filter((message) => message.type === 'historyOpened').at(-1)).toMatchObject({
      type: 'historyOpened',
      entries: [expect.objectContaining({ subject: 'three' })],
      replace: false,
      hasMore: false,
    });
    expect(getFileHistory).toHaveBeenNthCalledWith(
      1,
      '/repo',
      'src/app.ts',
      [],
      expect.objectContaining({ limit: 3, skip: 0 }),
    );
    expect(getFileHistory).toHaveBeenNthCalledWith(
      2,
      '/repo',
      'src/app.ts',
      [],
      expect.objectContaining({ limit: 3, skip: 2 }),
    );
  });
});
