// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../webview/src/App';
import type { WebviewToExtensionMessage } from '../../src/protocol/messages';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const postedMessages: WebviewToExtensionMessage[] = [];
let storedWebviewState: unknown;
const setWebviewState = vi.fn((state: unknown) => {
  storedWebviewState = state;
});
beforeEach(() => {
  postedMessages.length = 0;
  storedWebviewState = undefined;
  setWebviewState.mockClear();
  window.acquireVsCodeApi = () => ({
    postMessage(message) {
      postedMessages.push(message);
    },
    getState() {
      return storedWebviewState;
    },
    setState: setWebviewState,
  });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: undefined,
  });
});

function completeLatestOperation(): void {
  const operation = postedMessages.filter((message) => message.type === 'runOperation').at(-1);
  expect(operation?.type).toBe('runOperation');
  if (!operation || operation.type !== 'runOperation') return;
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'operationCompleted',
          requestId: operation.requestId,
          repositoryId: operation.repositoryId,
          message: 'completed',
        },
      }),
    );
  });
}

function initializeCommitRangeFixture() {
  const newest = 'c'.repeat(40);
  const middle = 'b'.repeat(40);
  const oldest = 'a'.repeat(40);
  const commits = [
    {
      hash: newest,
      parents: [middle],
      subject: 'newest commit',
      authorName: 'Alice',
      authorEmail: 'alice@example.com',
      authorTime: 3,
      commitTime: 3,
      refs: [],
    },
    {
      hash: middle,
      parents: [oldest],
      subject: 'middle commit',
      authorName: 'Bob',
      authorEmail: 'bob@example.com',
      authorTime: 2,
      commitTime: 2,
      refs: [],
    },
    {
      hash: oldest,
      parents: ['d'.repeat(40)],
      subject: 'oldest commit',
      authorName: 'Carol',
      authorEmail: 'carol@example.com',
      authorTime: 1,
      commitTime: 1,
      refs: [],
    },
  ];
  render(<App />);
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'initialize',
          requestId: 'ready-commit-range',
          repositories: [
            {
              id: 'repo-commit-range',
              rootUri: 'file:///workspace/commit-range',
              gitDirUri: 'file:///workspace/commit-range/.git',
              displayName: 'commit-range',
              isBare: false,
              currentBranch: 'main',
              head: newest,
            },
          ],
          selectedRepositoryId: 'repo-commit-range',
          pageSize: 500,
          maxCachedCommits: 5000,
          layout: {
            refsWidth: 220,
            filesWidth: 320,
            detailsHeight: 156,
            filesViewMode: 'tree',
          },
        },
      }),
    );
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'repositoryData',
          requestId: 'ready-commit-range',
          repositoryId: 'repo-commit-range',
          refs: [],
          commits,
          filters: { text: '', branches: [], authors: [], paths: [] },
          replace: true,
          hasMore: false,
        },
      }),
    );
  });
  postedMessages.length = 0;
  return { newest, middle, oldest, commits };
}

describe('WorkbenchApp', () => {
  it('renders the four-region Git log workspace', () => {
    render(<App />);

    const commitLog = screen.getByRole('grid', { name: 'Commit log' });
    const commitFilters = screen.getByRole('toolbar', { name: 'Git log filters' });
    const globalActions = screen.getByRole('toolbar', { name: 'Global Git actions' });
    const references = screen.getByRole('navigation', { name: 'Git references' });

    expect(commitLog).toContainElement(commitFilters);
    expect(commitLog).not.toContainElement(globalActions);
    for (const name of [
      'Refresh log',
      'Go to HEAD',
      'Fetch remotes',
      'Collapse references pane',
      'Collapse changed files pane',
      'More actions',
    ]) {
      expect(globalActions).toContainElement(screen.getByRole('button', { name }));
    }
    expect(screen.getByRole('searchbox', { name: 'Text or hash' })).toBeInTheDocument();
    const branchSearch = screen.getByRole('searchbox', { name: 'Filter branches' });
    expect(references).toContainElement(branchSearch);
    expect(branchSearch.closest('.refs-toolbar')).not.toBeNull();
    expect(screen.getByRole('region', { name: 'Changed files' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Commit details' })).toBeInTheDocument();
    expect(screen.getByText('HEAD')).toBeInTheDocument();
    expect(screen.getByText('Local')).toBeInTheDocument();
    expect(screen.getByText('Remote')).toBeInTheDocument();
    expect(screen.getByText('Tags')).toBeInTheDocument();
  });

  it('prevents native text selection inside the commit log', () => {
    render(<App />);

    expect(screen.getByRole('grid', { name: 'Commit log' })).toHaveStyle({
      userSelect: 'none',
    });
  });

  it('extends commit selection with Shift and offers a drop action for the range', () => {
    const { newest, middle, oldest } = initializeCommitRangeFixture();
    const newestRow = screen.getByText('newest commit').closest('[role="row"]') as HTMLElement;
    const middleRow = screen.getByText('middle commit').closest('[role="row"]') as HTMLElement;
    const oldestRow = screen.getByText('oldest commit').closest('[role="row"]') as HTMLElement;

    fireEvent.click(newestRow);
    fireEvent.click(oldestRow, { shiftKey: true });

    for (const row of [newestRow, middleRow, oldestRow]) {
      expect(row).toHaveAttribute('aria-selected', 'true');
    }
    const selectionRequest = postedMessages.at(-1);
    expect(selectionRequest).toMatchObject({
      type: 'selectCommit',
      repositoryId: 'repo-commit-range',
      hash: oldest,
      hashes: [newest, middle, oldest],
    });
    if (!selectionRequest || selectionRequest.type !== 'selectCommit') return;
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'selectionDetailsLoaded',
            requestId: selectionRequest.requestId,
            repositoryId: 'repo-commit-range',
            details: {
              hash: oldest,
              parents: ['d'.repeat(40)],
              subject: 'oldest commit',
              body: 'oldest commit\n',
              authorName: 'Carol',
              authorEmail: 'carol@example.com',
              authorTime: 1,
              commitTime: 1,
              committerName: 'Carol',
              committerEmail: 'carol@example.com',
              refs: [],
              signature: 'none',
            },
            files: [
              {
                status: 'A',
                path: 'newer.txt',
                additions: 1,
                deletions: 0,
                binary: false,
                commitHash: newest,
                parentHash: middle,
              },
            ],
          },
        }),
      );
    });
    fireEvent.doubleClick(screen.getByText('newer.txt'));
    expect(postedMessages.at(-1)).toMatchObject({
      type: 'openDiff',
      hash: newest,
      parent: middle,
      path: 'newer.txt',
    });
    fireEvent.contextMenu(middleRow);
    const menu = screen.getByRole('menu', { name: 'commit actions' });
    expect(within(menu).queryByRole('menuitem', { name: 'Checkout Revision' })).not.toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Drop commits…' })).toBeEnabled();
    expect(within(menu).getByRole('menuitem', { name: 'Squash commits…' })).toBeEnabled();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Drop commits…' }));

    expect(postedMessages.at(-1)).toMatchObject({
      type: 'runOperation',
      repositoryId: 'repo-commit-range',
      operation: { kind: 'dropCommits', hashes: [newest, middle, oldest] },
    });
  });

  it('prefills the squash dialog with complete commit messages from top to bottom', () => {
    const { newest, middle, oldest } = initializeCommitRangeFixture();
    const newestRow = screen.getByText('newest commit').closest('[role="row"]') as HTMLElement;
    const oldestRow = screen.getByText('oldest commit').closest('[role="row"]') as HTMLElement;
    fireEvent.click(newestRow);
    fireEvent.click(oldestRow, { shiftKey: true });
    fireEvent.contextMenu(oldestRow);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Squash commits…' }));

    const messageRequest = postedMessages.at(-1);
    expect(messageRequest).toMatchObject({
      type: 'requestCommitMessages',
      repositoryId: 'repo-commit-range',
      hashes: [newest, middle, oldest],
    });
    if (!messageRequest || messageRequest.type !== 'requestCommitMessages') return;
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'commitMessagesLoaded',
            requestId: messageRequest.requestId,
            repositoryId: 'repo-commit-range',
            messages: [
              { hash: newest, message: 'newest subject\n\nnewest body\n' },
              { hash: middle, message: 'middle subject\n\nmiddle body\n' },
              { hash: oldest, message: 'oldest subject\n\noldest body\n' },
            ],
          },
        }),
      );
    });

    const input = screen.getByRole('textbox', { name: 'Squash commit message' });
    expect(input).toHaveValue(
      'newest subject\n\nnewest body\n\nmiddle subject\n\nmiddle body\n\noldest subject\n\noldest body',
    );
    fireEvent.change(input, { target: { value: 'combined commit message' } });
    fireEvent.click(screen.getByRole('button', { name: 'Squash Commits' }));

    expect(postedMessages.at(-1)).toMatchObject({
      type: 'runOperation',
      repositoryId: 'repo-commit-range',
      operation: {
        kind: 'squashCommits',
        hashes: [newest, middle, oldest],
        message: 'combined commit message',
      },
    });
  });

  it('extends the contiguous commit selection with Shift+Arrow keys', () => {
    initializeCommitRangeFixture();
    const newestRow = screen.getByText('newest commit').closest('[role="row"]') as HTMLElement;
    const middleRow = screen.getByText('middle commit').closest('[role="row"]') as HTMLElement;
    const oldestRow = screen.getByText('oldest commit').closest('[role="row"]') as HTMLElement;

    fireEvent.click(newestRow);
    fireEvent.keyDown(newestRow, { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(middleRow, { key: 'ArrowDown', shiftKey: true });

    for (const row of [newestRow, middleRow, oldestRow]) {
      expect(row).toHaveAttribute('aria-selected', 'true');
    }
  });

  it('toggles non-contiguous commits with Ctrl or Cmd and hides range rewrite actions', () => {
    const { newest, oldest, commits } = initializeCommitRangeFixture();
    const newestRow = screen.getByText('newest commit').closest('[role="row"]') as HTMLElement;
    const middleRow = screen.getByText('middle commit').closest('[role="row"]') as HTMLElement;
    const oldestRow = screen.getByText('oldest commit').closest('[role="row"]') as HTMLElement;

    fireEvent.click(newestRow);
    fireEvent.click(oldestRow, { ctrlKey: true });

    expect(newestRow).toHaveAttribute('aria-selected', 'true');
    expect(middleRow).toHaveAttribute('aria-selected', 'false');
    expect(oldestRow).toHaveAttribute('aria-selected', 'true');
    expect(postedMessages.at(-1)).toMatchObject({
      type: 'selectCommit',
      hash: oldest,
      hashes: [newest, oldest],
    });

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'repositoryData',
            requestId: 'refresh-non-contiguous-selection',
            repositoryId: 'repo-commit-range',
            refs: [],
            commits,
            filters: { text: '', branches: [], authors: [], paths: [] },
            selectedHash: oldest,
            replace: true,
            hasMore: false,
          },
        }),
      );
    });
    expect(newestRow).toHaveAttribute('aria-selected', 'true');
    expect(middleRow).toHaveAttribute('aria-selected', 'false');
    expect(oldestRow).toHaveAttribute('aria-selected', 'true');

    fireEvent.contextMenu(newestRow);
    const menu = screen.getByRole('menu', { name: 'commit actions' });
    expect(within(menu).queryByRole('menuitem', { name: 'Drop commits…' })).not.toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: 'Squash commits…' })).not.toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: 'Checkout Revision' })).not.toBeInTheDocument();

    fireEvent.pointerDown(screen.getByRole('grid', { name: 'Commit log' }));
    fireEvent.click(oldestRow, { metaKey: true });
    expect(newestRow).toHaveAttribute('aria-selected', 'true');
    expect(oldestRow).toHaveAttribute('aria-selected', 'false');
    expect(postedMessages.at(-1)).toMatchObject({
      type: 'selectCommit',
      hash: newest,
      hashes: [newest],
    });
  });

  it('preserves a valid commit range selection across repository refreshes', () => {
    const { newest, middle, oldest } = initializeCommitRangeFixture();
    fireEvent.click(screen.getByText('newest commit').closest('[role="row"]') as HTMLElement);
    fireEvent.click(screen.getByText('oldest commit').closest('[role="row"]') as HTMLElement, {
      shiftKey: true,
    });

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'repositoryData',
            requestId: 'refresh-commit-range',
            repositoryId: 'repo-commit-range',
            refs: [],
            commits: [
              {
                hash: newest,
                parents: [middle],
                subject: 'newest commit',
                authorName: 'Alice',
                authorEmail: 'alice@example.com',
                authorTime: 3,
                commitTime: 3,
                refs: [],
              },
              {
                hash: middle,
                parents: [oldest],
                subject: 'middle commit',
                authorName: 'Bob',
                authorEmail: 'bob@example.com',
                authorTime: 2,
                commitTime: 2,
                refs: [],
              },
              {
                hash: oldest,
                parents: ['d'.repeat(40)],
                subject: 'oldest commit',
                authorName: 'Carol',
                authorEmail: 'carol@example.com',
                authorTime: 1,
                commitTime: 1,
                refs: [],
              },
            ],
            filters: { text: '', branches: [], authors: [], paths: [] },
            selectedHash: newest,
            replace: true,
            hasMore: false,
          },
        }),
      );
    });

    for (const subject of ['newest commit', 'middle commit', 'oldest commit']) {
      expect(screen.getByText(subject).closest('[role="row"]')).toHaveAttribute(
        'aria-selected',
        'true',
      );
    }
  });

  it('shows the repository selector only when multiple repositories are available', () => {
    render(<App />);
    const firstRepository = {
      id: 'repo-one',
      rootUri: 'file:///workspace/one',
      gitDirUri: 'file:///workspace/one/.git',
      displayName: 'one',
      isBare: false,
    };
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'initialize',
            requestId: 'ready-repository-selector',
            repositories: [firstRepository],
            selectedRepositoryId: firstRepository.id,
            pageSize: 500,
            layout: {
              refsWidth: 220,
              filesWidth: 320,
              detailsHeight: 156,
              filesViewMode: 'tree',
            },
          },
        }),
      );
    });

    expect(screen.queryByRole('combobox', { name: 'Repository' })).not.toBeInTheDocument();

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'repositoriesUpdated',
            requestId: 'repositories-expanded',
            repositories: [
              firstRepository,
              {
                id: 'repo-two',
                rootUri: 'file:///workspace/two',
                gitDirUri: 'file:///workspace/two/.git',
                displayName: 'two',
                isBare: false,
              },
            ],
            selectedRepositoryId: firstRepository.id,
          },
        }),
      );
    });

    expect(screen.getByRole('combobox', { name: 'Repository' })).toBeInTheDocument();
  });

  it('renders file history mode with statistics and opens or closes history actions', () => {
    render(<App />);
    const hash = 'a'.repeat(40);
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'historyOpened',
            requestId: 'file-history-opened',
            repositoryId: 'repo-history',
            kind: 'file',
            path: 'src/app.ts',
            entries: [
              {
                hash,
                parents: ['b'.repeat(40)],
                subject: 'update app',
                authorName: 'Alice',
                authorEmail: 'alice@example.com',
                authorTime: 1,
                commitTime: 1,
                refs: [],
                path: 'src/app.ts',
                oldPath: 'src/old.ts',
                additions: 4,
                deletions: 2,
                binary: false,
              },
            ],
            replace: true,
            hasMore: false,
          },
        }),
      );
    });

    expect(screen.getByText('File History · src/app.ts')).toBeInTheDocument();
    expect(screen.getByText('+4')).toBeInTheDocument();
    expect(screen.getByText('−2')).toBeInTheDocument();
    expect(screen.getByText('src/old.ts → src/app.ts')).toBeInTheDocument();
    expect(
      screen.getByTestId(`commit-graph-${hash}`).querySelectorAll('path'),
    ).toHaveLength(0);
    fireEvent.click(screen.getByText('update app'));
    expect(postedMessages).toContainEqual(
      expect.objectContaining({ type: 'openHistoryDiff', repositoryId: 'repo-history', hash }),
    );
    const backButton = screen.getByRole('button', { name: 'Back to log' });
    expect(backButton).toHaveAttribute('title', 'Return to the Git log');
    fireEvent.click(backButton);
    expect(postedMessages).toContainEqual(
      expect.objectContaining({ type: 'closeHistory', repositoryId: 'repo-history' }),
    );
    const closeButton = screen.getByRole('button', { name: 'Close history' });
    expect(closeButton).toHaveAttribute('title', 'Close history and return to the Git log');
    fireEvent.click(closeButton);
    expect(postedMessages).toContainEqual(
      expect.objectContaining({ type: 'closeHistory', repositoryId: 'repo-history' }),
    );
  });

  it('renders an empty line-history notice for a purely uncommitted line', () => {
    render(<App />);
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'historyOpened',
            requestId: 'line-history-uncommitted',
            repositoryId: 'repo-history',
            kind: 'line',
            path: 'src/app.ts',
            startLine: 12,
            endLine: 12,
            entries: [],
            notice: 'This line has no committed history yet.',
            replace: true,
            hasMore: false,
          },
        }),
      );
    });

    expect(screen.getByText('Line History · src/app.ts : 12–12')).toBeInTheDocument();
    expect(screen.getByText('This line has no committed history yet.')).toBeInTheDocument();
    expect(screen.queryByText('No commits found')).not.toBeInTheDocument();
    const fileHistoryButton = screen.getByRole('button', { name: 'Show file history' });
    expect(fileHistoryButton).toHaveAttribute('title', 'Show complete file history');
    fireEvent.click(fileHistoryButton);
    expect(postedMessages).toContainEqual(
      expect.objectContaining({
        type: 'switchHistoryToFile',
        repositoryId: 'repo-history',
      }),
    );
  });

  it('closes history with a visible reason when its repository disappears', () => {
    render(<App />);
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'historyOpened',
            requestId: 'history-before-removal',
            repositoryId: 'repo-removed',
            kind: 'file',
            path: 'src/app.ts',
            entries: [],
            replace: true,
            hasMore: false,
          },
        }),
      );
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'historyClosed',
            requestId: 'history-repository-removed',
            repositoryId: 'repo-removed',
            reason: 'The repository for this editor history is no longer available.',
          },
        }),
      );
    });

    expect(screen.queryByText('File History · src/app.ts')).not.toBeInTheDocument();
    expect(
      screen.getByText('The repository for this editor history is no longer available.'),
    ).toBeInTheDocument();
  });

  it('shows errors for an active history repository that is not the normal-log repository', () => {
    render(<App />);
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'initialize',
            requestId: 'ready-cross-repository-history',
            repositories: [
              {
                id: 'repo-log',
                rootUri: 'file:///workspace/log',
                gitDirUri: 'file:///workspace/log/.git',
                displayName: 'log',
                isBare: false,
              },
              {
                id: 'repo-history',
                rootUri: 'file:///workspace/history',
                gitDirUri: 'file:///workspace/history/.git',
                displayName: 'history',
                isBare: false,
              },
            ],
            selectedRepositoryId: 'repo-log',
            pageSize: 500,
            layout: {
              refsWidth: 220,
              filesWidth: 320,
              detailsHeight: 156,
              filesViewMode: 'tree',
            },
          },
        }),
      );
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'historyOpened',
            requestId: 'cross-repository-history-opened',
            repositoryId: 'repo-history',
            kind: 'line',
            path: 'src/app.ts',
            startLine: 5,
            endLine: 5,
            entries: [],
            replace: true,
            hasMore: false,
          },
        }),
      );
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'error',
            requestId: 'cross-repository-history-error',
            repositoryId: 'repo-history',
            message: 'Line history could not be loaded.',
          },
        }),
      );
    });

    expect(screen.getByRole('alert')).toHaveTextContent('Line history could not be loaded.');
  });

  it('asks which parent to use before opening a merge history diff', () => {
    render(<App />);
    const hash = 'a'.repeat(40);
    const firstParent = 'b'.repeat(40);
    const secondParent = 'c'.repeat(40);
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'historyOpened',
            requestId: 'merge-history-opened',
            repositoryId: 'repo-history',
            kind: 'file',
            path: 'src/app.ts',
            entries: [
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
            ],
            replace: true,
            hasMore: false,
          },
        }),
      );
    });

    fireEvent.click(screen.getByText('merge change'));

    expect(screen.getByRole('dialog', { name: 'Select history parent' })).toBeInTheDocument();
    expect(postedMessages).not.toContainEqual(expect.objectContaining({ type: 'openHistoryDiff' }));
    fireEvent.click(
      screen.getByRole('button', { name: `Compare with parent ${secondParent.slice(0, 8)}` }),
    );
    expect(postedMessages).toContainEqual(
      expect.objectContaining({
        type: 'openHistoryDiff',
        repositoryId: 'repo-history',
        hash,
        parent: secondParent,
      }),
    );
  });

  it('shows the selected repository Git operation state as a visible badge', () => {
    render(<App />);
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'initialize',
            requestId: 'ready-operation-badge',
            repositories: [
              {
                id: 'repo-operation-badge',
                rootUri: 'file:///workspace/project',
                gitDirUri: 'file:///workspace/project/.git',
                displayName: 'project',
                isBare: false,
                operationState: 'rebase',
              },
            ],
            selectedRepositoryId: 'repo-operation-badge',
            pageSize: 500,
            layout: {
              refsWidth: 220,
              filesWidth: 320,
              detailsHeight: 156,
              filesViewMode: 'tree',
            },
          },
        }),
      );
    });

    expect(screen.getByText('rebase', { selector: '.operation-badge' })).toBeInTheDocument();
  });

  it('keeps write actions blocked throughout an operation refresh and rejects rapid duplicates', () => {
    render(<App />);
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'initialize',
            requestId: 'ready-operation-order',
            repositories: [
              {
                id: 'repo-operation-order',
                rootUri: 'file:///workspace/project',
                gitDirUri: 'file:///workspace/project/.git',
                displayName: 'project',
                isBare: false,
              },
            ],
            selectedRepositoryId: 'repo-operation-order',
            pageSize: 2,
            maxCachedCommits: 3,
            layout: {
              refsWidth: 220,
              filesWidth: 320,
              detailsHeight: 156,
              filesViewMode: 'tree',
            },
          },
        }),
      );
    });
    postedMessages.length = 0;

    const fetchButton = screen.getByRole('button', { name: 'Fetch remotes' });
    fireEvent.click(fetchButton);
    const first = postedMessages.find((message) => message.type === 'runOperation');
    expect(first?.type).toBe('runOperation');
    fireEvent.click(fetchButton);
    expect(postedMessages.filter((message) => message.type === 'runOperation')).toHaveLength(1);
    if (!first || first.type !== 'runOperation') return;

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'loading',
            requestId: first.requestId,
            repositoryId: first.repositoryId,
            scope: 'operation',
          },
        }),
      );
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'loading',
            requestId: `${first.requestId}-refresh`,
            repositoryId: first.repositoryId,
            scope: 'log',
          },
        }),
      );
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'repositoryData',
            requestId: `${first.requestId}-refresh`,
            repositoryId: first.repositoryId,
            refs: [],
            commits: [],
            filters: { text: '', branches: [], authors: [], paths: [] },
            replace: true,
            hasMore: false,
          },
        }),
      );
    });

    expect(screen.getByText('Running Git operation…')).toBeInTheDocument();
    expect(fetchButton).toBeDisabled();
    fireEvent.click(fetchButton);
    expect(postedMessages.filter((message) => message.type === 'runOperation')).toHaveLength(1);

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'operationCompleted',
            requestId: first.requestId,
            repositoryId: first.repositoryId,
            message: 'first completed',
          },
        }),
      );
    });
    expect(fetchButton).toBeEnabled();
  });

  it('rejects an invalid named operation before acquiring the repository operation lock', () => {
    render(<App />);
    const hash = 'a'.repeat(40);
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'initialize',
            requestId: 'ready-invalid-operation',
            repositories: [
              {
                id: 'repo-invalid-operation',
                rootUri: 'file:///workspace/project',
                gitDirUri: 'file:///workspace/project/.git',
                displayName: 'project',
                isBare: false,
              },
            ],
            selectedRepositoryId: 'repo-invalid-operation',
            pageSize: 2,
            maxCachedCommits: 3,
            layout: {
              refsWidth: 220,
              filesWidth: 320,
              detailsHeight: 156,
              filesViewMode: 'tree',
            },
          },
        }),
      );
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'repositoryData',
            requestId: 'ready-invalid-operation',
            repositoryId: 'repo-invalid-operation',
            refs: [],
            commits: [
              {
                hash,
                parents: [],
                subject: 'operation target',
                authorName: 'Alice',
                authorEmail: 'alice@example.com',
                authorTime: 1,
                commitTime: 1,
                refs: [],
              },
            ],
            filters: { text: '', branches: [], authors: [], paths: [] },
            replace: true,
            hasMore: false,
          },
        }),
      );
    });
    postedMessages.length = 0;

    const row = screen.getByText('operation target').closest('[role="row"]');
    expect(row).not.toBeNull();
    if (!row) return;
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByRole('menuitem', { name: 'New Branch…' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Branch name' }), {
      target: { value: 'feature..bad' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create Branch' }));

    expect(postedMessages.filter((message) => message.type === 'runOperation')).toHaveLength(0);
    expect(screen.getByText('Invalid Git operation parameters.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fetch remotes' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Fetch remotes' }));
    expect(postedMessages.filter((message) => message.type === 'runOperation')).toHaveLength(1);
  });

  it('cancels stale deep-window anchors when a filter resets the log window', async () => {
    vi.useFakeTimers();
    render(<App />);
    const commit = {
      hash: 'a'.repeat(40),
      parents: [],
      subject: 'deep commit',
      authorName: 'Alice',
      authorEmail: 'alice@example.com',
      authorTime: 1,
      commitTime: 1,
      refs: [],
    };
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'initialize',
            requestId: 'ready-filter-anchor',
            repositories: [
              {
                id: 'repo-filter-anchor',
                rootUri: 'file:///workspace/project',
                gitDirUri: 'file:///workspace/project/.git',
                displayName: 'project',
                isBare: false,
              },
            ],
            selectedRepositoryId: 'repo-filter-anchor',
            pageSize: 2,
            maxCachedCommits: 3,
            layout: {
              refsWidth: 220,
              filesWidth: 320,
              detailsHeight: 156,
              filesViewMode: 'tree',
            },
          },
        }),
      );
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'repositoryData',
            requestId: 'ready-filter-anchor',
            repositoryId: 'repo-filter-anchor',
            refs: [],
            commits: [commit],
            filters: { text: '', branches: [], authors: [], paths: [] },
            startLogOffset: 5000,
            graphContinuation: { lanes: [], nextLaneId: 1, nextColorIndex: 1 },
            replace: true,
            hasMore: true,
          },
        }),
      );
    });
    postedMessages.length = 0;

    fireEvent.change(screen.getByRole('searchbox', { name: 'Text or hash' }), {
      target: { value: 'new filter' },
    });
    const viewport = document.querySelector<HTMLElement>('.commit-viewport');
    expect(viewport).not.toBeNull();
    if (!viewport) return;
    viewport.scrollTop = 28;
    fireEvent.scroll(viewport);
    await act(() => vi.advanceTimersByTimeAsync(250));

    expect(postedMessages).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'updateFilters' })]));
    expect(postedMessages.filter((message) => message.type === 'updateScrollAnchor')).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ logOffset: 5000 })]),
    );
  });

  it('does not overwrite a persisted deep anchor between initialize and repository data', () => {
    render(<App />);
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'initialize',
            requestId: 'ready-delayed-deep-window',
            repositories: [
              {
                id: 'repo-delayed-deep-window',
                rootUri: 'file:///workspace/project',
                gitDirUri: 'file:///workspace/project/.git',
                displayName: 'project',
                isBare: false,
              },
            ],
            selectedRepositoryId: 'repo-delayed-deep-window',
            pageSize: 2,
            maxCachedCommits: 3,
            layout: {
              refsWidth: 220,
              filesWidth: 320,
              detailsHeight: 156,
              filesViewMode: 'tree',
            },
          },
        }),
      );
    });
    expect(postedMessages.filter((message) => message.type === 'updateScrollAnchor')).toHaveLength(0);

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'repositoryData',
            requestId: 'ready-delayed-deep-window',
            repositoryId: 'repo-delayed-deep-window',
            refs: [],
            commits: [],
            filters: { text: '', branches: [], authors: [], paths: [] },
            startLogOffset: 5000,
            graphContinuation: { lanes: [], nextLaneId: 2, nextColorIndex: 2 },
            replace: true,
            hasMore: false,
          },
        }),
      );
    });

    expect(postedMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'updateScrollAnchor',
          repositoryId: 'repo-delayed-deep-window',
          logOffset: 5000,
        }),
      ]),
    );
  });

  it('caps appended commit pages while preserving the global next-page offset', () => {
    render(<App />);
    const commit = (index: number) => ({
      hash: index.toString(16).padStart(40, '0'),
      parents: [],
      subject: `commit ${String(index)}`,
      authorName: 'Alice',
      authorEmail: 'alice@example.com',
      authorTime: 10 - index,
      commitTime: 10 - index,
      refs: [],
    });
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'initialize',
            requestId: 'ready-bounded-pages',
            repositories: [
              {
                id: 'repo-bounded-pages',
                rootUri: 'file:///workspace/project',
                gitDirUri: 'file:///workspace/project/.git',
                displayName: 'project',
                isBare: false,
              },
            ],
            selectedRepositoryId: 'repo-bounded-pages',
            pageSize: 2,
            maxCachedCommits: 3,
            layout: {
              refsWidth: 220,
              filesWidth: 320,
              detailsHeight: 156,
              filesViewMode: 'tree',
            },
          },
        }),
      );
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'repositoryData',
            requestId: 'ready-bounded-pages',
            repositoryId: 'repo-bounded-pages',
            refs: [],
            commits: [commit(1), commit(2)],
            filters: { text: '', branches: [], authors: [], paths: [] },
            replace: true,
            hasMore: true,
          },
        }),
      );
    });

    const viewport = document.querySelector<HTMLElement>('.commit-viewport');
    expect(viewport).not.toBeNull();
    if (!viewport) return;
    viewport.scrollTop = 28;
    fireEvent.scroll(viewport);
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'repositoryData',
            requestId: 'page-bounded-pages',
            repositoryId: 'repo-bounded-pages',
            refs: [],
            commits: [commit(3), commit(4), commit(5), commit(6)],
            filters: { text: '', branches: [], authors: [], paths: [] },
            replace: false,
            hasMore: true,
          },
        }),
      );
    });

    expect(screen.queryByText('commit 1')).not.toBeInTheDocument();
    expect(screen.getByText('commit 3')).toBeInTheDocument();
    expect(screen.getByText('commit 4')).toBeInTheDocument();
    expect(screen.getByText('commit 5')).toBeInTheDocument();
    expect(screen.queryByText('commit 6')).not.toBeInTheDocument();
    expect(viewport.scrollTop).toBe(0);
    expect(postedMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'updateScrollAnchor',
          repositoryId: 'repo-bounded-pages',
          logOffset: 2,
        }),
      ]),
    );
    postedMessages.length = 0;
    fireEvent.click(screen.getByRole('button', { name: 'Load more commits' }));
    expect(postedMessages.at(-1)).toMatchObject({
      type: 'requestLogPage',
      repositoryId: 'repo-bounded-pages',
      skip: 5,
    });
  });

  it('hides destructive remote actions when tracking-ref ownership is ambiguous', () => {
    render(<App />);
    const hash = 'a'.repeat(40);
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'initialize',
            requestId: 'ready-ambiguous-remote',
            repositories: [
              {
                id: 'repo-ambiguous-remote',
                rootUri: 'file:///workspace/project',
                gitDirUri: 'file:///workspace/project/.git',
                displayName: 'project',
                isBare: false,
              },
            ],
            selectedRepositoryId: 'repo-ambiguous-remote',
            pageSize: 2,
            maxCachedCommits: 3,
            layout: {
              refsWidth: 220,
              filesWidth: 320,
              detailsHeight: 156,
              filesViewMode: 'tree',
            },
          },
        }),
      );
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'repositoryData',
            requestId: 'ready-ambiguous-remote',
            repositoryId: 'repo-ambiguous-remote',
            refs: [
              {
                fullName: 'refs/remotes/team/origin/feature',
                shortName: 'team/origin/feature',
                kind: 'remote',
                target: hash,
                ahead: 0,
                behind: 0,
                isCurrent: false,
              },
            ],
            commits: [],
            filters: { text: '', branches: [], authors: [], paths: [] },
            replace: true,
            hasMore: false,
          },
        }),
      );
    });

    fireEvent.contextMenu(screen.getByTitle('refs/remotes/team/origin/feature'));
    const menu = screen.getByRole('menu', { name: 'ref actions' });
    expect(within(menu).queryByRole('menuitem', { name: 'Delete Remote Branch…' })).not.toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: 'Fetch' })).not.toBeInTheDocument();
  });

  it('loads details when Go to HEAD targets a commit outside the retained page', () => {
    render(<App />);
    const head = 'f'.repeat(40);
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'initialize',
            requestId: 'ready-unloaded-head',
            repositories: [
              {
                id: 'repo-unloaded-head',
                rootUri: 'file:///workspace/project',
                gitDirUri: 'file:///workspace/project/.git',
                displayName: 'project',
                isBare: false,
                head,
              },
            ],
            selectedRepositoryId: 'repo-unloaded-head',
            pageSize: 2,
            maxCachedCommits: 3,
            layout: {
              refsWidth: 220,
              filesWidth: 320,
              detailsHeight: 156,
              filesViewMode: 'tree',
            },
          },
        }),
      );
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'repositoryData',
            requestId: 'ready-unloaded-head',
            repositoryId: 'repo-unloaded-head',
            refs: [],
            commits: [],
            filters: { text: '', branches: [], authors: [], paths: [] },
            replace: true,
            hasMore: false,
          },
        }),
      );
    });
    postedMessages.length = 0;

    fireEvent.click(screen.getByRole('button', { name: 'Go to HEAD' }));
    const selection = postedMessages.at(-1);
    expect(selection).toMatchObject({
      type: 'selectCommit',
      repositoryId: 'repo-unloaded-head',
      hash: head,
    });
    if (!selection || selection.type !== 'selectCommit') return;
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'selectionDetailsLoaded',
            requestId: selection.requestId,
            repositoryId: selection.repositoryId,
            details: {
              hash: head,
              parents: [],
              subject: 'unloaded HEAD',
              body: 'unloaded HEAD\n\nHEAD details loaded\n',
              authorName: 'Alice',
              authorEmail: 'alice@example.com',
              authorTime: 1,
              commitTime: 1,
              committerName: 'Alice',
              committerEmail: 'alice@example.com',
              refs: [],
              signature: 'none',
            },
            files: [],
          },
        }),
      );
    });

    expect(screen.getByText('HEAD details loaded')).toBeInTheDocument();
  });

  it('uses branch clicks to filter the commit log instead of checking out', () => {
    render(<App />);
    const mainHash = 'a'.repeat(40);
    const featureHash = 'b'.repeat(40);
    const refs = [
      {
        fullName: 'refs/heads/main',
        shortName: 'main',
        kind: 'local' as const,
        target: mainHash,
        ahead: 0,
        behind: 0,
        isCurrent: true,
      },
      {
        fullName: 'refs/heads/feature/assets-fix',
        shortName: 'feature/assets-fix',
        kind: 'local' as const,
        target: featureHash,
        ahead: 1,
        behind: 0,
        isCurrent: false,
      },
    ];
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'initialize',
            requestId: 'ready-branch-view',
            repositories: [
              {
                id: 'repo-branch-view',
                rootUri: 'file:///workspace/project',
                gitDirUri: 'file:///workspace/project/.git',
                displayName: 'project',
                isBare: false,
                currentBranch: 'main',
                head: mainHash,
              },
            ],
            selectedRepositoryId: 'repo-branch-view',
            pageSize: 500,
            maxCachedCommits: 5000,
            layout: {
              refsWidth: 220,
              filesWidth: 320,
              detailsHeight: 156,
              filesViewMode: 'tree',
            },
          },
        }),
      );
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'repositoryData',
            requestId: 'ready-branch-view',
            repositoryId: 'repo-branch-view',
            refs,
            commits: [
              {
                hash: mainHash,
                parents: [],
                subject: 'main commit',
                authorName: 'Alice',
                authorEmail: 'alice@example.com',
                authorTime: 1,
                commitTime: 1,
                refs: [refs[0]],
              },
            ],
            filters: { text: '', branches: [], authors: [], paths: [] },
            replace: true,
            hasMore: false,
          },
        }),
      );
    });
    postedMessages.length = 0;

    const featureBranch = screen.getByTitle('refs/heads/feature/assets-fix');
    fireEvent.click(featureBranch);
    const filterRequest = postedMessages.find((message) => message.type === 'updateFilters');
    expect(filterRequest).toMatchObject({
      type: 'updateFilters',
      repositoryId: 'repo-branch-view',
      filters: expect.objectContaining({ branches: ['refs/heads/feature/assets-fix'] }),
    });
    expect(postedMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'selectCommit',
          repositoryId: 'repo-branch-view',
          hash: featureHash,
        }),
      ]),
    );
    expect(
      postedMessages.some(
        (message) => message.type === 'runOperation' && message.operation.kind === 'checkout',
      ),
    ).toBe(false);
    if (!filterRequest || filterRequest.type !== 'updateFilters') return;

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'repositoryData',
            requestId: filterRequest.requestId,
            repositoryId: 'repo-branch-view',
            refs,
            commits: [
              {
                hash: featureHash,
                parents: [mainHash],
                subject: 'feature branch commit',
                authorName: 'Bob',
                authorEmail: 'bob@example.com',
                authorTime: 2,
                commitTime: 2,
                refs: [refs[1]],
              },
              {
                hash: mainHash,
                parents: [],
                subject: 'main commit',
                authorName: 'Alice',
                authorEmail: 'alice@example.com',
                authorTime: 1,
                commitTime: 1,
                refs: [refs[0]],
              },
            ],
            filters: {
              text: '',
              branches: ['refs/heads/feature/assets-fix'],
              authors: [],
              paths: [],
            },
            replace: true,
            hasMore: false,
          },
        }),
      );
    });
    expect(screen.getByText('feature branch commit').closest('[role="row"]')).toHaveAttribute(
      'aria-selected',
      'true',
    );

    postedMessages.length = 0;
    fireEvent.click(featureBranch);
    fireEvent.doubleClick(featureBranch);
    expect(
      postedMessages.some(
        (message) => message.type === 'runOperation' && message.operation.kind === 'checkout',
      ),
    ).toBe(false);
  });

  it('filters the references pane locally without querying the commit log', () => {
    render(<App />);
    const mainHash = 'a'.repeat(40);
    const featureHash = 'b'.repeat(40);
    const refs = [
      {
        fullName: 'refs/heads/main',
        shortName: 'main',
        kind: 'local' as const,
        target: mainHash,
        ahead: 0,
        behind: 0,
        isCurrent: true,
      },
      {
        fullName: 'refs/heads/feature/network-switch',
        shortName: 'feature/network-switch',
        kind: 'local' as const,
        target: featureHash,
        ahead: 0,
        behind: 0,
        isCurrent: false,
      },
    ];
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'initialize',
            requestId: 'ready-reference-search',
            repositories: [
              {
                id: 'repo-reference-search',
                rootUri: 'file:///workspace/project',
                gitDirUri: 'file:///workspace/project/.git',
                displayName: 'project',
                isBare: false,
                currentBranch: 'main',
                head: mainHash,
              },
            ],
            selectedRepositoryId: 'repo-reference-search',
            pageSize: 500,
            maxCachedCommits: 5000,
            layout: {
              refsWidth: 220,
              filesWidth: 320,
              detailsHeight: 156,
              filesViewMode: 'tree',
            },
          },
        }),
      );
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'repositoryData',
            requestId: 'ready-reference-search',
            repositoryId: 'repo-reference-search',
            refs,
            commits: [],
            filters: { text: '', branches: [], authors: [], paths: [] },
            replace: true,
            hasMore: false,
          },
        }),
      );
    });
    postedMessages.length = 0;

    const search = screen.getByRole('searchbox', { name: 'Filter branches' });
    const localHeading = screen.getByText('Local').closest('button');
    expect(localHeading).not.toBeNull();
    fireEvent.click(localHeading as HTMLButtonElement);
    expect(screen.queryByTitle('refs/heads/feature/network-switch')).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: 'network' } });

    expect(screen.queryByTitle('refs/heads/main')).not.toBeInTheDocument();
    expect(screen.getByTitle('refs/heads/feature/network-switch')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Local folder feature (expanded while filtering)' }),
    ).toBeDisabled();
    expect(postedMessages).toEqual([]);

    fireEvent.keyDown(search, { key: 'Escape' });
    expect(search).toHaveValue('');
    expect(screen.queryByTitle('refs/heads/main')).not.toBeInTheDocument();
    fireEvent.click(localHeading as HTMLButtonElement);
    expect(screen.getByTitle('refs/heads/main')).toBeInTheDocument();
  });

  it('groups slash-delimited references into collapsible folder nodes', () => {
    render(<App />);
    const head = 'a'.repeat(40);
    const refs = [
      {
        fullName: 'refs/heads/feature/network-switch',
        shortName: 'feature/network-switch',
        kind: 'local' as const,
        target: 'b'.repeat(40),
        ahead: 0,
        behind: 0,
        isCurrent: false,
      },
      {
        fullName: 'refs/heads/feature/third-login',
        shortName: 'feature/third-login',
        kind: 'local' as const,
        target: 'c'.repeat(40),
        ahead: 0,
        behind: 0,
        isCurrent: false,
      },
      {
        fullName: 'refs/remotes/origin/feature/perp/kline',
        shortName: 'origin/feature/perp/kline',
        kind: 'remote' as const,
        remote: 'origin',
        target: 'd'.repeat(40),
        ahead: 0,
        behind: 0,
        isCurrent: false,
      },
      {
        fullName: 'refs/remotes/origin/feature/v3.4.5/jony',
        shortName: 'origin/feature/v3.4.5/jony',
        kind: 'remote' as const,
        remote: 'origin',
        target: 'e'.repeat(40),
        ahead: 0,
        behind: 0,
        isCurrent: false,
      },
      {
        fullName: 'refs/remotes/team/origin/feature',
        shortName: 'team/origin/feature',
        kind: 'remote' as const,
        remote: 'team/origin',
        target: 'f'.repeat(40),
        ahead: 0,
        behind: 0,
        isCurrent: false,
      },
      {
        fullName: 'refs/remotes/team/origin/other',
        shortName: 'team/origin/other',
        kind: 'remote' as const,
        remote: 'team',
        target: '1'.repeat(40),
        ahead: 0,
        behind: 0,
        isCurrent: false,
      },
    ];
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'initialize',
            requestId: 'ready-ref-folders',
            repositories: [
              {
                id: 'repo-ref-folders',
                rootUri: 'file:///workspace/project',
                gitDirUri: 'file:///workspace/project/.git',
                displayName: 'project',
                isBare: false,
                currentBranch: 'main',
                head,
              },
            ],
            selectedRepositoryId: 'repo-ref-folders',
            pageSize: 500,
            maxCachedCommits: 5000,
            layout: {
              refsWidth: 220,
              filesWidth: 320,
              detailsHeight: 156,
              filesViewMode: 'tree',
            },
          },
        }),
      );
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'repositoryData',
            requestId: 'ready-ref-folders',
            repositoryId: 'repo-ref-folders',
            refs,
            commits: [],
            filters: { text: '', branches: [], authors: [], paths: [] },
            replace: true,
            hasMore: false,
          },
        }),
      );
    });

    const localFeature = screen.getByRole('button', {
      name: 'Collapse Local folder feature',
    });
    expect(localFeature).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTitle('refs/heads/feature/network-switch')).toHaveTextContent(
      'network-switch',
    );
    expect(screen.getByRole('button', { name: 'Collapse Remote folder origin' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Collapse Remote folder origin/feature/perp' }),
    ).toBeInTheDocument();
    expect(screen.getByTitle('refs/remotes/origin/feature/perp/kline')).toHaveTextContent('kline');
    const slashRemote = screen.getByRole('group', { name: 'Remote team/origin' });
    expect(within(slashRemote).getByTitle('refs/remotes/team/origin/feature')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Collapse Remote folder team/origin/team' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByRole('button', { name: 'Collapse Remote folder team/origin' }),
    ).toHaveLength(2);

    fireEvent.click(localFeature);
    expect(screen.queryByTitle('refs/heads/feature/network-switch')).not.toBeInTheDocument();
    expect(screen.queryByTitle('refs/heads/feature/third-login')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Expand Local folder feature' }));
    expect(screen.getByTitle('refs/heads/feature/network-switch')).toBeInTheDocument();
  });

  it('does not offer current-branch reset actions while HEAD is detached', () => {
    render(<App />);
    const head = 'f'.repeat(40);
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'initialize',
            requestId: 'ready-detached-head-menu',
            repositories: [
              {
                id: 'repo-detached-head-menu',
                rootUri: 'file:///workspace/project',
                gitDirUri: 'file:///workspace/project/.git',
                displayName: 'project',
                isBare: false,
                head,
              },
            ],
            selectedRepositoryId: 'repo-detached-head-menu',
            pageSize: 500,
            layout: {
              refsWidth: 220,
              filesWidth: 320,
              detailsHeight: 156,
              filesViewMode: 'tree',
            },
          },
        }),
      );
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'repositoryData',
            requestId: 'ready-detached-head-menu',
            repositoryId: 'repo-detached-head-menu',
            refs: [],
            commits: [
              {
                hash: head,
                parents: [],
                subject: 'Detached commit',
                authorName: 'Alice',
                authorEmail: 'alice@example.com',
                authorTime: 1,
                commitTime: 1,
                refs: [],
              },
            ],
            filters: { text: '', branches: [], authors: [], paths: [] },
            replace: true,
            hasMore: false,
          },
        }),
      );
    });

    fireEvent.contextMenu(screen.getByTitle(head));
    const menu = screen.getByRole('menu', { name: 'head actions' });
    expect(within(menu).getByRole('menuitem', { name: 'Create Branch…' })).toBeEnabled();
    expect(within(menu).queryByRole('menuitem', { name: /Reset Current Branch/u })).not.toBeInTheDocument();
    fireEvent.contextMenu(screen.getByText('Detached commit').closest('[role="row"]') as Element);
    const commitMenu = screen.getByRole('menu', { name: 'commit actions' });
    expect(within(commitMenu).queryByRole('menuitem', { name: /Reset/u })).not.toBeInTheDocument();
  });

  it('renders repository data and commit details received from the extension host', () => {
    render(<App />);

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'initialize',
            requestId: 'ready-1',
            repositories: [
              {
                id: 'repo-1',
                rootUri: 'file:///workspace/project',
                gitDirUri: 'file:///workspace/project/.git',
                displayName: 'project',
                isBare: false,
                currentBranch: 'main',
                head: 'abcdef1234567890',
              },
            ],
            selectedRepositoryId: 'repo-1',
            pageSize: 500,
            layout: {
              refsWidth: 220,
              filesWidth: 320,
              detailsHeight: 156,
              filesViewMode: 'tree',
              commitColumnWidth: 360,
            },
          },
        }),
      );
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'repositoryData',
            requestId: 'ready-1',
            repositoryId: 'repo-1',
            refs: [
              {
                fullName: 'refs/heads/main',
                shortName: 'main',
                kind: 'local',
                target: 'abcdef1234567890',
                ahead: 0,
                behind: 0,
                isCurrent: true,
              },
            ],
            commits: [
              {
                hash: 'abcdef1234567890',
                parents: [],
                subject: 'Initial commit',
                authorName: 'Alice',
                authorEmail: 'alice@example.com',
                authorTime: 1700000000,
                commitTime: 1700000000,
                refs: [],
              },
            ],
            filters: { text: '', branches: [], authors: [], paths: [] },
            replace: true,
            hasMore: false,
          },
        }),
      );
    });

    expect(screen.queryByRole('combobox', { name: 'Repository' })).not.toBeInTheDocument();
    expect(screen.getAllByText('main')).toHaveLength(2);
    expect(screen.getByText('Initial commit')).toBeInTheDocument();
    expect(screen.getByTestId('commit-graph-abcdef1234567890')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Initial commit'));
    const selectionRequest = postedMessages.filter((message) => message.type === 'selectCommit').at(-1);
    expect(selectionRequest?.type).toBe('selectCommit');

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'selectionDetailsLoaded',
            requestId: 'stale-selection-request',
            repositoryId: 'repo-1',
            details: {
              hash: 'abcdef1234567890',
              parents: [],
              subject: 'Initial commit',
              body: 'Initial commit\n\nA detailed description.\n',
              authorName: 'Alice',
              authorEmail: 'alice@example.com',
              authorTime: 1700000000,
              commitTime: 1700000000,
              committerName: 'Alice',
              committerEmail: 'alice@example.com',
              refs: [],
              signature: 'none',
            },
            files: [
              {
                status: 'M',
                path: 'src/app.ts',
                additions: 3,
                deletions: 1,
                binary: false,
              },
            ],
          },
        }),
      );
    });

    expect(screen.queryByText('A detailed description.')).not.toBeInTheDocument();
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'selectionDetailsLoaded',
            requestId: selectionRequest?.requestId,
            repositoryId: 'repo-1',
            details: {
              hash: 'abcdef1234567890',
              parents: [],
              subject: 'Initial commit',
              body: 'Initial commit\n\nA detailed description.\n',
              authorName: 'Alice',
              authorEmail: 'alice@example.com',
              authorTime: 1700000000,
              commitTime: 1700000000,
              committerName: 'Alice',
              committerEmail: 'alice@example.com',
              refs: [],
              signature: 'none',
            },
            files: [
              {
                status: 'M',
                path: 'src/app.ts',
                additions: 3,
                deletions: 1,
                binary: false,
              },
            ],
          },
        }),
      );
    });

    expect(screen.getByText('A detailed description.')).toBeInTheDocument();
    expect(screen.getByText('abcdef1234567890')).toBeInTheDocument();
    fireEvent.doubleClick(screen.getByText('app.ts'));
    expect(postedMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'openDiff',
          repositoryId: 'repo-1',
          hash: 'abcdef1234567890',
          path: 'src/app.ts',
          status: 'M',
        }),
      ]),
    );
  });

  it('debounces text filters before querying the selected repository', async () => {
    vi.useFakeTimers();
    render(<App />);
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'initialize',
            requestId: 'ready-filter',
            repositories: [
              {
                id: 'repo-filter',
                rootUri: 'file:///workspace/project',
                gitDirUri: 'file:///workspace/project/.git',
                displayName: 'project',
                isBare: false,
              },
            ],
            selectedRepositoryId: 'repo-filter',
            pageSize: 500,
            layout: {
              refsWidth: 220,
              filesWidth: 320,
              detailsHeight: 156,
              filesViewMode: 'tree',
            },
          },
        }),
      );
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'repositoryData',
            requestId: 'ready-filter',
            repositoryId: 'repo-filter',
            refs: [],
            commits: [],
            filters: { text: '', branches: [], authors: [], paths: [] },
            replace: true,
            hasMore: false,
          },
        }),
      );
    });
    postedMessages.length = 0;

    fireEvent.change(screen.getByRole('searchbox', { name: 'Text or hash' }), {
      target: { value: 'Alice' },
    });
    expect(postedMessages).toEqual([]);
    await act(() => vi.advanceTimersByTimeAsync(250));

    expect(postedMessages).toEqual([
      expect.objectContaining({
        type: 'updateFilters',
        repositoryId: 'repo-filter',
        filters: expect.objectContaining({ text: 'Alice' }),
      }),
    ]);
    const search = screen.getByRole('searchbox', { name: 'Text or hash' });
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(search).toHaveValue('');
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(screen.getByRole('grid', { name: 'Commit log' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Date' }));
    expect(screen.getByRole('button', { name: 'Today' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Yesterday' })).toBeInTheDocument();
    expect(screen.getByLabelText('Custom date from')).toBeInTheDocument();
    expect(screen.getByLabelText('Custom date to')).toBeInTheDocument();
    vi.useRealTimers();
  });

  it('positions commit filter popovers from the visible commit pane bounds', () => {
    const innerWidth = vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1000);
    try {
      render(<App />);
      const commitLog = screen.getByRole('grid', { name: 'Commit log' });
      commitLog.getBoundingClientRect = () =>
        ({
          x: 220,
          y: 100,
          top: 100,
          right: 564,
          bottom: 600,
          left: 220,
          width: 344,
          height: 500,
          toJSON: () => ({}),
        }) as DOMRect;

      fireEvent.click(screen.getByRole('button', { name: 'Paths' }));

      expect(screen.getByRole('dialog', { name: 'paths filter' })).toHaveStyle({
        top: '138px',
        right: '444px',
      });
    } finally {
      innerWidth.mockRestore();
    }
  });

  it('sends typed Git operations from toolbar, refs, and commit details', () => {
    render(<App />);
    const hash = 'abcdef1234567890abcdef1234567890abcdef12';
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'initialize',
            requestId: 'ready-operations',
            repositories: [
              {
                id: 'repo-operations',
                rootUri: 'file:///workspace/project',
                gitDirUri: 'file:///workspace/project/.git',
                displayName: 'project',
                isBare: false,
                currentBranch: 'main',
                head: hash,
              },
            ],
            selectedRepositoryId: 'repo-operations',
            pageSize: 500,
            layout: {
              refsWidth: 220,
              filesWidth: 320,
              detailsHeight: 156,
              filesViewMode: 'tree',
            },
          },
        }),
      );
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'repositoryData',
            requestId: 'ready-operations',
            repositoryId: 'repo-operations',
            refs: [
              {
                fullName: 'refs/heads/main',
                shortName: 'main',
                kind: 'local',
                target: hash,
                ahead: 0,
                behind: 0,
                isCurrent: true,
              },
            ],
            commits: [
              {
                hash,
                parents: [],
                subject: 'Operation target',
                authorName: 'Alice',
                authorEmail: 'alice@example.com',
                authorTime: 1700000000,
                commitTime: 1700000000,
                refs: [],
              },
            ],
            filters: { text: '', branches: [], authors: [], paths: [] },
            replace: true,
            hasMore: false,
          },
        }),
      );
    });
    postedMessages.length = 0;

    fireEvent.click(screen.getByRole('button', { name: 'Fetch remotes' }));
    completeLatestOperation();
    fireEvent.click(screen.getByRole('button', { name: 'Go to HEAD' }));
    fireEvent.doubleClick(screen.getByTitle('refs/heads/main'));
    fireEvent.click(screen.getByText('Operation target'));
    const operationSelection = postedMessages.filter((message) => message.type === 'selectCommit').at(-1);
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'selectionDetailsLoaded',
            requestId: operationSelection?.requestId,
            repositoryId: 'repo-operations',
            details: {
              hash,
              parents: [],
              subject: 'Operation target',
              body: 'Operation target\n',
              authorName: 'Alice',
              authorEmail: 'alice@example.com',
              authorTime: 1700000000,
              commitTime: 1700000000,
              committerName: 'Alice',
              committerEmail: 'alice@example.com',
              refs: [],
              signature: 'none',
            },
            files: [],
          },
        }),
      );
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cherry-pick selected commit' }));
    completeLatestOperation();
    fireEvent.click(screen.getByRole('button', { name: 'Revert selected commit' }));
    completeLatestOperation();
    const operationTarget = screen.getAllByText('Operation target')[0];
    expect(operationTarget).toBeDefined();
    if (!operationTarget) return;
    fireEvent.contextMenu(operationTarget.closest('[role="row"]') as Element);
    fireEvent.click(screen.getByRole('menuitem', { name: 'New Branch…' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Branch name' }), {
      target: { value: 'feature/context-menu' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create Branch' }));
    completeLatestOperation();
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pull' }));

    expect(postedMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'runOperation',
          operation: { kind: 'fetch' },
        }),
        expect.objectContaining({
          type: 'runOperation',
          operation: { kind: 'cherryPick', hash },
        }),
        expect.objectContaining({
          type: 'runOperation',
          operation: { kind: 'revert', hash },
        }),
        expect.objectContaining({
          type: 'runOperation',
          operation: {
            kind: 'createBranch',
            name: 'feature/context-menu',
            startPoint: hash,
          },
        }),
        expect.objectContaining({
          type: 'runOperation',
          operation: { kind: 'pull' },
        }),
      ]),
    );
    expect(
      postedMessages.some(
        (message) => message.type === 'runOperation' && message.operation.kind === 'checkout',
      ),
    ).toBe(false);
  });

  it('rejects stale selection details and closes a commit menu when switching repositories', () => {
    render(<App />);
    const firstHash = 'a'.repeat(40);
    const secondHash = 'b'.repeat(40);
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'initialize',
            requestId: 'ready-stale-ui',
            repositories: [
              {
                id: 'repo-a',
                rootUri: 'file:///workspace/a',
                gitDirUri: 'file:///workspace/a/.git',
                displayName: 'repo-a',
                isBare: false,
              },
              {
                id: 'repo-b',
                rootUri: 'file:///workspace/b',
                gitDirUri: 'file:///workspace/b/.git',
                displayName: 'repo-b',
                isBare: false,
              },
            ],
            selectedRepositoryId: 'repo-a',
            pageSize: 500,
            layout: {
              refsWidth: 220,
              filesWidth: 320,
              detailsHeight: 156,
              filesViewMode: 'tree',
            },
          },
        }),
      );
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'repositoryData',
            requestId: 'ready-stale-ui',
            repositoryId: 'repo-a',
            refs: [],
            commits: [
              {
                hash: firstHash,
                parents: [],
                subject: 'repo A commit',
                authorName: 'Alice',
                authorEmail: 'alice@example.com',
                authorTime: 1,
                commitTime: 1,
                refs: [],
              },
            ],
            filters: { text: '', branches: [], authors: [], paths: [] },
            replace: true,
            hasMore: false,
          },
        }),
      );
    });

    const row = screen.getByText('repo A commit').closest('[role="row"]');
    expect(row).not.toBeNull();
    if (!row) return;
    fireEvent.click(row);
    fireEvent.contextMenu(row);
    expect(screen.getByRole('menu', { name: 'commit actions' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Repository' }), {
      target: { value: 'repo-b' },
    });
    expect(screen.queryByRole('menu', { name: 'commit actions' })).not.toBeInTheDocument();

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'repositoryData',
            requestId: 'switch-b',
            repositoryId: 'repo-b',
            refs: [],
            commits: [
              {
                hash: secondHash,
                parents: [],
                subject: 'repo B commit',
                authorName: 'Bob',
                authorEmail: 'bob@example.com',
                authorTime: 2,
                commitTime: 2,
                refs: [],
              },
            ],
            filters: { text: '', branches: [], authors: [], paths: [] },
            selectedHash: secondHash,
            replace: true,
            hasMore: false,
          },
        }),
      );
      setWebviewState.mockClear();
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'repositoryData',
            requestId: 'stale-a-page',
            repositoryId: 'repo-a',
            refs: [],
            commits: [],
            filters: { text: '', branches: [], authors: [], paths: [] },
            selectedHash: firstHash,
            scrollTop: 999,
            replace: true,
            hasMore: false,
          },
        }),
      );
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'selectionDetailsLoaded',
            requestId: 'stale-a-selection',
            repositoryId: 'repo-a',
            details: {
              hash: firstHash,
              parents: [],
              subject: 'repo A commit',
              body: 'STALE DETAILS FROM A\n',
              authorName: 'Alice',
              authorEmail: 'alice@example.com',
              authorTime: 1,
              commitTime: 1,
              committerName: 'Alice',
              committerEmail: 'alice@example.com',
              refs: [],
              signature: 'none',
            },
            files: [],
          },
        }),
      );
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'selectionDetailsLoaded',
            requestId: 'switch-b',
            repositoryId: 'repo-b',
            details: {
              hash: secondHash,
              parents: [],
              subject: 'repo B commit',
              body: 'repo B commit\n\nFRESH DETAILS FROM B\n',
              authorName: 'Bob',
              authorEmail: 'bob@example.com',
              authorTime: 2,
              commitTime: 2,
              committerName: 'Bob',
              committerEmail: 'bob@example.com',
              refs: [],
              signature: 'none',
            },
            files: [],
          },
        }),
      );
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'error',
            requestId: 'stale-a-error',
            repositoryId: 'repo-a',
            message: 'STALE ERROR FROM A',
          },
        }),
      );
    });

    expect(screen.getAllByText('repo B commit')).toHaveLength(2);
    expect(screen.queryByText('STALE DETAILS FROM A')).not.toBeInTheDocument();
    expect(screen.queryByText('STALE ERROR FROM A')).not.toBeInTheDocument();
    expect(screen.getByText('FRESH DETAILS FROM B')).toBeInTheDocument();
    expect(setWebviewState).not.toHaveBeenCalledWith({
      scrollTopByRepository: expect.objectContaining({ 'repo-a': 999 }),
    });
  });

  it('keeps the header aligned when its native scroll range is shorter than the commit list', () => {
    render(<App />);
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'initialize',
            requestId: 'ready-horizontal-columns',
            repositories: [
              {
                id: 'repo-horizontal-columns',
                rootUri: 'file:///workspace/project',
                gitDirUri: 'file:///workspace/project/.git',
                displayName: 'project',
                isBare: false,
              },
            ],
            selectedRepositoryId: 'repo-horizontal-columns',
            pageSize: 500,
            maxCachedCommits: 5000,
            layout: {
              refsWidth: 220,
              filesWidth: 320,
              detailsHeight: 156,
              filesViewMode: 'tree',
              commitColumnWidth: 1200,
              refsColumnWidth: 220,
              authorColumnWidth: 180,
              dateColumnWidth: 140,
            },
          },
        }),
      );
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'repositoryData',
            requestId: 'ready-horizontal-columns',
            repositoryId: 'repo-horizontal-columns',
            refs: [],
            commits: [
              {
                hash: 'a'.repeat(40),
                parents: [],
                subject: 'wide commit row',
                authorName: 'Alice',
                authorEmail: 'alice@example.com',
                authorTime: 1,
                commitTime: 1,
                refs: [],
              },
            ],
            filters: { text: '', branches: [], authors: [], paths: [] },
            replace: true,
            hasMore: false,
          },
        }),
      );
    });

    const log = screen.getByRole('grid', { name: 'Commit log' });
    expect(log.style.getPropertyValue('--log-content-width')).toBe('1740px');
    const viewport = document.querySelector<HTMLElement>('.commit-viewport');
    const headerViewport = document.querySelector<HTMLElement>('.log-header-viewport');
    const header = document.querySelector<HTMLElement>('.log-header');
    expect(viewport).not.toBeNull();
    expect(headerViewport).not.toBeNull();
    expect(header).not.toBeNull();
    if (!viewport || !headerViewport || !header) return;

    let headerScrollLeft = 0;
    Object.defineProperty(headerViewport, 'scrollLeft', {
      configurable: true,
      get: () => headerScrollLeft,
      set: (value: number) => {
        headerScrollLeft = Math.min(value, 400);
      },
    });

    viewport.scrollLeft = 420;
    fireEvent.scroll(viewport);

    expect(headerScrollLeft).toBe(0);
    expect(header).toHaveStyle({ transform: 'translateX(-420px)' });

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'repositoryData',
            requestId: 'empty-horizontal-columns',
            repositoryId: 'repo-horizontal-columns',
            refs: [],
            commits: [],
            filters: { text: 'missing', branches: [], authors: [], paths: [] },
            replace: true,
            hasMore: false,
          },
        }),
      );
    });

    expect(header).toHaveStyle({ transform: 'translateX(0px)' });
  });

  it('always shows Commit, Author, Date, and Refs without column settings', () => {
    render(<App />);
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'initialize',
            requestId: 'ready-column-order',
            repositories: [
              {
                id: 'repo-column-order',
                rootUri: 'file:///workspace/project',
                gitDirUri: 'file:///workspace/project/.git',
                displayName: 'project',
                isBare: false,
              },
            ],
            selectedRepositoryId: 'repo-column-order',
            pageSize: 500,
            maxCachedCommits: 5000,
            layout: {
              refsWidth: 220,
              filesWidth: 320,
              detailsHeight: 156,
              filesViewMode: 'tree',
              commitColumnWidth: 500,
              refsColumnWidth: 220,
              authorColumnWidth: 180,
              dateColumnWidth: 140,
              hiddenColumns: ['refs', 'author', 'date'],
            },
          },
        }),
      );
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'repositoryData',
            requestId: 'ready-column-order',
            repositoryId: 'repo-column-order',
            refs: [],
            commits: [
              {
                hash: 'a'.repeat(40),
                parents: [],
                subject: 'ordered commit',
                authorName: 'Alice',
                authorEmail: 'alice@example.com',
                authorTime: 1,
                commitTime: 1,
                refs: [
                  {
                    fullName: 'refs/heads/main',
                    shortName: 'main',
                    kind: 'local',
                    target: 'a'.repeat(40),
                    ahead: 0,
                    behind: 0,
                    isCurrent: true,
                  },
                ],
              },
            ],
            filters: { text: '', branches: [], authors: [], paths: [] },
            replace: true,
            hasMore: false,
          },
        }),
      );
    });

    const log = screen.getByRole('grid', { name: 'Commit log' });
    expect(screen.queryByRole('button', { name: 'Column settings' })).not.toBeInTheDocument();
    expect(within(log).getAllByRole('columnheader').map((header) => header.textContent?.trim())).toEqual([
      'Commit',
      'Author',
      'Date',
      'Refs',
    ]);
    expect(log.style.getPropertyValue('--log-grid-columns')).toBe('500px 180px 140px 220px');
    const row = screen.getByText('ordered commit').closest('[role="row"]');
    expect(
      row ? within(row as HTMLElement).getAllByRole('gridcell').map((cell) => cell.className) : [],
    ).toEqual(['commit-subject-cell', 'commit-author', 'commit-date', 'commit-refs']);
  });

  it('resizes workbench panes with an accessible separator and persists the layout', () => {
    render(<App />);
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'initialize',
            requestId: 'ready-layout',
            repositories: [],
            pageSize: 500,
            layout: {
              refsWidth: 220,
              filesWidth: 320,
              detailsHeight: 156,
              filesViewMode: 'tree',
            },
          },
        }),
      );
    });
    postedMessages.length = 0;

    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize references pane' }), {
      key: 'ArrowRight',
    });

    expect(postedMessages).toEqual([
      expect.objectContaining({
        type: 'updateLayout',
        layout: expect.objectContaining({ refsWidth: 230 }),
      }),
    ]);
    postedMessages.length = 0;
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize refs column' }), {
      key: 'ArrowRight',
    });
    expect(postedMessages).toEqual([
      expect.objectContaining({
        type: 'updateLayout',
        layout: expect.objectContaining({ refsColumnWidth: 160 }),
      }),
    ]);

    postedMessages.length = 0;
    const commitColumnResizer = screen.getByRole('separator', {
      name: 'Resize commit column',
    });
    const commitHeader = commitColumnResizer.parentElement;
    expect(commitHeader).not.toBeNull();
    if (!commitHeader) return;
    commitHeader.getBoundingClientRect = () =>
      ({
        width: 500,
        height: 30,
        x: 0,
        y: 0,
        top: 0,
        right: 500,
        bottom: 30,
        left: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    fireEvent.pointerDown(commitColumnResizer, { clientX: 300 });
    fireEvent.pointerMove(window, { clientX: 350 });
    fireEvent.pointerUp(window);
    expect(postedMessages.at(-1)).toMatchObject({
      type: 'updateLayout',
      layout: expect.objectContaining({ commitColumnWidth: 550 }),
    });

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'initialize',
            requestId: 'ready-layout-keyboard',
            repositories: [],
            pageSize: 500,
            maxCachedCommits: 5000,
            layout: {
              refsWidth: 230,
              filesWidth: 320,
              detailsHeight: 156,
              filesViewMode: 'tree',
              refsColumnWidth: 160,
            },
          },
        }),
      );
    });
    postedMessages.length = 0;
    const keyboardCommitResizer = screen.getByRole('separator', {
      name: 'Resize commit column',
    });
    const keyboardCommitHeader = keyboardCommitResizer.parentElement;
    expect(keyboardCommitHeader).not.toBeNull();
    if (!keyboardCommitHeader) return;
    keyboardCommitHeader.getBoundingClientRect = commitHeader.getBoundingClientRect;
    fireEvent.keyDown(keyboardCommitResizer, { key: 'ArrowRight' });
    expect(postedMessages.at(-1)).toMatchObject({
      type: 'updateLayout',
      layout: expect.objectContaining({ commitColumnWidth: 510 }),
    });

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'initialize',
            requestId: 'ready-layout-wide-column',
            repositories: [],
            pageSize: 500,
            maxCachedCommits: 5000,
            layout: {
              refsWidth: 230,
              filesWidth: 320,
              detailsHeight: 156,
              filesViewMode: 'tree',
              refsColumnWidth: 160,
            },
          },
        }),
      );
    });
    postedMessages.length = 0;
    const wideCommitResizer = screen.getByRole('separator', {
      name: 'Resize commit column',
    });
    const wideCommitHeader = wideCommitResizer.parentElement;
    expect(wideCommitHeader).not.toBeNull();
    if (!wideCommitHeader) return;
    wideCommitHeader.getBoundingClientRect = () =>
      ({
        width: 1800,
        height: 30,
        x: 0,
        y: 0,
        top: 0,
        right: 1800,
        bottom: 30,
        left: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    fireEvent.pointerDown(wideCommitResizer, { clientX: 300 });
    fireEvent.pointerMove(window, { clientX: 310 });
    fireEvent.pointerUp(window);
    expect(postedMessages.at(-1)).toMatchObject({
      type: 'updateLayout',
      layout: expect.objectContaining({ commitColumnWidth: 1810 }),
    });

    postedMessages.length = 0;
    fireEvent.click(screen.getByRole('button', { name: 'Collapse references pane' }));
    expect(screen.queryByRole('navigation', { name: 'Git references' })).not.toBeInTheDocument();
    expect(postedMessages.at(-1)).toMatchObject({
      type: 'updateLayout',
      layout: expect.objectContaining({ refsCollapsed: true }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Collapse changed files pane' }));
    expect(screen.queryByRole('region', { name: 'Changed files' })).not.toBeInTheDocument();
    expect(postedMessages.at(-1)).toMatchObject({
      type: 'updateLayout',
      layout: expect.objectContaining({ filesCollapsed: true }),
    });
  });

  it('collapses the files track and resizer at narrow widths while keeping a restore control', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn((query: string) => ({
        matches: query === '(max-width: 900px)',
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });

    render(<App />);

    expect(document.querySelector('.workbench-shell')).toHaveClass('files-collapsed');
    expect(screen.queryByRole('region', { name: 'Changed files' })).not.toBeInTheDocument();
    expect(screen.queryByRole('separator', { name: 'Resize changed files pane' })).not.toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Git references' })).toBeInTheDocument();
    expect(screen.getByRole('toolbar', { name: 'Global Git actions' })).toBeInTheDocument();
    expect(document.querySelector<HTMLElement>('.workspace-grid')?.style.gridTemplateColumns).toBe(
      '220px 1px minmax(340px, 1fr) 0px 0px',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Expand changed files pane' }));

    expect(screen.getByRole('region', { name: 'Changed files' })).toBeInTheDocument();
    expect(screen.getByRole('separator', { name: 'Resize changed files pane' })).toBeInTheDocument();
    expect(document.querySelector('.workbench-shell')).not.toHaveClass('files-collapsed');
  });

  it('offers retry, Git output, and diagnostic actions for errors', () => {
    render(<App />);
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'error',
            requestId: 'error-1',
            message: 'Git authentication failed.',
          },
        }),
      );
    });
    postedMessages.length = 0;

    fireEvent.click(screen.getByRole('button', { name: 'Retry Git query' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show Git output' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostic' }));

    expect(postedMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'refresh' }),
        expect.objectContaining({ type: 'showOutput' }),
        expect.objectContaining({
          type: 'copyToClipboard',
          text: 'Git authentication failed.',
        }),
      ]),
    );
  });

  it('dismisses an error banner after five seconds', () => {
    vi.useFakeTimers();
    render(<App />);
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'error',
            requestId: 'temporary-error',
            message: 'Temporary Git error.',
          },
        }),
      );
    });

    expect(screen.getByRole('alert')).toHaveTextContent('Temporary Git error.');
    act(() => vi.advanceTimersByTime(4_999));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('offers a warning-styled force delete after an unmerged branch deletion fails', () => {
    render(<App />);
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'initialize',
            requestId: 'ready-force-delete',
            repositories: [
              {
                id: 'repo-force-delete',
                rootUri: 'file:///workspace/force-delete',
                gitDirUri: 'file:///workspace/force-delete/.git',
                displayName: 'force-delete',
                isBare: false,
              },
            ],
            selectedRepositoryId: 'repo-force-delete',
            pageSize: 500,
            maxCachedCommits: 5000,
            layout: {
              refsWidth: 220,
              filesWidth: 320,
              detailsHeight: 156,
              filesViewMode: 'tree',
            },
          },
        }),
      );
    });
    fireEvent.click(screen.getByRole('button', { name: 'Fetch remotes' }));
    const operation = postedMessages.find((message) => message.type === 'runOperation');
    expect(operation?.type).toBe('runOperation');
    if (!operation || operation.type !== 'runOperation') return;
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'error',
            requestId: operation.requestId,
            repositoryId: 'repo-force-delete',
            message: "error: the branch 'feature/assets-fix' is not fully merged",
            recovery: { kind: 'forceDeleteBranch', branch: 'feature/assets-fix' },
          },
        }),
      );
    });
    postedMessages.length = 0;

    const forceDelete = screen.getByRole('button', {
      name: 'Force delete branch feature/assets-fix',
    });
    expect(forceDelete).toHaveClass('warning-action');
    fireEvent.click(forceDelete);

    expect(postedMessages.at(-1)).toMatchObject({
      type: 'runOperation',
      repositoryId: 'repo-force-delete',
      operation: { kind: 'deleteBranch', name: 'feature/assets-fix', force: true },
    });
  });

  it('ignores an older same-repository error after a newer filter request starts', () => {
    vi.useFakeTimers();
    render(<App />);
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'initialize',
            requestId: 'ready-request-order',
            repositories: [
              {
                id: 'repo-order',
                rootUri: 'file:///workspace/order',
                gitDirUri: 'file:///workspace/order/.git',
                displayName: 'order',
                isBare: false,
              },
            ],
            selectedRepositoryId: 'repo-order',
            pageSize: 500,
            layout: {
              refsWidth: 220,
              filesWidth: 320,
              detailsHeight: 156,
              filesViewMode: 'tree',
            },
          },
        }),
      );
    });
    const search = screen.getByRole('searchbox', { name: 'Text or hash' });
    fireEvent.change(search, { target: { value: 'older' } });
    act(() => vi.advanceTimersByTime(200));
    const older = postedMessages.filter((message) => message.type === 'updateFilters').at(-1);
    fireEvent.change(search, { target: { value: 'newer' } });
    act(() => vi.advanceTimersByTime(200));
    const newer = postedMessages.filter((message) => message.type === 'updateFilters').at(-1);
    expect(older?.type).toBe('updateFilters');
    expect(newer?.type).toBe('updateFilters');
    if (!older || older.type !== 'updateFilters' || !newer || newer.type !== 'updateFilters') return;

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'loading',
            requestId: newer.requestId,
            repositoryId: 'repo-order',
            scope: 'log',
          },
        }),
      );
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'error',
            requestId: older.requestId,
            repositoryId: 'repo-order',
            message: 'STALE SAME REPOSITORY ERROR',
          },
        }),
      );
    });

    expect(screen.queryByText('STALE SAME REPOSITORY ERROR')).not.toBeInTheDocument();
  });

  it('keeps the active search draft when a repository refresh returns older filters', () => {
    vi.useFakeTimers();
    render(<App />);
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'initialize',
            requestId: 'ready-search-draft',
            repositories: [
              {
                id: 'repo-search-draft',
                rootUri: 'file:///workspace/search-draft',
                gitDirUri: 'file:///workspace/search-draft/.git',
                displayName: 'search-draft',
                isBare: false,
              },
            ],
            selectedRepositoryId: 'repo-search-draft',
            pageSize: 500,
            maxCachedCommits: 5000,
            layout: {
              refsWidth: 220,
              filesWidth: 320,
              detailsHeight: 156,
              filesViewMode: 'tree',
            },
          },
        }),
      );
    });

    const search = screen.getByRole('searchbox', { name: 'Text or hash' });
    search.focus();
    fireEvent.change(search, { target: { value: 'firebase notification' } });
    expect(search).toHaveValue('firebase notification');

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'repositoryData',
            requestId: 'watch-refresh-with-old-filters',
            repositoryId: 'repo-search-draft',
            refs: [],
            commits: [],
            filters: { text: '', branches: [], authors: [], paths: [] },
            replace: true,
            hasMore: false,
              },
        }),
      );
    });

    expect(search).toHaveValue('firebase notification');
    expect(search).toHaveFocus();

    act(() => vi.advanceTimersByTime(200));
    const filterRequest = postedMessages.at(-1);
    expect(filterRequest).toMatchObject({
      type: 'updateFilters',
      filters: expect.objectContaining({ text: 'firebase notification' }),
    });
    expect(filterRequest?.type).toBe('updateFilters');
    if (!filterRequest || filterRequest.type !== 'updateFilters') return;

    search.blur();
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'repositoryData',
            requestId: 'watch-refresh-after-filter-request',
            repositoryId: 'repo-search-draft',
            refs: [],
            commits: [],
            filters: { text: '', branches: [], authors: [], paths: [] },
            replace: true,
            hasMore: false,
          },
        }),
      );
    });
    expect(search).toHaveValue('firebase notification');

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'repositoryData',
            requestId: filterRequest.requestId,
            repositoryId: 'repo-search-draft',
            refs: [],
            commits: [],
            filters: filterRequest.filters,
            replace: true,
            hasMore: false,
          },
        }),
      );
    });
    expect(search).toHaveValue('firebase notification');
  });

  it('clears a pending search draft when switching repositories', () => {
    vi.useFakeTimers();
    render(<App />);
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'initialize',
            requestId: 'ready-search-repository-switch',
            repositories: [
              {
                id: 'repo-search-a',
                rootUri: 'file:///workspace/search-a',
                gitDirUri: 'file:///workspace/search-a/.git',
                displayName: 'search-a',
                isBare: false,
              },
              {
                id: 'repo-search-b',
                rootUri: 'file:///workspace/search-b',
                gitDirUri: 'file:///workspace/search-b/.git',
                displayName: 'search-b',
                isBare: false,
              },
            ],
            selectedRepositoryId: 'repo-search-a',
            pageSize: 500,
            maxCachedCommits: 5000,
            layout: {
              refsWidth: 220,
              filesWidth: 320,
              detailsHeight: 156,
              filesViewMode: 'tree',
            },
          },
        }),
      );
    });

    const search = screen.getByRole('searchbox', { name: 'Text or hash' });
    fireEvent.change(search, { target: { value: 'repository a draft' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Repository' }), {
      target: { value: 'repo-search-b' },
    });

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'repositoryData',
            requestId: 'repository-b-data',
            repositoryId: 'repo-search-b',
            refs: [],
            commits: [],
            filters: {
              text: 'repository b filter',
              branches: [],
              authors: [],
              paths: [],
            },
            replace: true,
            hasMore: false,
          },
        }),
      );
    });

    expect(search).toHaveValue('repository b filter');
    act(() => vi.advanceTimersByTime(200));
    expect(postedMessages.filter((message) => message.type === 'updateFilters')).toHaveLength(0);
  });

  it('resolves a pending search when a newer refresh returns the same filters', () => {
    vi.useFakeTimers();
    render(<App />);
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'initialize',
            requestId: 'ready-search-refresh',
            repositories: [
              {
                id: 'repo-search-refresh',
                rootUri: 'file:///workspace/search-refresh',
                gitDirUri: 'file:///workspace/search-refresh/.git',
                displayName: 'search-refresh',
                isBare: false,
              },
            ],
            selectedRepositoryId: 'repo-search-refresh',
            pageSize: 500,
            maxCachedCommits: 5000,
            layout: {
              refsWidth: 220,
              filesWidth: 320,
              detailsHeight: 156,
              filesViewMode: 'tree',
            },
          },
        }),
      );
    });

    const search = screen.getByRole('searchbox', { name: 'Text or hash' });
    fireEvent.change(search, { target: { value: 'stable filter' } });
    act(() => vi.advanceTimersByTime(200));
    const filterRequest = postedMessages.filter((message) => message.type === 'updateFilters').at(-1);
    expect(filterRequest?.type).toBe('updateFilters');
    if (!filterRequest || filterRequest.type !== 'updateFilters') return;

    fireEvent.click(screen.getByRole('button', { name: 'Refresh log' }));
    const refreshRequest = postedMessages.filter((message) => message.type === 'refresh').at(-1);
    expect(refreshRequest?.type).toBe('refresh');
    if (!refreshRequest || refreshRequest.type !== 'refresh') return;

    const repositoryData = (requestId: string, text: string): void => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'repositoryData',
            requestId,
            repositoryId: 'repo-search-refresh',
            refs: [],
            commits: [],
            filters: { text, branches: [], authors: [], paths: [] },
            replace: true,
            hasMore: false,
          },
        }),
      );
    };

    act(() => {
      repositoryData(filterRequest.requestId, 'stable filter');
      repositoryData(refreshRequest.requestId, 'stable filter');
    });
    expect(search).toHaveValue('stable filter');

    act(() => repositoryData('watch-after-confirmed-refresh', ''));
    expect(search).toHaveValue('');
  });

  it('shows a structured skeleton while the first log page loads', () => {
    render(<App />);
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'loading', requestId: 'loading-1', scope: 'log' },
        }),
      );
    });

    expect(screen.getByRole('status', { name: 'Loading Git history' })).toBeInTheDocument();
    expect(screen.getAllByTestId('commit-skeleton-row')).toHaveLength(10);
  });

  it('does not offer Git write actions for a bare repository', () => {
    render(<App />);
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'initialize',
            requestId: 'ready-bare',
            repositories: [
              {
                id: 'bare',
                rootUri: 'file:///workspace/project.git',
                gitDirUri: 'file:///workspace/project.git',
                displayName: 'project.git',
                isBare: true,
              },
            ],
            selectedRepositoryId: 'bare',
            pageSize: 500,
            layout: {
              refsWidth: 220,
              filesWidth: 320,
              detailsHeight: 156,
              filesViewMode: 'tree',
            },
          },
        }),
      );
    });

    expect(screen.getByRole('button', { name: 'Fetch remotes' })).toBeDisabled();
  });

  it('persists the commit scroll anchor in Webview and workspace state', () => {
    vi.useFakeTimers();
    render(<App />);
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'initialize',
            requestId: 'ready-scroll',
            repositories: [
              {
                id: 'repo-scroll',
                rootUri: 'file:///workspace/project',
                gitDirUri: 'file:///workspace/project/.git',
                displayName: 'project',
                isBare: false,
              },
            ],
            selectedRepositoryId: 'repo-scroll',
            pageSize: 500,
            layout: {
              refsWidth: 220,
              filesWidth: 320,
              detailsHeight: 156,
              filesViewMode: 'tree',
            },
          },
        }),
      );
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'repositoryData',
            requestId: 'ready-scroll',
            repositoryId: 'repo-scroll',
            refs: [],
            commits: [
              {
                hash: 'a'.repeat(40),
                parents: [],
                subject: 'scroll commit',
                authorName: 'Alice',
                authorEmail: 'alice@example.com',
                authorTime: 1,
                commitTime: 1,
                refs: [],
              },
            ],
            filters: { text: '', branches: [], authors: [], paths: [] },
            replace: true,
            hasMore: false,
          },
        }),
      );
    });
    const viewport = document.querySelector('.commit-viewport');
    expect(viewport).not.toBeNull();
    if (!viewport) return;
    Object.defineProperty(viewport, 'scrollTop', {
      configurable: true,
      value: 84,
      writable: true,
    });
    fireEvent.scroll(viewport);

    expect(setWebviewState).toHaveBeenCalledWith({
      scrollTopByRepository: { 'repo-scroll': 84 },
    });
    act(() => vi.advanceTimersByTime(250));
    expect(postedMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'updateScrollAnchor',
          repositoryId: 'repo-scroll',
          scrollTop: 84,
        }),
      ]),
    );
  });

  it('keeps history scrolling isolated and restores the normal log scroll position on close', () => {
    vi.useFakeTimers();
    render(<App />);
    const normalHash = 'a'.repeat(40);
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'initialize',
            requestId: 'ready-history-scroll',
            repositories: [
              {
                id: 'repo-history-scroll',
                rootUri: 'file:///workspace/project',
                gitDirUri: 'file:///workspace/project/.git',
                displayName: 'project',
                isBare: false,
              },
            ],
            selectedRepositoryId: 'repo-history-scroll',
            pageSize: 500,
            layout: {
              refsWidth: 220,
              filesWidth: 320,
              detailsHeight: 156,
              filesViewMode: 'tree',
            },
          },
        }),
      );
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'repositoryData',
            requestId: 'ready-history-scroll',
            repositoryId: 'repo-history-scroll',
            refs: [],
            commits: [
              {
                hash: normalHash,
                parents: [],
                subject: 'normal commit',
                authorName: 'Alice',
                authorEmail: 'alice@example.com',
                authorTime: 1,
                commitTime: 1,
                refs: [],
              },
            ],
            filters: { text: '', branches: [], authors: [], paths: [] },
            replace: true,
            hasMore: false,
          },
        }),
      );
    });
    const viewport = document.querySelector<HTMLElement>('.commit-viewport');
    expect(viewport).not.toBeNull();
    if (!viewport) return;
    Object.defineProperty(viewport, 'scrollTop', { configurable: true, value: 84, writable: true });
    fireEvent.scroll(viewport);
    act(() => vi.advanceTimersByTime(250));

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'historyOpened',
            requestId: 'history-scroll-opened',
            repositoryId: 'repo-history-scroll',
            kind: 'file',
            path: 'src/app.ts',
            entries: [
              {
                hash: 'b'.repeat(40),
                parents: [normalHash],
                subject: 'history commit',
                authorName: 'Alice',
                authorEmail: 'alice@example.com',
                authorTime: 2,
                commitTime: 2,
                refs: [],
                path: 'src/app.ts',
                additions: 1,
                deletions: 0,
                binary: false,
              },
            ],
            replace: true,
            hasMore: false,
          },
        }),
      );
    });
    expect(viewport.scrollTop).toBe(0);
    postedMessages.splice(0);
    setWebviewState.mockClear();
    viewport.scrollTop = 36;
    fireEvent.scroll(viewport);
    act(() => vi.advanceTimersByTime(250));
    expect(setWebviewState).not.toHaveBeenCalled();
    expect(postedMessages).not.toContainEqual(expect.objectContaining({ type: 'updateScrollAnchor' }));

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'historyClosed',
            requestId: 'history-scroll-closed',
            repositoryId: 'repo-history-scroll',
          },
        }),
      );
    });
    expect(viewport.scrollTop).toBe(84);
  });

  it('groups remote refs, collapses ref groups, and locates a ref tip with keyboard navigation', () => {
    render(<App />);
    const mainHash = 'a'.repeat(40);
    const remoteHash = 'b'.repeat(40);
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'initialize',
            requestId: 'ready-refs-ui',
            repositories: [
              {
                id: 'repo-refs',
                rootUri: 'file:///workspace/project',
                gitDirUri: 'file:///workspace/project/.git',
                displayName: 'project',
                isBare: false,
                currentBranch: 'main',
                head: mainHash,
              },
            ],
            selectedRepositoryId: 'repo-refs',
            pageSize: 500,
            layout: {
              refsWidth: 220,
              filesWidth: 320,
              detailsHeight: 156,
              filesViewMode: 'tree',
            },
          },
        }),
      );
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'repositoryData',
            requestId: 'ready-refs-ui',
            repositoryId: 'repo-refs',
            refs: [
              {
                fullName: 'refs/heads/main',
                shortName: 'main',
                kind: 'local',
                target: mainHash,
                ahead: 0,
                behind: 0,
                isCurrent: true,
              },
              {
                fullName: 'refs/remotes/origin/feature',
                shortName: 'origin/feature',
                kind: 'remote',
                remote: 'origin',
                target: remoteHash,
                ahead: 0,
                behind: 0,
                isCurrent: false,
              },
              {
                fullName: 'refs/remotes/origin/HEAD',
                shortName: 'origin/HEAD',
                kind: 'remote',
                remote: 'origin',
                target: mainHash,
                ahead: 0,
                behind: 0,
                isCurrent: false,
              },
              {
                fullName: 'refs/remotes/upstream/main',
                shortName: 'upstream/main',
                kind: 'remote',
                remote: 'upstream',
                target: mainHash,
                ahead: 0,
                behind: 0,
                isCurrent: false,
              },
              {
                fullName: 'refs/tags/v1',
                shortName: 'v1',
                kind: 'tag',
                target: remoteHash,
                ahead: 0,
                behind: 0,
                isCurrent: false,
              },
            ],
            commits: [
              {
                hash: mainHash,
                parents: [remoteHash],
                subject: 'main commit',
                authorName: 'Alice',
                authorEmail: 'alice@example.com',
                authorTime: 2,
                commitTime: 2,
                refs: [],
              },
              {
                hash: remoteHash,
                parents: [],
                subject: 'remote commit',
                authorName: 'Bob',
                authorEmail: 'bob@example.com',
                authorTime: 1,
                commitTime: 1,
                refs: [],
              },
            ],
            filters: { text: '', branches: [], authors: [], paths: [] },
            replace: true,
            hasMore: false,
          },
        }),
      );
    });

    expect(screen.getByRole('group', { name: 'Remote origin' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Remote upstream' })).toBeInTheDocument();
    const localHeading = screen.getByRole('button', { name: /Local/u });
    fireEvent.click(localHeading);
    expect(screen.queryByTitle('refs/heads/main')).not.toBeInTheDocument();
    fireEvent.click(localHeading);
    const local = screen.getByTitle('refs/heads/main');
    const remote = screen.getByTitle('refs/remotes/origin/feature');
    local.focus();
    fireEvent.keyDown(local, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(remote);
    fireEvent.keyDown(remote, { key: 'Enter' });
    expect(postedMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'selectCommit',
          repositoryId: 'repo-refs',
          hash: remoteHash,
        }),
      ]),
    );

    fireEvent.contextMenu(local);
    let menu = screen.getByRole('menu', { name: 'ref actions' });
    expect(within(menu).getByRole('menuitem', { name: 'Checkout' })).toBeDisabled();
    expect(within(menu).getByRole('menuitem', { name: 'Merge into Current' })).toBeDisabled();
    expect(within(menu).getByRole('menuitem', { name: 'Rebase Current onto' })).toBeDisabled();
    expect(within(menu).getByRole('menuitem', { name: 'Push' })).toBeEnabled();
    expect(within(menu).getByRole('menuitem', { name: 'Delete…' })).toBeDisabled();

    fireEvent.contextMenu(remote);
    menu = screen.getByRole('menu', { name: 'ref actions' });
    expect(within(menu).queryByRole('menuitem', { name: 'Checkout' })).not.toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: 'Rename…' })).not.toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: 'Delete…' })).not.toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Checkout as New Local…' })).toBeEnabled();
    expect(within(menu).getByRole('menuitem', { name: 'Fetch' })).toBeEnabled();
    expect(within(menu).getByRole('menuitem', { name: 'Delete Remote Branch…' })).toBeEnabled();
    expect(within(menu).getByRole('menuitem', { name: 'New Branch from…' })).toBeEnabled();

    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Checkout as New Local…' }));
    expect(screen.getByRole('textbox', { name: 'Local branch name' })).toHaveValue('feature');
    fireEvent.click(screen.getByRole('button', { name: 'Checkout' }));
    completeLatestOperation();
    fireEvent.contextMenu(remote);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Fetch' }));
    completeLatestOperation();
    fireEvent.contextMenu(remote);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete Remote Branch…' }));

    fireEvent.contextMenu(screen.getByTitle('refs/remotes/origin/HEAD'));
    menu = screen.getByRole('menu', { name: 'ref actions' });
    expect(within(menu).queryByRole('menuitem', { name: 'Checkout as New Local…' })).not.toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: 'Delete Remote Branch…' })).not.toBeInTheDocument();

    fireEvent.contextMenu(screen.getByTitle('refs/tags/v1'));
    menu = screen.getByRole('menu', { name: 'ref actions' });
    expect(within(menu).getByRole('menuitem', { name: 'Checkout' })).toBeEnabled();
    expect(within(menu).getByRole('menuitem', { name: 'Delete Local Tag…' })).toBeEnabled();
    expect(within(menu).queryByRole('menuitem', { name: 'Merge into Current' })).not.toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: 'Rebase Current onto' })).not.toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'New Branch from…' })).toBeEnabled();

    fireEvent.contextMenu(screen.getByTitle(mainHash));
    const headMenu = screen.getByRole('menu', { name: 'head actions' });
    expect(within(headMenu).getByRole('menuitem', { name: 'Copy Revision' })).toBeEnabled();
    expect(within(headMenu).getByRole('menuitem', { name: 'Create Branch…' })).toBeEnabled();
    expect(within(headMenu).getByRole('menuitem', { name: 'Create Tag…' })).toBeEnabled();

    expect(postedMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'runOperation',
          operation: {
            kind: 'checkoutRemote',
            name: 'feature',
            startPoint: 'origin/feature',
          },
        }),
        expect.objectContaining({
          type: 'runOperation',
          operation: { kind: 'fetch', remote: 'origin' },
        }),
        expect.objectContaining({
          type: 'runOperation',
          operation: {
            kind: 'deleteRemoteBranch',
            remote: 'origin',
            branch: 'feature',
          },
        }),
      ]),
    );
  });

  it('moves commit focus with arrow keys and exposes complete details and compare/copy actions', () => {
    render(<App />);
    const childHash = 'c'.repeat(40);
    const parentHash = 'd'.repeat(40);
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'initialize',
            requestId: 'ready-details-ui',
            repositories: [
              {
                id: 'repo-details',
                rootUri: 'file:///workspace/project',
                gitDirUri: 'file:///workspace/project/.git',
                displayName: 'project',
                isBare: false,
                currentBranch: 'main',
                head: childHash,
              },
            ],
            selectedRepositoryId: 'repo-details',
            pageSize: 500,
            layout: {
              refsWidth: 220,
              filesWidth: 320,
              detailsHeight: 156,
              filesViewMode: 'tree',
            },
          },
        }),
      );
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'repositoryData',
            requestId: 'ready-details-ui',
            repositoryId: 'repo-details',
            refs: [],
            commits: [
              {
                hash: childHash,
                parents: [parentHash],
                subject: 'child commit',
                authorName: 'Alice',
                authorEmail: 'alice@example.com',
                authorTime: 2,
                commitTime: 3,
                refs: [],
              },
              {
                hash: parentHash,
                parents: [],
                subject: 'parent commit',
                authorName: 'Bob',
                authorEmail: 'bob@example.com',
                authorTime: 1,
                commitTime: 1,
                refs: [],
              },
            ],
            filters: { text: '', branches: [], authors: [], paths: [] },
            replace: true,
            hasMore: false,
          },
        }),
      );
    });
    const childRow = screen.getByText('child commit').closest('[role="row"]') as HTMLElement;
    const parentRow = screen.getByText('parent commit').closest('[role="row"]') as HTMLElement;
    childRow.focus();
    fireEvent.keyDown(childRow, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(parentRow);

    fireEvent.click(childRow);
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'selectionDetailsLoaded',
            requestId: postedMessages.filter((message) => message.type === 'selectCommit').at(-1)?.requestId,
            repositoryId: 'repo-details',
            selectedParent: parentHash,
            details: {
              hash: childHash,
              parents: [parentHash],
              subject: 'child commit',
              body: 'child commit\n\nfull message\n',
              authorName: 'Alice',
              authorEmail: 'alice@example.com',
              authorTime: 2,
              commitTime: 3,
              committerName: 'Build Bot',
              committerEmail: 'bot@example.com',
              refs: [
                {
                  fullName: 'refs/tags/v1',
                  shortName: 'v1',
                  kind: 'tag',
                  target: childHash,
                  ahead: 0,
                  behind: 0,
                  isCurrent: false,
                },
              ],
              signature: 'good',
            },
            files: [
              {
                status: 'M',
                path: 'src/app.ts',
                additions: 1,
                deletions: 1,
                binary: false,
              },
            ],
          },
        }),
      );
    });

    expect(screen.getByText(/Build Bot/u)).toBeInTheDocument();
    expect(screen.getByText(/bot@example.com/u)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Parent ${parentHash}` })).toBeInTheDocument();
    expect(screen.getByText('v1')).toBeInTheDocument();
    expect(screen.getByText(/Signature: good/u)).toBeInTheDocument();
    postedMessages.length = 0;
    const copyHashButton = screen.getByRole('button', { name: 'Copy full commit hash' });
    fireEvent.click(copyHashButton);
    const copyHashMessage = postedMessages.at(-1);
    expect(copyHashMessage).toMatchObject({ type: 'copyToClipboard', text: childHash });
    expect(copyHashButton).toHaveTextContent('Copying…');
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'clipboardCopied',
            requestId: copyHashMessage?.requestId,
          },
        }),
      );
    });
    expect(copyHashButton).toHaveTextContent('Copied');
    childRow.focus();
    fireEvent.keyDown(childRow, { key: 'c', ctrlKey: true });
    expect(postedMessages.at(-1)).toMatchObject({
      type: 'copyToClipboard',
      text: childHash,
    });
    fireEvent.contextMenu(childRow);
    expect(screen.queryByRole('menuitem', { name: 'Show Details' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Checkout Revision' }));
    expect(postedMessages.at(-1)).toMatchObject({
      type: 'runOperation',
      repositoryId: 'repo-details',
      operation: { kind: 'checkout', ref: childHash },
    });
    fireEvent.contextMenu(childRow);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Compare with Parent' }));
    fireEvent.contextMenu(childRow);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy Hash' }));
    fireEvent.click(screen.getByText('app.ts'));
    expect(screen.getByRole('status', { name: 'Changed file preview' })).toHaveTextContent(
      'src/app.ts · Modified · +1 −1',
    );
    fireEvent.contextMenu(screen.getByText('app.ts'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open File at Revision' }));
    fireEvent.contextMenu(screen.getByText('app.ts'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open Current File' }));
    fireEvent.contextMenu(screen.getByText('app.ts'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy Path' }));

    expect(postedMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'openCommitComparison',
          repositoryId: 'repo-details',
          hash: childHash,
          mode: 'parent',
          parent: parentHash,
        }),
        expect.objectContaining({
          type: 'runOperation',
          repositoryId: 'repo-details',
          operation: { kind: 'checkout', ref: childHash },
        }),
        expect.objectContaining({ type: 'copyToClipboard', text: childHash }),
        expect.objectContaining({
          type: 'openFile',
          mode: 'revision',
          path: 'src/app.ts',
        }),
        expect.objectContaining({
          type: 'openFile',
          mode: 'current',
          path: 'src/app.ts',
        }),
        expect.objectContaining({
          type: 'copyToClipboard',
          text: 'src/app.ts',
        }),
      ]),
    );
  });

  it('dismisses popovers on outside pointer input and closes context menus after actions', () => {
    render(<App />);
    const hash = 'f'.repeat(40);
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'initialize',
            requestId: 'ready-menu-dismissal',
            repositories: [
              {
                id: 'repo-menu-dismissal',
                rootUri: 'file:///workspace/project',
                gitDirUri: 'file:///workspace/project/.git',
                displayName: 'project',
                isBare: false,
              },
            ],
            selectedRepositoryId: 'repo-menu-dismissal',
            pageSize: 500,
            maxCachedCommits: 5000,
            layout: {
              refsWidth: 220,
              filesWidth: 320,
              detailsHeight: 156,
              filesViewMode: 'tree',
            },
          },
        }),
      );
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'repositoryData',
            requestId: 'ready-menu-dismissal',
            repositoryId: 'repo-menu-dismissal',
            refs: [],
            commits: [
              {
                hash,
                parents: [],
                subject: 'menu target',
                authorName: 'Alice',
                authorEmail: 'alice@example.com',
                authorTime: 1,
                commitTime: 1,
                refs: [],
              },
            ],
            filters: { text: '', branches: [], authors: [], paths: [] },
            replace: true,
            hasMore: false,
          },
        }),
      );
    });

    const row = screen.getByText('menu target').closest('[role="row"]') as HTMLElement;
    fireEvent.contextMenu(row);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole('grid', { name: 'Commit log' }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy Hash' }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'User' }));
    expect(screen.getByRole('dialog', { name: 'user filter' })).toBeInTheDocument();
    const userButton = screen.getByRole('button', { name: 'User' });
    fireEvent.pointerDown(userButton);
    fireEvent.click(userButton);
    expect(screen.queryByRole('dialog', { name: 'user filter' })).not.toBeInTheDocument();

    fireEvent.click(userButton);
    expect(screen.getByRole('dialog', { name: 'user filter' })).toBeInTheDocument();
    const moreButton = screen.getByRole('button', { name: 'More actions' });
    moreButton.getBoundingClientRect = () =>
      ({
        x: 965,
        y: 5,
        top: 5,
        right: 992,
        bottom: 32,
        left: 965,
        width: 27,
        height: 27,
        toJSON: () => ({}),
      }) as DOMRect;
    fireEvent.pointerDown(moreButton);
    fireEvent.click(moreButton);
    expect(screen.queryByRole('dialog', { name: 'user filter' })).not.toBeInTheDocument();
    expect(screen.getByRole('menu', { name: 'toolbar actions' })).toHaveStyle({ left: '802px' });

    fireEvent.pointerDown(moreButton);
    fireEvent.click(moreButton);
    expect(screen.queryByRole('menu', { name: 'toolbar actions' })).not.toBeInTheDocument();

    fireEvent.click(userButton);
    fireEvent.pointerDown(screen.getByRole('grid', { name: 'Commit log' }));
    expect(screen.queryByRole('dialog', { name: 'user filter' })).not.toBeInTheDocument();
  });

  it('offers the configured Git identity as a pinned Me filter even when it is not loaded', () => {
    render(<App />);
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'initialize',
            requestId: 'ready-current-user',
            repositories: [
              {
                id: 'repo-current-user',
                rootUri: 'file:///workspace/project',
                gitDirUri: 'file:///workspace/project/.git',
                displayName: 'project',
                isBare: false,
                userName: 'Current User',
                userEmail: 'Current@Example.com',
              },
            ],
            selectedRepositoryId: 'repo-current-user',
            pageSize: 500,
            maxCachedCommits: 5000,
            layout: {
              refsWidth: 220,
              filesWidth: 320,
              detailsHeight: 156,
              filesViewMode: 'tree',
            },
          },
        }),
      );
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'repositoryData',
            requestId: 'ready-current-user',
            repositoryId: 'repo-current-user',
            refs: [],
            commits: [
              {
                hash: '1'.repeat(40),
                parents: [],
                subject: 'other',
                authorName: 'Other User',
                authorEmail: 'other@example.com',
                authorTime: 3,
                commitTime: 3,
                refs: [],
              },
              {
                hash: '2'.repeat(40),
                parents: [],
                subject: 'self with differently cased email',
                authorName: 'Current User',
                authorEmail: 'current@example.com',
                authorTime: 2,
                commitTime: 2,
                refs: [],
              },
              {
                hash: '3'.repeat(40),
                parents: [],
                subject: 'another',
                authorName: 'Another User',
                authorEmail: 'another@example.com',
                authorTime: 1,
                commitTime: 1,
                refs: [],
              },
            ],
            filters: { text: '', branches: [], authors: [], paths: [] },
            replace: true,
            hasMore: false,
          },
        }),
      );
    });

    fireEvent.click(screen.getByRole('button', { name: 'User' }));
    const authorNames = [
      ...screen.getByRole('dialog', { name: 'user filter' }).querySelectorAll('.filter-option span'),
    ].map((element) => element.textContent);
    expect(authorNames).toEqual(['Me (Current User)', 'Other User', 'Another User']);

    postedMessages.length = 0;
    fireEvent.click(screen.getByRole('checkbox', { name: 'Me (Current User)' }));
    expect(postedMessages.at(-1)).toMatchObject({
      type: 'updateFilters',
      filters: expect.objectContaining({ authors: ['Current@Example.com'] }),
    });
  });

  it('renders scrollable changed files with separately colored addition and deletion counts', () => {
    render(<App />);
    const hash = 'b'.repeat(40);
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'initialize',
            requestId: 'ready-file-stats',
            repositories: [
              {
                id: 'repo-file-stats',
                rootUri: 'file:///workspace/project',
                gitDirUri: 'file:///workspace/project/.git',
                displayName: 'project',
                isBare: false,
              },
            ],
            selectedRepositoryId: 'repo-file-stats',
            pageSize: 500,
            maxCachedCommits: 5000,
            layout: {
              refsWidth: 220,
              filesWidth: 320,
              detailsHeight: 156,
              filesViewMode: 'tree',
            },
          },
        }),
      );
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'repositoryData',
            requestId: 'ready-file-stats',
            repositoryId: 'repo-file-stats',
            refs: [],
            commits: [
              {
                hash,
                parents: [],
                subject: 'file stats target',
                authorName: 'Alice',
                authorEmail: 'alice@example.com',
                authorTime: 1,
                commitTime: 1,
                refs: [],
              },
            ],
            filters: { text: '', branches: [], authors: [], paths: [] },
            replace: true,
            hasMore: false,
          },
        }),
      );
    });
    fireEvent.click(screen.getByText('file stats target'));
    const selection = postedMessages.filter((message) => message.type === 'selectCommit').at(-1);
    expect(selection?.type).toBe('selectCommit');
    if (!selection || selection.type !== 'selectCommit') return;
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'selectionDetailsLoaded',
            requestId: selection.requestId,
            repositoryId: 'repo-file-stats',
            details: {
              hash,
              parents: [],
              subject: 'file stats target',
              body: 'file stats target',
              authorName: 'Alice',
              authorEmail: 'alice@example.com',
              authorTime: 1,
              commitTime: 1,
              committerName: 'Alice',
              committerEmail: 'alice@example.com',
              refs: [],
              signature: 'none',
            },
            files: [
              {
                status: 'M',
                path: 'lib/pages/a/very/deep/path/with/a/very_long_file_name.dart',
                additions: 12,
                deletions: 7,
                binary: false,
              },
            ],
          },
        }),
      );
    });

    expect(document.querySelector('.file-list-content')).not.toBeNull();
    expect(screen.getByText('+12')).toHaveClass('file-stat-additions');
    expect(screen.getByText('−7')).toHaveClass('file-stat-deletions');
  });

  it('provides hover titles for every top toolbar action', () => {
    render(<App />);

    const expectedTitles = new Map([
      ['Refresh log', 'Refresh local repository state'],
      ['Go to HEAD', 'Select the current HEAD commit'],
      ['Fetch remotes', 'Fetch from remotes'],
      ['Collapse references pane', 'Collapse references pane'],
      ['Collapse changed files pane', 'Collapse changed files pane'],
      ['More actions', 'More Git actions'],
    ]);
    for (const [name, title] of expectedTitles) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('title', title);
    }
  });
});
