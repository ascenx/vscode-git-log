import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  layoutCommitGraph,
  type GraphContinuationState,
  type GraphLayoutResult,
} from '../../src/graph/layoutCommitGraph';
import {
  parseWebviewMessage,
  type ExtensionToWebviewMessage,
  type GitOperationRequest,
  type LogFilters,
  type WebviewToExtensionMessage,
  type WorkbenchLayout,
} from '../../src/protocol/messages';
import type {
  ChangedFile,
  CommitDetails,
  CommitSummary,
  HistoryEntry,
  RefKind,
  RefLabel,
  RepositorySummary,
} from '../../src/shared/models';
import { getVsCodeApi } from './vscodeApi';
import { CommitGraphCell } from './CommitGraphCell';
import { getVirtualRange } from './virtualRange';
import { buildFileTree, type FileTreeNode } from './buildFileTree';
import { advanceCommitWindow } from './commitWindow';

const refGroups: readonly { label: string; kind: RefKind }[] = [
  { label: 'Local', kind: 'local' },
  { label: 'Remote', kind: 'remote' },
  { label: 'Tags', kind: 'tag' },
];

const defaultLayout: WorkbenchLayout = {
  refsWidth: 220,
  filesWidth: 320,
  detailsHeight: 156,
  filesViewMode: 'tree',
  refsColumnWidth: 150,
  authorColumnWidth: 130,
  dateColumnWidth: 125,
};

const defaultFilters: LogFilters = {
  text: '',
  branches: [],
  authors: [],
  paths: [],
};

function filtersEqual(left: LogFilters, right: LogFilters): boolean {
  const sameItems = (leftItems: readonly string[], rightItems: readonly string[]): boolean =>
    leftItems.length === rightItems.length &&
    leftItems.every((item, index) => item === rightItems[index]);
  return (
    left.text === right.text &&
    left.dateFrom === right.dateFrom &&
    left.dateTo === right.dateTo &&
    sameItems(left.branches, right.branches) &&
    sameItems(left.authors, right.authors) &&
    sameItems(left.paths, right.paths)
  );
}

interface WorkbenchState {
  repositories: RepositorySummary[];
  selectedRepositoryId: string | undefined;
  refs: RefLabel[];
  commits: CommitSummary[];
  selectedHash: string | undefined;
  details: CommitDetails | undefined;
  detailsRepositoryId: string | undefined;
  selectedParent: string | undefined;
  files: ChangedFile[];
  selectedFile: ChangedFile | undefined;
  hasMore: boolean;
  pageSize: number;
  maxCachedCommits: number;
  nextLogOffset: number;
  startLogOffset: number;
  graphContinuation: GraphContinuationState | undefined;
  windowAnchorReady: boolean;
  operationRepositoryIds: ReadonlySet<string>;
  layout: WorkbenchLayout;
  filters: LogFilters;
  loading: Extract<ExtensionToWebviewMessage, { type: 'loading' }>['scope'] | undefined;
  error: string | undefined;
  history:
    | {
        repositoryId: string;
        kind: 'line' | 'file';
        path: string;
        startLine?: number;
        endLine?: number;
        entries: HistoryEntry[];
        hasMore: boolean;
        notice?: string;
      }
    | undefined;
}

type WorkbenchRequestScope = 'repositories' | 'log' | 'selection' | 'operation';

function requestScopeForMessage(message: WebviewToExtensionMessage): WorkbenchRequestScope | undefined {
  switch (message.type) {
    case 'ready':
      return 'repositories';
    case 'selectRepository':
    case 'requestLogPage':
    case 'refresh':
    case 'updateFilters':
      return 'log';
    case 'selectCommit':
    case 'selectParent':
      return 'selection';
    case 'runOperation':
      return 'operation';
    default:
      return undefined;
  }
}

const initialState: WorkbenchState = {
  repositories: [],
  selectedRepositoryId: undefined,
  refs: [],
  commits: [],
  selectedHash: undefined,
  details: undefined,
  detailsRepositoryId: undefined,
  selectedParent: undefined,
  files: [],
  selectedFile: undefined,
  hasMore: false,
  pageSize: 500,
  maxCachedCommits: 5000,
  nextLogOffset: 0,
  startLogOffset: 0,
  graphContinuation: undefined,
  windowAnchorReady: false,
  operationRepositoryIds: new Set(),
  layout: defaultLayout,
  filters: defaultFilters,
  loading: undefined,
  error: undefined,
  history: undefined,
};

function requestId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function formatDate(timestamp: number): string {
  if (!timestamp) return '';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp * 1000));
}

function changedFileStatusLabel(status: ChangedFile['status']): string {
  return (
    {
      A: 'Added',
      M: 'Modified',
      D: 'Deleted',
      R: 'Renamed',
      C: 'Copied',
      T: 'Type changed',
      U: 'Unmerged',
    } as const
  )[status];
}

function readScrollTopByRepository(value: unknown): Record<string, number> {
  if (
    value &&
    typeof value === 'object' &&
    'scrollTopByRepository' in value &&
    typeof value.scrollTopByRepository === 'object' &&
    value.scrollTopByRepository !== null
  ) {
    return { ...(value.scrollTopByRepository as Record<string, number>) };
  }
  return {};
}

interface CommitListProps {
  commits: CommitSummary[];
  graphLayout: GraphLayoutResult;
  selectedHash: string | undefined;
  headHash: string | undefined;
  hasMore: boolean;
  loading: boolean;
  initialScrollTop: number;
  onScrollTopChange(scrollTop: number): void;
  onHorizontalScroll(scrollLeft: number): void;
  onSelect(commit: CommitSummary): void;
  onContextMenu(commit: CommitSummary, x: number, y: number): void;
  onLoadMore(): void;
}

function CommitList({
  commits,
  graphLayout,
  selectedHash,
  headHash,
  hasMore,
  loading,
  initialScrollTop,
  onScrollTopChange,
  onHorizontalScroll,
  onSelect,
  onContextMenu,
  onLoadMore,
}: CommitListProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(560);
  const rowHeight = 28;
  const range = getVirtualRange({
    itemCount: commits.length,
    rowHeight,
    scrollTop,
    viewportHeight,
    overscan: 8,
  });

  const focusCommit = (index: number): void => {
    const viewport = viewportRef.current;
    const target = commits[index];
    if (!viewport || !target) return;
    const top = index * rowHeight;
    if (top < viewport.scrollTop || top + rowHeight > viewport.scrollTop + viewportHeight) {
      viewport.scrollTop = Math.max(0, top - Math.floor(viewportHeight / 2));
      setScrollTop(viewport.scrollTop);
    }
    const focus = (): void => {
      viewport.querySelector<HTMLElement>(`[data-commit-hash="${target.hash}"]`)?.focus();
    };
    focus();
    window.requestAnimationFrame(focus);
  };

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const updateHeight = (): void => setViewportHeight(viewport.clientHeight || 560);
    updateHeight();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateHeight);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollTop = initialScrollTop;
    setScrollTop(initialScrollTop);
  }, [initialScrollTop]);


  return (
    <div
      className="commit-viewport"
      ref={viewportRef}
      onScroll={(event) => {
        const viewport = event.currentTarget;
        setScrollTop(viewport.scrollTop);
        onScrollTopChange(viewport.scrollTop);
        onHorizontalScroll(viewport.scrollLeft);
        if (
          hasMore &&
          !loading &&
          viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - rowHeight * 5
        ) {
          onLoadMore();
        }
      }}
    >
      <div
        className="commit-list"
        role="rowgroup"
        style={{ height: commits.length * rowHeight + (hasMore ? 32 : 0) }}
      >
        {commits.slice(range.start, range.end).map((commit, visibleIndex) => {
          const index = range.start + visibleIndex;
          const graphRow = graphLayout.rows[index];
          return (
            <div
              className={`commit-row${selectedHash === commit.hash ? ' selected' : ''}${
                headHash === commit.hash ? ' head-row' : ''
              }`}
              style={{ top: index * rowHeight }}
              role="row"
              aria-rowindex={index + 2}
              aria-selected={selectedHash === commit.hash}
              data-commit-hash={commit.hash}
              tabIndex={0}
              key={commit.hash}
              onClick={() => onSelect(commit)}
              onContextMenu={(event) => {
                event.preventDefault();
                onContextMenu(commit, event.clientX, event.clientY);
              }}
              onKeyDown={(event) => {
                let targetIndex: number | undefined;
                if (event.key === 'ArrowUp') targetIndex = Math.max(0, index - 1);
                if (event.key === 'ArrowDown') targetIndex = Math.min(commits.length - 1, index + 1);
                if (event.key === 'PageUp') {
                  targetIndex = Math.max(0, index - Math.max(1, Math.floor(viewportHeight / rowHeight)));
                }
                if (event.key === 'PageDown') {
                  targetIndex = Math.min(
                    commits.length - 1,
                    index + Math.max(1, Math.floor(viewportHeight / rowHeight)),
                  );
                }
                if (event.key === 'Home') targetIndex = 0;
                if (event.key === 'End') {
                  targetIndex = commits.length - 1;
                  if (hasMore) onLoadMore();
                }
                if (targetIndex !== undefined) {
                  event.preventDefault();
                  const target = commits[targetIndex];
                  if (target) {
                    onSelect(target);
                    focusCommit(targetIndex);
                  }
                } else if (event.key === 'Enter' || event.key === ' ') {
                  onSelect(commit);
                }
              }}
            >
              <span className="commit-subject-cell" role="gridcell">
                {graphRow ? (
                  <CommitGraphCell row={graphRow} maxLaneCount={graphLayout.maxLaneCount} />
                ) : null}
                <span className="commit-subject">{commit.subject}</span>
                {'oldPath' in commit &&
                (commit as HistoryEntry).oldPath &&
                (commit as HistoryEntry).oldPath !== (commit as HistoryEntry).path ? (
                  <span
                    className="history-rename"
                    title={`${(commit as HistoryEntry).oldPath ?? ''} → ${(commit as HistoryEntry).path}`}
                  >
                    {(commit as HistoryEntry).oldPath} → {(commit as HistoryEntry).path}
                  </span>
                ) : null}
                {'binary' in commit ? (
                  <span className="history-stats">
                    {(commit as HistoryEntry).binary ? (
                      <span className="history-stat-binary">Binary</span>
                    ) : (
                      <>
                        {(commit as HistoryEntry).additions !== undefined ? (
                          <span className="file-stat-additions">
                            +{String((commit as HistoryEntry).additions)}
                          </span>
                        ) : null}
                        {(commit as HistoryEntry).deletions !== undefined ? (
                          <span className="file-stat-deletions">
                            −{String((commit as HistoryEntry).deletions)}
                          </span>
                        ) : null}
                      </>
                    )}
                  </span>
                ) : null}
              </span>
              <span className="commit-author" role="gridcell" title={commit.authorEmail}>
                {commit.authorName}
              </span>
              <span className="commit-date" role="gridcell">
                {formatDate(commit.commitTime)}
              </span>
              <span className="commit-refs" role="gridcell">
                {commit.refs.map((ref) => (
                  <span className={`ref-label ${ref.kind}`} key={ref.fullName}>
                    {ref.shortName}
                  </span>
                ))}
              </span>
            </div>
          );
        })}
        {hasMore ? (
          <button
            type="button"
            className="load-more"
            style={{ top: commits.length * rowHeight }}
            onClick={onLoadMore}
          >
            {loading ? 'Loading…' : 'Load more commits'}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ChangedFileRow({
  file,
  depth = 0,
  onOpen,
  onSelect,
  onContextMenu,
}: {
  file: ChangedFile;
  depth?: number;
  onOpen(file: ChangedFile): void;
  onSelect(file: ChangedFile): void;
  onContextMenu(file: ChangedFile, x: number, y: number): void;
}) {
  return (
    <button
      type="button"
      className="file-row"
      style={{ paddingLeft: 10 + depth * 14 }}
      title={file.binary ? `${file.path} is binary` : file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
      onClick={() => onSelect(file)}
      onDoubleClick={() => onOpen(file)}
      onContextMenu={(event) => {
        event.preventDefault();
        onSelect(file);
        onContextMenu(file, event.clientX, event.clientY);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onOpen(file);
      }}
    >
      <span className={`file-status status-${file.status}`}>{file.status}</span>
      <span className="file-path">{file.path.split('/').at(-1)}</span>
      {file.additions !== undefined || file.deletions !== undefined ? (
        <span className="file-stats">
          {file.additions !== undefined ? (
            <span className="file-stat-additions">+{String(file.additions)}</span>
          ) : null}
          {file.deletions !== undefined ? (
            <span className="file-stat-deletions">−{String(file.deletions)}</span>
          ) : null}
        </span>
      ) : null}
    </button>
  );
}

function FileTreeNodes({
  nodes,
  depth,
  onOpen,
  onSelect,
  onContextMenu,
}: {
  nodes: FileTreeNode[];
  depth: number;
  onOpen(file: ChangedFile): void;
  onSelect(file: ChangedFile): void;
  onContextMenu(file: ChangedFile, x: number, y: number): void;
}) {
  return nodes.map((node) =>
    node.type === 'directory' ? (
      <details className="file-directory" open key={node.path}>
        <summary style={{ paddingLeft: 8 + depth * 14 }}>{node.name}</summary>
        <FileTreeNodes
          nodes={node.children}
          depth={depth + 1}
          onOpen={onOpen}
          onSelect={onSelect}
          onContextMenu={onContextMenu}
        />
      </details>
    ) : (
      <ChangedFileRow
        file={node.file}
        depth={depth}
        onOpen={onOpen}
        onSelect={onSelect}
        onContextMenu={onContextMenu}
        key={node.path}
      />
    ),
  );
}

export function App() {
  const vscode = useMemo(() => getVsCodeApi(), []);
  const [state, setState] = useState<WorkbenchState>(initialState);
  const [scrollTopByRepository, setScrollTopByRepository] = useState<Record<string, number>>(() =>
    readScrollTopByRepository(vscode.getState()),
  );
  const [filterPopup, setFilterPopup] = useState<'branch' | 'user' | 'date' | 'paths' | undefined>();
  const [contextMenu, setContextMenu] = useState<
    | { kind: 'commit'; repositoryId: string; commit: CommitSummary; x: number; y: number }
    | { kind: 'ref'; repositoryId: string; ref: RefLabel; x: number; y: number }
    | { kind: 'file'; repositoryId: string; file: ChangedFile; x: number; y: number }
    | { kind: 'toolbar'; repositoryId: string; x: number; y: number }
    | { kind: 'head'; repositoryId: string; hash: string; x: number; y: number }
    | undefined
  >();
  const [namedOperation, setNamedOperation] = useState<
    | { kind: 'createBranch'; repositoryId: string; target: string; value: string }
    | { kind: 'createTag'; repositoryId: string; target: string; value: string }
    | { kind: 'renameBranch'; repositoryId: string; oldName: string; value: string }
    | { kind: 'checkoutRemote'; repositoryId: string; startPoint: string; value: string }
    | undefined
  >();
  const [historyParentPicker, setHistoryParentPicker] = useState<
    { repositoryId: string; commit: CommitSummary } | undefined
  >();
  const [customDateFrom, setCustomDateFrom] = useState('');
  const [customDateTo, setCustomDateTo] = useState('');
  const [detailsHashCopyState, setDetailsHashCopyState] = useState<
    'idle' | 'copying' | 'copied'
  >('idle');
  const [collapsedRefGroups, setCollapsedRefGroups] = useState<Set<string>>(new Set());
  const [responsiveCollapse, setResponsiveCollapse] = useState(() => ({
    files: window.matchMedia?.('(max-width: 900px)').matches ?? false,
    refs: window.matchMedia?.('(max-width: 680px)').matches ?? false,
  }));
  const [responsiveExpanded, setResponsiveExpanded] = useState({ files: false, refs: false });
  const filterTimer = useRef<number | undefined>(undefined);
  const detailsHashCopyRequest = useRef<string | undefined>(undefined);
  const detailsHashCopyTimer = useRef<number | undefined>(undefined);
  const pendingFiltersRef = useRef<
    | { repositoryId: string; filters: LogFilters; requestId?: string }
    | undefined
  >(undefined);
  const scrollPersistTimer = useRef<number | undefined>(undefined);
  const scrollTopByRepositoryRef = useRef(scrollTopByRepository);
  const previousWindowOffsetByRepository = useRef<Map<string, number>>(new Map());
  const lastWindowAnchorSignature = useRef<string | undefined>(undefined);
  const historyParentChoices = useRef<Map<string, string>>(new Map());
  const logWindowRef = useRef({
    startLogOffset: state.startLogOffset,
    graphContinuation: state.graphContinuation,
  });
  const searchRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLElement>(null);
  const logHeaderViewportRef = useRef<HTMLDivElement>(null);
  const detailsRef = useRef<HTMLElement>(null);
  const selectedRepositoryIdRef = useRef<string | undefined>(undefined);
  const latestRepositorySelectionRequest = useRef<string | undefined>(undefined);
  const latestRequestByScope = useRef<Partial<Record<WorkbenchRequestScope, string>>>({});
  const requestScopeById = useRef<Map<string, WorkbenchRequestScope>>(new Map());
  const activeOperationRequestByRepository = useRef<Map<string, string>>(new Map());
  const activeSelectionRequest = useRef<{
    requestId: string;
    repositoryId: string;
    hash: string;
  } | undefined>(undefined);
  const selectedRepository = state.repositories.find(
    (repository) => repository.id === state.selectedRepositoryId,
  );
  const authorFilterOptions = useMemo(() => {
    const userName = selectedRepository?.userName?.trim();
    const userEmail = selectedRepository?.userEmail?.trim();
    const configuredName = userName?.toLocaleLowerCase();
    const configuredEmail = userEmail?.toLocaleLowerCase();
    const authors = new Map<string, string>();
    for (const commit of state.commits) {
      const nameKey = commit.authorName.trim().toLocaleLowerCase();
      const isCurrentUser =
        (Boolean(configuredName) && nameKey === configuredName) ||
        (Boolean(configuredEmail) &&
          commit.authorEmail.trim().toLocaleLowerCase() === configuredEmail);
      if (!isCurrentUser && !authors.has(nameKey)) authors.set(nameKey, commit.authorName);
    }
    return [
      ...(userEmail || userName
        ? [
            {
              key: 'current-user',
              label: userName ? `Me (${userName})` : 'Me',
              value: userEmail ?? (userName as string),
            },
          ]
        : []),
      ...[...authors.entries()].map(([key, name]) => ({ key: `author-${key}`, label: name, value: name })),
    ];
  }, [selectedRepository?.userEmail, selectedRepository?.userName, state.commits]);
  const graphLayout = useMemo(() => {
    if (!state.history) return layoutCommitGraph(state.commits, state.graphContinuation);
    const visibleHashes = new Set(state.history.entries.map((entry) => entry.hash));
    return layoutCommitGraph(
      state.history.entries.map((entry) => ({
        hash: entry.hash,
        parents: entry.parents.filter((parent) => visibleHashes.has(parent)),
      })),
    );
  }, [state.commits, state.graphContinuation, state.history]);
  const selectedOperationInFlight = state.selectedRepositoryId
    ? state.operationRepositoryIds.has(state.selectedRepositoryId)
    : false;
  const refsCollapsed = Boolean(
    state.layout.refsCollapsed || (responsiveCollapse.refs && !responsiveExpanded.refs),
  );
  const filesCollapsed = Boolean(
    state.layout.filesCollapsed || (responsiveCollapse.files && !responsiveExpanded.files),
  );
  useEffect(() => {
    if (!window.matchMedia) return;
    const filesQuery = window.matchMedia('(max-width: 900px)');
    const refsQuery = window.matchMedia('(max-width: 680px)');
    const update = (): void => {
      setResponsiveCollapse({ files: filesQuery.matches, refs: refsQuery.matches });
      setResponsiveExpanded((current) => ({
        files: filesQuery.matches ? current.files : false,
        refs: refsQuery.matches ? current.refs : false,
      }));
    };
    filesQuery.addEventListener('change', update);
    refsQuery.addEventListener('change', update);
    update();
    return () => {
      filesQuery.removeEventListener('change', update);
      refsQuery.removeEventListener('change', update);
    };
  }, []);

  useEffect(() => {
    const dismissOpenMenus = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (
        target.closest('.context-menu') ||
        target.closest('.filter-popover') ||
        target.closest('[data-popup-trigger="true"]')
      ) {
        return;
      }
      setContextMenu(undefined);
      setFilterPopup(undefined);
    };
    window.addEventListener('pointerdown', dismissOpenMenus);
    return () => window.removeEventListener('pointerdown', dismissOpenMenus);
  }, []);

  useEffect(() => {
    scrollTopByRepositoryRef.current = scrollTopByRepository;
  }, [scrollTopByRepository]);

  useEffect(() => {
    logWindowRef.current = {
      startLogOffset: state.startLogOffset,
      graphContinuation: state.graphContinuation,
    };
  }, [state.graphContinuation, state.startLogOffset]);

  useEffect(() => {
    const repositoryId = state.selectedRepositoryId;
    if (!repositoryId || !state.windowAnchorReady) return;
    const signature = `${repositoryId}:${String(state.startLogOffset)}:${JSON.stringify(
      state.graphContinuation ?? null,
    )}`;
    if (lastWindowAnchorSignature.current === signature) return;
    lastWindowAnchorSignature.current = signature;
    if (scrollPersistTimer.current !== undefined) {
      window.clearTimeout(scrollPersistTimer.current);
      scrollPersistTimer.current = undefined;
    }
    const previousOffset = previousWindowOffsetByRepository.current.get(repositoryId);
    previousWindowOffsetByRepository.current.set(repositoryId, state.startLogOffset);
    let scrollTop = scrollTopByRepositoryRef.current[repositoryId] ?? 0;
    if (previousOffset !== undefined && state.startLogOffset > previousOffset) {
      scrollTop = Math.max(0, scrollTop - (state.startLogOffset - previousOffset) * 28);
      setScrollTopByRepository((current) => {
        const next = { ...current, [repositoryId]: scrollTop };
        vscode.setState({ scrollTopByRepository: next });
        return next;
      });
    }
    vscode.postMessage({
      type: 'updateScrollAnchor',
      requestId: requestId('window-anchor'),
      repositoryId,
      scrollTop,
      logOffset: state.startLogOffset,
      ...(state.graphContinuation ? { graphContinuation: state.graphContinuation } : {}),
    });
  }, [
    state.graphContinuation,
    state.selectedRepositoryId,
    state.startLogOffset,
    state.windowAnchorReady,
    vscode,
  ]);

  useEffect(() => {
    const listener = (event: MessageEvent<ExtensionToWebviewMessage>): void => {
      const message = event.data;
      if (!message || typeof message !== 'object' || !('type' in message)) return;

      switch (message.type) {
        case 'initialize':
          if (
            requestScopeById.current.get(message.requestId) === 'repositories' &&
            latestRequestByScope.current.repositories !== message.requestId
          ) {
            requestScopeById.current.delete(message.requestId);
            break;
          }
          requestScopeById.current.delete(message.requestId);
          activeSelectionRequest.current = undefined;
          activeOperationRequestByRepository.current.clear();
          pendingFiltersRef.current = undefined;
          lastWindowAnchorSignature.current = undefined;
          selectedRepositoryIdRef.current = message.selectedRepositoryId;
          setState((current) => ({
            ...current,
            repositories: message.repositories,
            selectedRepositoryId: message.selectedRepositoryId,
            pageSize: message.pageSize,
            maxCachedCommits: message.maxCachedCommits ?? 5000,
            nextLogOffset: 0,
            startLogOffset: 0,
            graphContinuation: undefined,
            windowAnchorReady: false,
            operationRepositoryIds: new Set(),
            layout: message.layout,
            filters: defaultFilters,
            refs: [],
            commits: [],
            details: undefined,
            detailsRepositoryId: undefined,
            selectedParent: undefined,
            files: [],
            selectedFile: undefined,
            error: undefined,
          }));
          break;
        case 'repositoryData': {
          if (selectedRepositoryIdRef.current !== message.repositoryId) {
            requestScopeById.current.delete(message.requestId);
            break;
          }
          if (
            requestScopeById.current.get(message.requestId) === 'log' &&
            latestRequestByScope.current.log !== message.requestId
          ) {
            requestScopeById.current.delete(message.requestId);
            break;
          }
          requestScopeById.current.delete(message.requestId);
          const pendingFilters = pendingFiltersRef.current;
          const resolvesPendingFilters =
            pendingFilters?.repositoryId === message.repositoryId &&
            (pendingFilters.requestId === message.requestId ||
              filtersEqual(pendingFilters.filters, message.filters));
          const preservesPendingFilters =
            pendingFilters?.repositoryId === message.repositoryId && !resolvesPendingFilters;
          if (resolvesPendingFilters) pendingFiltersRef.current = undefined;
          if (message.replace && message.scrollTop !== undefined) {
            setScrollTopByRepository((current) => {
              const next = { ...current, [message.repositoryId]: message.scrollTop ?? 0 };
              vscode.setState({ scrollTopByRepository: next });
              return next;
            });
          }
          if (message.selectedHash) {
            activeSelectionRequest.current = {
              requestId: message.requestId,
              repositoryId: message.repositoryId,
              hash: message.selectedHash,
            };
          }
          setState((current) => {
            if (current.selectedRepositoryId !== message.repositoryId) return current;
            const commitWindow = advanceCommitWindow(
              {
                commits: current.commits,
                graphContinuation: current.graphContinuation,
                nextLogOffset: current.nextLogOffset,
                startLogOffset: current.startLogOffset,
              },
              message.commits,
              current.maxCachedCommits,
              message.replace,
              message.startLogOffset ?? (message.replace ? 0 : current.nextLogOffset),
              message.graphContinuation,
            );
            const keepsSelection =
              message.selectedHash !== undefined ||
              !message.replace ||
              (current.selectedHash !== undefined &&
                commitWindow.commits.some((commit) => commit.hash === current.selectedHash));
            return {
              ...current,
              selectedRepositoryId: message.repositoryId,
              refs: message.refs,
              filters: preservesPendingFilters ? current.filters : message.filters,
              commits: commitWindow.commits,
              nextLogOffset: commitWindow.nextLogOffset,
              startLogOffset: commitWindow.startLogOffset,
              graphContinuation: commitWindow.graphContinuation,
              windowAnchorReady: true,
              ...(message.selectedHash ? { selectedHash: message.selectedHash } : {}),
              hasMore: message.hasMore,
              loading: undefined,
              error: undefined,
              ...(message.replace && !keepsSelection
                ? {
                    selectedHash: undefined,
                    details: undefined,
                    detailsRepositoryId: undefined,
                    selectedParent: undefined,
                    files: [],
                    selectedFile: undefined,
                  }
                : {}),
            };
          });
          break;
        }
        case 'repositoriesUpdated':
          if (
            message.selectedRepositoryId &&
            message.selectedRepositoryId !== selectedRepositoryIdRef.current &&
            latestRepositorySelectionRequest.current !== message.requestId
          ) {
            break;
          }
          setState((current) => {
            const selectedRepositoryId = message.selectedRepositoryId ?? current.selectedRepositoryId;
            selectedRepositoryIdRef.current = selectedRepositoryId;
            if (selectedRepositoryId !== current.selectedRepositoryId) {
              activeSelectionRequest.current = undefined;
              lastWindowAnchorSignature.current = undefined;
              return {
                ...current,
                repositories: message.repositories,
                selectedRepositoryId,
                refs: [],
                commits: [],
                nextLogOffset: 0,
                startLogOffset: 0,
                graphContinuation: undefined,
                windowAnchorReady: false,
                selectedHash: undefined,
                details: undefined,
                detailsRepositoryId: undefined,
                selectedParent: undefined,
                files: [],
                selectedFile: undefined,
              };
            }
            return { ...current, repositories: message.repositories };
          });
          break;
        case 'selectionDetailsLoaded':
          requestScopeById.current.delete(message.requestId);
          setState((current) => {
            const activeRequest = activeSelectionRequest.current;
            if (
              !activeRequest ||
              activeRequest.requestId !== message.requestId ||
              activeRequest.repositoryId !== message.repositoryId ||
              activeRequest.hash !== message.details.hash ||
              current.selectedRepositoryId !== message.repositoryId ||
              current.selectedHash !== message.details.hash
            ) {
              return current;
            }
            return {
              ...current,
              details: message.details,
              detailsRepositoryId: message.repositoryId,
              selectedParent: message.selectedParent ?? message.details.parents[0],
              files: message.files,
              selectedFile: undefined,
              loading: undefined,
              error: undefined,
            };
          });
          break;
        case 'historyOpened':
          if (message.replace) historyParentChoices.current.clear();
          setHistoryParentPicker(undefined);
          setState((current) => ({
            ...current,
            history: {
              repositoryId: message.repositoryId,
              kind: message.kind,
              path: message.path,
              ...(message.startLine !== undefined ? { startLine: message.startLine } : {}),
              ...(message.endLine !== undefined ? { endLine: message.endLine } : {}),
              entries: message.replace
                ? message.entries
                : [...(current.history?.entries ?? []), ...message.entries],
              hasMore: message.hasMore,
              ...(message.notice ? { notice: message.notice } : {}),
            },
            loading: undefined,
            error: undefined,
          }));
          break;
        case 'historyClosed':
          historyParentChoices.current.clear();
          setHistoryParentPicker(undefined);
          setState((current) =>
            current.history?.repositoryId === message.repositoryId
              ? {
                  ...current,
                  history: undefined,
                  ...(message.reason ? { error: message.reason } : {}),
                }
              : current,
          );
          break;
        case 'loading':
          if (message.scope === 'operation' && message.repositoryId) {
            const repositoryId = message.repositoryId;
            const activeRequest = activeOperationRequestByRepository.current.get(repositoryId);
            if (activeRequest && activeRequest !== message.requestId) break;
            activeOperationRequestByRepository.current.set(repositoryId, message.requestId);
            setState((current) => ({
              ...current,
              operationRepositoryIds: new Set(current.operationRepositoryIds).add(repositoryId),
              error: undefined,
            }));
            break;
          }
          if (
            requestScopeById.current.get(message.requestId) === message.scope &&
            latestRequestByScope.current[message.scope] !== message.requestId
          ) {
            break;
          }
          latestRequestByScope.current[message.scope] = message.requestId;
          setState((current) => {
            if (message.repositoryId && current.selectedRepositoryId !== message.repositoryId) {
              return current;
            }
            return { ...current, loading: message.scope, error: undefined };
          });
          break;
        case 'clipboardCopied':
          if (detailsHashCopyRequest.current !== message.requestId) break;
          detailsHashCopyRequest.current = undefined;
          setDetailsHashCopyState('copied');
          if (detailsHashCopyTimer.current !== undefined) {
            window.clearTimeout(detailsHashCopyTimer.current);
          }
          detailsHashCopyTimer.current = window.setTimeout(() => {
            detailsHashCopyTimer.current = undefined;
            setDetailsHashCopyState('idle');
          }, 1_500);
          break;
        case 'error':
          {
            if (detailsHashCopyRequest.current === message.requestId) {
              detailsHashCopyRequest.current = undefined;
              setDetailsHashCopyState('idle');
            }
            if (pendingFiltersRef.current?.requestId === message.requestId) {
              pendingFiltersRef.current = undefined;
            }
            const scope = requestScopeById.current.get(message.requestId);
            if (scope === 'operation' && message.repositoryId) {
              const repositoryId = message.repositoryId;
              if (
                activeOperationRequestByRepository.current.get(repositoryId) !== message.requestId
              ) {
                requestScopeById.current.delete(message.requestId);
                break;
              }
              activeOperationRequestByRepository.current.delete(repositoryId);
              requestScopeById.current.delete(message.requestId);
              setState((current) => {
                const operationRepositoryIds = new Set(current.operationRepositoryIds);
                operationRepositoryIds.delete(repositoryId);
                return {
                  ...current,
                  operationRepositoryIds,
                  ...(current.selectedRepositoryId === repositoryId
                    ? { error: message.message }
                    : {}),
                };
              });
              break;
            }
            if (scope && latestRequestByScope.current[scope] !== message.requestId) {
              requestScopeById.current.delete(message.requestId);
              break;
            }
          }
          requestScopeById.current.delete(message.requestId);
          setState((current) => {
            if (
              message.repositoryId &&
              current.selectedRepositoryId !== message.repositoryId &&
              current.history?.repositoryId !== message.repositoryId
            ) {
              return current;
            }
            return { ...current, loading: undefined, error: message.message };
          });
          break;
        case 'operationCompleted':
          if (
            activeOperationRequestByRepository.current.get(message.repositoryId) !==
            message.requestId
          ) {
            requestScopeById.current.delete(message.requestId);
            break;
          }
          activeOperationRequestByRepository.current.delete(message.repositoryId);
          requestScopeById.current.delete(message.requestId);
          setState((current) => {
            const operationRepositoryIds = new Set(current.operationRepositoryIds);
            operationRepositoryIds.delete(message.repositoryId);
            return {
              ...current,
              operationRepositoryIds,
              ...(current.selectedRepositoryId === message.repositoryId
                ? { error: undefined }
                : {}),
            };
          });
          break;
        case 'operationCancelled':
          if (
            activeOperationRequestByRepository.current.get(message.repositoryId) !==
            message.requestId
          ) {
            requestScopeById.current.delete(message.requestId);
            break;
          }
          activeOperationRequestByRepository.current.delete(message.repositoryId);
          requestScopeById.current.delete(message.requestId);
          setState((current) => {
            const operationRepositoryIds = new Set(current.operationRepositoryIds);
            operationRepositoryIds.delete(message.repositoryId);
            return {
              ...current,
              operationRepositoryIds,
              ...(current.selectedRepositoryId === message.repositoryId
                ? { error: undefined }
                : {}),
            };
          });
          break;
      }
    };

    window.addEventListener('message', listener);
    vscode.postMessage({ type: 'ready', requestId: requestId('ready') });
    return () => {
      window.removeEventListener('message', listener);
      if (filterTimer.current !== undefined) window.clearTimeout(filterTimer.current);
      if (scrollPersistTimer.current !== undefined) window.clearTimeout(scrollPersistTimer.current);
      if (detailsHashCopyTimer.current !== undefined) {
        window.clearTimeout(detailsHashCopyTimer.current);
      }
    };
  }, [vscode]);

  const send = (message: WebviewToExtensionMessage): void => {
    const scope = requestScopeForMessage(message);
    if (scope) {
      requestScopeById.current.set(message.requestId, scope);
      latestRequestByScope.current[scope] = message.requestId;
    }
    vscode.postMessage(message);
  };

  const applyFilters = (filters: LogFilters, debounce = false): void => {
    setState((current) => ({ ...current, filters }));
    if (filterTimer.current !== undefined) {
      window.clearTimeout(filterTimer.current);
      filterTimer.current = undefined;
    }
    if (!state.selectedRepositoryId) return;
    const repositoryId = state.selectedRepositoryId;
    pendingFiltersRef.current = { repositoryId, filters };
    setScrollTopByRepository((current) => {
      const next = { ...current, [repositoryId]: 0 };
      vscode.setState({ scrollTopByRepository: next });
      return next;
    });
    const post = (): void => {
      filterTimer.current = undefined;
      if (scrollPersistTimer.current !== undefined) {
        window.clearTimeout(scrollPersistTimer.current);
        scrollPersistTimer.current = undefined;
      }
      setState((current) => ({
        ...current,
        startLogOffset: 0,
        nextLogOffset: 0,
        graphContinuation: undefined,
        windowAnchorReady: true,
      }));
      const filterRequestId = requestId('filters');
      pendingFiltersRef.current = { repositoryId, filters, requestId: filterRequestId };
      send({
        type: 'updateFilters',
        requestId: filterRequestId,
        repositoryId,
        filters,
      });
    };
    if (debounce) filterTimer.current = window.setTimeout(post, 200);
    else post();
  };

  const applyDateRange = (dateFrom?: number, dateTo?: number): void => {
    const filters = { ...state.filters };
    delete filters.dateFrom;
    delete filters.dateTo;
    applyFilters({
      ...filters,
      ...(dateFrom !== undefined ? { dateFrom } : {}),
      ...(dateTo !== undefined ? { dateTo } : {}),
    });
    setFilterPopup(undefined);
  };

  const selectRepository = (repositoryId: string): void => {
    if (filterTimer.current !== undefined) {
      window.clearTimeout(filterTimer.current);
      filterTimer.current = undefined;
    }
    pendingFiltersRef.current = undefined;
    setContextMenu(undefined);
    setNamedOperation(undefined);
    setFilterPopup(undefined);
    activeSelectionRequest.current = undefined;
    lastWindowAnchorSignature.current = undefined;
    selectedRepositoryIdRef.current = repositoryId;
    setState((current) => ({
      ...current,
      selectedRepositoryId: repositoryId,
      refs: [],
      commits: [],
      nextLogOffset: 0,
      startLogOffset: 0,
      graphContinuation: undefined,
      windowAnchorReady: false,
      selectedHash: undefined,
      details: undefined,
      detailsRepositoryId: undefined,
      selectedParent: undefined,
      files: [],
      selectedFile: undefined,
      loading: 'log',
      error: undefined,
    }));
    const selectionRequestId = requestId('repository');
    latestRepositorySelectionRequest.current = selectionRequestId;
    send({ type: 'selectRepository', requestId: selectionRequestId, repositoryId });
  };

  const selectCommit = (commit: CommitSummary): void => {
    if (state.history) {
      const rememberedParent = historyParentChoices.current.get(commit.hash);
      if (commit.parents.length > 1 && !rememberedParent) {
        setHistoryParentPicker({
          repositoryId: state.history.repositoryId,
          commit,
        });
        return;
      }
      send({
        type: 'openHistoryDiff',
        requestId: requestId('history-diff'),
        repositoryId: state.history.repositoryId,
        hash: commit.hash,
        ...(rememberedParent ?? commit.parents[0]
          ? { parent: rememberedParent ?? commit.parents[0] }
          : {}),
      });
      return;
    }
    if (!state.selectedRepositoryId) return;
    const selectionRequestId = requestId('selection');
    activeSelectionRequest.current = {
      requestId: selectionRequestId,
      repositoryId: state.selectedRepositoryId,
      hash: commit.hash,
    };
    setState((current) => ({
      ...current,
      selectedHash: commit.hash,
      details: undefined,
      detailsRepositoryId: undefined,
      selectedParent: undefined,
      files: [],
      selectedFile: undefined,
    }));
    send({
      type: 'selectCommit',
      requestId: selectionRequestId,
      repositoryId: state.selectedRepositoryId,
      hash: commit.hash,
    });
  };

  const selectHash = (hash: string, prefix = 'selection'): void => {
    if (!state.selectedRepositoryId) return;
    const commit = state.commits.find((candidate) => candidate.hash === hash);
    if (commit) {
      selectCommit(commit);
      return;
    }
    setState((current) => ({
      ...current,
      selectedHash: hash,
      details: undefined,
      detailsRepositoryId: undefined,
      selectedParent: undefined,
      files: [],
      selectedFile: undefined,
    }));
    const selectionRequestId = requestId(prefix);
    activeSelectionRequest.current = {
      requestId: selectionRequestId,
      repositoryId: state.selectedRepositoryId,
      hash,
    };
    send({
      type: 'selectCommit',
      requestId: selectionRequestId,
      repositoryId: state.selectedRepositoryId,
      hash,
    });
  };

  const selectRef = (ref: RefLabel): void => {
    const commit = state.commits.find((candidate) => candidate.hash === ref.target);
    selectHash(ref.target, 'ref');
    if (commit) document.querySelector<HTMLElement>(`[data-commit-hash="${commit.hash}"]`)?.focus();
  };

  const toggleRefGroup = (group: string): void => {
    setCollapsedRefGroups((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };

  const handleRefKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    ref: RefLabel,
  ): void => {
    const items = [...document.querySelectorAll<HTMLButtonElement>('[data-ref-item="true"]')];
    const index = items.indexOf(event.currentTarget);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      items[Math.min(items.length - 1, Math.max(0, index + direction))]?.focus();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      selectRef(ref);
    }
  };

  const openCommitComparison = (
    hash: string,
    mode: 'parent' | 'current',
    parent?: string,
  ): void => {
    if (!state.selectedRepositoryId) return;
    send({
      type: 'openCommitComparison',
      requestId: requestId('compare'),
      repositoryId: state.selectedRepositoryId,
      hash,
      mode,
      ...(parent ? { parent } : {}),
    });
    setContextMenu(undefined);
  };

  const goToHead = (): void => {
    if (!selectedRepository?.head) return;
    selectHash(selectedRepository.head, 'head');
  };

  const loadMore = (): void => {
    if (state.history) {
      if (!state.history.hasMore) return;
      send({
        type: 'requestHistoryPage',
        requestId: requestId('history-page'),
        repositoryId: state.history.repositoryId,
        skip: state.history.entries.length,
      });
      return;
    }
    if (!state.selectedRepositoryId || !state.hasMore || state.loading === 'log') return;
    send({
      type: 'requestLogPage',
      requestId: requestId('page'),
      repositoryId: state.selectedRepositoryId,
      skip: state.nextLogOffset,
    });
  };

  const updateFilesViewMode = (filesViewMode: WorkbenchLayout['filesViewMode']): void => {
    const layout = { ...state.layout, filesViewMode };
    setState((current) => ({ ...current, layout }));
    send({ type: 'updateLayout', requestId: requestId('layout'), layout });
  };

  const persistLayout = (layout: WorkbenchLayout): void => {
    setState((current) => ({ ...current, layout }));
    send({ type: 'updateLayout', requestId: requestId('layout'), layout });
  };

  const toggleResponsivePane = (pane: 'refs' | 'files'): void => {
    const layoutKey = pane === 'refs' ? 'refsCollapsed' : 'filesCollapsed';
    const responsive = responsiveCollapse[pane];
    const expanded = responsiveExpanded[pane];
    if (state.layout[layoutKey]) {
      persistLayout({ ...state.layout, [layoutKey]: false });
      return;
    }
    if (responsive) {
      setResponsiveExpanded((current) => ({ ...current, [pane]: !expanded }));
      return;
    }
    persistLayout({ ...state.layout, [layoutKey]: true });
  };

  const resizeLayout = (
    key: 'refsWidth' | 'filesWidth' | 'detailsHeight',
    delta: number,
  ): void => {
    const min = key === 'refsWidth' ? 160 : key === 'filesWidth' ? 220 : 100;
    const max =
      key === 'detailsHeight'
        ? Math.max(min, window.innerHeight - 180)
        : Math.max(min, window.innerWidth - (key === 'refsWidth' ? 560 : 520));
    persistLayout({
      ...state.layout,
      [key]: Math.min(max, Math.max(min, state.layout[key] + delta)),
    });
  };

  const beginResize = (
    key: 'refsWidth' | 'filesWidth' | 'detailsHeight',
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    event.preventDefault();
    const start = key === 'detailsHeight' ? event.clientY : event.clientX;
    const initialLayout = state.layout;
    let nextLayout = initialLayout;
    const move = (pointerEvent: PointerEvent): void => {
      const current = key === 'detailsHeight' ? pointerEvent.clientY : pointerEvent.clientX;
      const rawDelta = current - start;
      const delta = key === 'filesWidth' || key === 'detailsHeight' ? -rawDelta : rawDelta;
      const min = key === 'refsWidth' ? 160 : key === 'filesWidth' ? 220 : 100;
      const max =
        key === 'detailsHeight'
          ? Math.max(min, window.innerHeight - 180)
          : Math.max(min, window.innerWidth - (key === 'refsWidth' ? 560 : 520));
      nextLayout = {
        ...initialLayout,
        [key]: Math.min(max, Math.max(min, initialLayout[key] + delta)),
      };
      setState((currentState) => ({ ...currentState, layout: nextLayout }));
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      send({ type: 'updateLayout', requestId: requestId('layout'), layout: nextLayout });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  };

  const resizeColumn = (
    key: 'commitColumnWidth' | 'refsColumnWidth' | 'authorColumnWidth' | 'dateColumnWidth',
    delta: number,
    measuredWidth?: number,
  ): void => {
    const fallback =
      key === 'commitColumnWidth'
        ? measuredWidth && measuredWidth >= 160
          ? measuredWidth
          : 360
        : key === 'refsColumnWidth'
          ? 150
          : key === 'authorColumnWidth'
            ? 130
            : 125;
    const min = key === 'commitColumnWidth' ? 160 : key === 'dateColumnWidth' ? 90 : 100;
    const max = key === 'commitColumnWidth' ? 2000 : 320;
    persistLayout({
      ...state.layout,
      [key]: Math.min(max, Math.max(min, (state.layout[key] ?? fallback) + delta)),
    });
  };

  const beginColumnResize = (
    key: 'commitColumnWidth' | 'refsColumnWidth' | 'authorColumnWidth' | 'dateColumnWidth',
    event: ReactPointerEvent<HTMLDivElement>,
    measuredWidth?: number,
  ): void => {
    event.preventDefault();
    event.stopPropagation();
    const start = event.clientX;
    const fallback =
      key === 'commitColumnWidth'
        ? measuredWidth && measuredWidth >= 160
          ? measuredWidth
          : 360
        : key === 'refsColumnWidth'
          ? 150
          : key === 'authorColumnWidth'
            ? 130
            : 125;
    const initial = state.layout[key] ?? fallback;
    const min = key === 'commitColumnWidth' ? 160 : key === 'dateColumnWidth' ? 90 : 100;
    const max = key === 'commitColumnWidth' ? 2000 : 320;
    let nextLayout = state.layout;
    const move = (pointerEvent: PointerEvent): void => {
      nextLayout = {
        ...state.layout,
        [key]: Math.min(max, Math.max(min, initial + pointerEvent.clientX - start)),
      };
      setState((current) => ({ ...current, layout: nextLayout }));
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      send({ type: 'updateLayout', requestId: requestId('layout'), layout: nextLayout });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  };

  const openDiff = (file: ChangedFile): void => {
    if (
      !state.detailsRepositoryId ||
      state.detailsRepositoryId !== state.selectedRepositoryId ||
      !state.details
    ) {
      return;
    }
    if (file.binary) {
      setState((current) => ({
        ...current,
        error: `Binary diff is not available for ${file.path}.`,
      }));
      return;
    }
    send({
      type: 'openDiff',
      requestId: requestId('diff'),
      repositoryId: state.detailsRepositoryId,
      hash: state.details.hash,
      ...(state.selectedParent ? { parent: state.selectedParent } : {}),
      path: file.path,
      ...(file.oldPath ? { oldPath: file.oldPath } : {}),
      status: file.status,
    });
  };

  const openFile = (file: ChangedFile, mode: 'revision' | 'current'): void => {
    if (
      !state.detailsRepositoryId ||
      state.detailsRepositoryId !== state.selectedRepositoryId ||
      !state.details
    ) {
      return;
    }
    send({
      type: 'openFile',
      requestId: requestId(`open-file-${mode}`),
      repositoryId: state.detailsRepositoryId,
      hash: state.details.hash,
      ...(state.selectedParent ? { parent: state.selectedParent } : {}),
      path: file.path,
      ...(file.oldPath ? { oldPath: file.oldPath } : {}),
      status: file.status,
      mode,
    });
    setContextMenu(undefined);
  };

  const runOperation = (operation: GitOperationRequest, repositoryId = state.selectedRepositoryId): void => {
    if (!repositoryId || activeOperationRequestByRepository.current.has(repositoryId)) return;
    const operationRequestId = requestId('operation');
    const validatedMessage = parseWebviewMessage({
      type: 'runOperation',
      requestId: operationRequestId,
      repositoryId,
      operation,
    });
    if (!validatedMessage || validatedMessage.type !== 'runOperation') {
      setState((current) => ({ ...current, error: 'Invalid Git operation parameters.' }));
      return;
    }
    activeOperationRequestByRepository.current.set(repositoryId, operationRequestId);
    setState((current) => ({
      ...current,
      operationRepositoryIds: new Set(current.operationRepositoryIds).add(repositoryId),
    }));
    send(validatedMessage);
    setContextMenu(undefined);
  };

  const submitNamedOperation = (): void => {
    if (!namedOperation?.value.trim()) return;
    const value = namedOperation.value.trim();
    if (namedOperation.kind === 'createBranch') {
      runOperation(
        { kind: 'createBranch', name: value, startPoint: namedOperation.target },
        namedOperation.repositoryId,
      );
    } else if (namedOperation.kind === 'createTag') {
      runOperation(
        { kind: 'createTag', name: value, target: namedOperation.target },
        namedOperation.repositoryId,
      );
    } else if (namedOperation.kind === 'renameBranch') {
      runOperation(
        { kind: 'renameBranch', oldName: namedOperation.oldName, newName: value },
        namedOperation.repositoryId,
      );
    } else {
      runOperation(
        { kind: 'checkoutRemote', name: value, startPoint: namedOperation.startPoint },
        namedOperation.repositoryId,
      );
    }
    setNamedOperation(undefined);
  };

  const logContentWidth =
    (state.layout.commitColumnWidth ?? 260) +
    (state.layout.authorColumnWidth ?? 130) +
    (state.layout.dateColumnWidth ?? 125) +
    (state.layout.refsColumnWidth ?? 150);

  return (
    <main
      className="workbench-shell"
      style={{ gridTemplateRows: `38px minmax(0, 1fr) 4px ${state.layout.detailsHeight}px` }}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
          event.preventDefault();
          searchRef.current?.focus();
        } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'l') {
          event.preventDefault();
          logRef.current?.focus();
        } else if (
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === 'c' &&
          state.selectedHash &&
          !(event.target instanceof HTMLInputElement) &&
          !(event.target instanceof HTMLTextAreaElement) &&
          !(event.target instanceof HTMLSelectElement)
        ) {
          event.preventDefault();
          send({
            type: 'copyToClipboard',
            requestId: requestId('copy-hash'),
            text: state.selectedHash,
          });
        } else if (event.key === 'Escape') {
          setContextMenu(undefined);
          setNamedOperation(undefined);
          setFilterPopup(undefined);
          setHistoryParentPicker(undefined);
        }
      }}
    >
      <header
        className={`filter-bar${state.history ? ' history-active' : ''}`}
        role="toolbar"
        aria-label="Git log filters"
      >
        {state.history ? (
          <div className="history-toolbar">
            <strong>
              {state.history.kind === 'file' ? 'File History' : 'Line History'} · {state.history.path}
              {state.history.startLine !== undefined
                ? ` : ${String(state.history.startLine)}–${String(state.history.endLine ?? state.history.startLine)}`
                : ''}
            </strong>
            {state.history.notice && state.history.entries.length ? (
              <span className="history-notice">{state.history.notice}</span>
            ) : null}
            {state.history.kind === 'line' ? (
              <button
                type="button"
                aria-label="Show file history"
                title="Show complete file history"
                onClick={() =>
                  send({
                    type: 'switchHistoryToFile',
                    requestId: requestId('history-file'),
                    repositoryId: state.history?.repositoryId ?? '',
                  })
                }
              >
                File History
              </button>
            ) : null}
            <button
              type="button"
              aria-label="Back to log"
              title="Return to the Git log"
              onClick={() =>
                send({
                  type: 'closeHistory',
                  requestId: requestId('history-back'),
                  repositoryId: state.history?.repositoryId ?? '',
                })
              }
            >
              Back
            </button>
            <button
              type="button"
              aria-label="Close history"
              title="Close history and return to the Git log"
              onClick={() =>
                send({
                  type: 'closeHistory',
                  requestId: requestId('history-close'),
                  repositoryId: state.history?.repositoryId ?? '',
                })
              }
            >
              Close
            </button>
          </div>
        ) : null}
        {state.repositories.length > 1 ? (
          <label className="field repository-field">
            <span className="sr-only">Repository</span>
            <select
              aria-label="Repository"
              value={state.selectedRepositoryId ?? ''}
              onChange={(event) => selectRepository(event.target.value)}
            >
              <option value="" disabled>
                Select repository
              </option>
              {state.repositories.map((repository) => (
                <option value={repository.id} key={repository.id}>
                  {repository.displayName}{repository.operationState ? ` · ${repository.operationState}` : ''}
                </option>
              ))}
            </select>
            {selectedRepository?.operationState ? (
              <span className="operation-badge">{selectedRepository.operationState}</span>
            ) : null}
          </label>
        ) : selectedRepository?.operationState ? (
          <span className="operation-badge">{selectedRepository.operationState}</span>
        ) : null}
        <label className="field search-field">
          <span className="search-icon" aria-hidden="true">
            ⌕
          </span>
          <input
            ref={searchRef}
            type="search"
            aria-label="Text or hash"
            placeholder="Text or hash"
            value={state.filters.text}
            onChange={(event) => applyFilters({ ...state.filters, text: event.target.value }, true)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              event.preventDefault();
              event.stopPropagation();
              if (state.filters.text) {
                applyFilters({ ...state.filters, text: '' });
              } else {
                logRef.current?.focus();
              }
            }}
          />
        </label>
        <button
          type="button"
          data-popup-trigger="true"
          className={state.filters.branches.length ? 'filter-active' : ''}
          onClick={() => {
            setContextMenu(undefined);
            setFilterPopup((current) => (current === 'branch' ? undefined : 'branch'));
          }}
        >
          Branch{state.filters.branches.length ? ` (${String(state.filters.branches.length)})` : ''}
        </button>
        <button
          type="button"
          data-popup-trigger="true"
          className={state.filters.authors.length ? 'filter-active' : ''}
          onClick={() => {
            setContextMenu(undefined);
            setFilterPopup((current) => (current === 'user' ? undefined : 'user'));
          }}
        >
          User{state.filters.authors.length ? ` (${String(state.filters.authors.length)})` : ''}
        </button>
        <button
          type="button"
          data-popup-trigger="true"
          className={state.filters.dateFrom || state.filters.dateTo ? 'filter-active' : ''}
          onClick={() => {
            setContextMenu(undefined);
            setFilterPopup((current) => (current === 'date' ? undefined : 'date'));
          }}
        >
          Date
        </button>
        <button
          type="button"
          data-popup-trigger="true"
          className={state.filters.paths.length ? 'filter-active' : ''}
          onClick={() => {
            setContextMenu(undefined);
            setFilterPopup((current) => (current === 'paths' ? undefined : 'paths'));
          }}
        >
          Paths{state.filters.paths.length ? ` (${String(state.filters.paths.length)})` : ''}
        </button>
        {filterPopup ? (
          <div className={`filter-popover filter-${filterPopup}`} role="dialog" aria-label={`${filterPopup} filter`}>
            {filterPopup === 'branch' ? (
              <>
                <div className="filter-popover-title">Branches</div>
                {state.refs.length ? (
                  state.refs.map((ref) => (
                    <label className="filter-option" key={ref.fullName}>
                      <input
                        type="checkbox"
                        checked={state.filters.branches.includes(ref.fullName)}
                        onChange={() => {
                          const branches = state.filters.branches.includes(ref.fullName)
                            ? state.filters.branches.filter((branch) => branch !== ref.fullName)
                            : [...state.filters.branches, ref.fullName];
                          applyFilters({ ...state.filters, branches });
                        }}
                      />
                      <span>{ref.shortName}</span>
                    </label>
                  ))
                ) : (
                  <span className="filter-empty">No refs loaded</span>
                )}
              </>
            ) : null}
            {filterPopup === 'user' ? (
              <>
                <div className="filter-popover-title">Authors</div>
                {authorFilterOptions.map((author) => (
                  <label className="filter-option" key={author.key}>
                    <input
                      type="checkbox"
                      checked={state.filters.authors.includes(author.value)}
                      onChange={() => {
                        const authors = state.filters.authors.includes(author.value)
                          ? state.filters.authors.filter((candidate) => candidate !== author.value)
                          : [...state.filters.authors, author.value];
                        applyFilters({ ...state.filters, authors });
                      }}
                    />
                    <span>{author.label}</span>
                  </label>
                ))}
              </>
            ) : null}
            {filterPopup === 'date' ? (
              <div className="date-options">
                {[
                  { label: 'All time', kind: 'all' },
                  { label: 'Today', kind: 'today' },
                  { label: 'Yesterday', kind: 'yesterday' },
                  { label: 'Last 7 days', kind: 'days', days: 7 },
                  { label: 'Last 30 days', kind: 'days', days: 30 },
                ].map((option) => (
                  <button
                    type="button"
                    key={option.label}
                    onClick={() => {
                      const now = new Date();
                      const today = new Date(
                        now.getFullYear(),
                        now.getMonth(),
                        now.getDate(),
                      ).getTime() / 1000;
                      if (option.kind === 'all') applyDateRange();
                      else if (option.kind === 'today') applyDateRange(today, today + 24 * 60 * 60);
                      else if (option.kind === 'yesterday') {
                        applyDateRange(today - 24 * 60 * 60, today);
                      } else {
                        applyDateRange(
                          Math.floor(Date.now() / 1000) - (option.days ?? 0) * 24 * 60 * 60,
                        );
                      }
                    }}
                  >
                    {option.label}
                  </button>
                ))}
                <div className="custom-date-range">
                  <label>
                    <span>From</span>
                    <input
                      type="date"
                      aria-label="Custom date from"
                      value={customDateFrom}
                      onChange={(event) => setCustomDateFrom(event.target.value)}
                    />
                  </label>
                  <label>
                    <span>To</span>
                    <input
                      type="date"
                      aria-label="Custom date to"
                      value={customDateTo}
                      onChange={(event) => setCustomDateTo(event.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    disabled={!customDateFrom && !customDateTo}
                    onClick={() =>
                      applyDateRange(
                        customDateFrom
                          ? Math.floor(new Date(`${customDateFrom}T00:00:00`).getTime() / 1000)
                          : undefined,
                        customDateTo
                          ? Math.floor(new Date(`${customDateTo}T23:59:59`).getTime() / 1000)
                          : undefined,
                      )
                    }
                  >
                    Apply custom range
                  </button>
                </div>
              </div>
            ) : null}
            {filterPopup === 'paths' ? (
              <label className="path-filter-field">
                <span>Git path</span>
                <input
                  aria-label="Git path filter"
                  value={state.filters.paths[0] ?? ''}
                  placeholder="src/ or src/app.ts"
                  onChange={(event) =>
                    applyFilters(
                      {
                        ...state.filters,
                        paths: event.target.value ? [event.target.value] : [],
                      },
                      true,
                    )
                  }
                />
              </label>
            ) : null}
            <button
              type="button"
              className="reset-filters"
              onClick={() => {
                applyFilters(defaultFilters);
                setFilterPopup(undefined);
              }}
            >
              Reset filters
            </button>
          </div>
        ) : null}
        <span className="toolbar-spacer" />
        <button
          type="button"
          aria-label="Refresh log"
          title="Refresh local repository state"
          onClick={() =>
            send({
              type: 'refresh',
              requestId: requestId('refresh'),
              ...(state.selectedRepositoryId ? { repositoryId: state.selectedRepositoryId } : {}),
            })
          }
        >
          ↻
        </button>
        <button
          type="button"
          aria-label="Go to HEAD"
          title="Select the current HEAD commit"
          disabled={!selectedRepository?.head}
          onClick={goToHead}
        >
          ◎
        </button>
        <button
          type="button"
          aria-label="Fetch remotes"
          title="Fetch from remotes"
          disabled={!state.selectedRepositoryId || selectedRepository?.isBare || selectedOperationInFlight}
          onClick={() => runOperation({ kind: 'fetch' })}
        >
          ⇣
        </button>
        <button
          type="button"
          aria-label={`${refsCollapsed ? 'Expand' : 'Collapse'} references pane`}
          title={`${refsCollapsed ? 'Expand' : 'Collapse'} references pane`}
          onClick={() => toggleResponsivePane('refs')}
        >
          ⇤
        </button>
        <button
          type="button"
          aria-label={`${filesCollapsed ? 'Expand' : 'Collapse'} changed files pane`}
          title={`${filesCollapsed ? 'Expand' : 'Collapse'} changed files pane`}
          onClick={() => toggleResponsivePane('files')}
        >
          ⇥
        </button>
        <button
          type="button"
          data-popup-trigger="true"
          aria-label="More actions"
          title="More Git actions"
          aria-haspopup="menu"
          aria-expanded={contextMenu?.kind === 'toolbar'}
          disabled={!state.selectedRepositoryId || selectedRepository?.isBare}
          onClick={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            if (!state.selectedRepositoryId) return;
            setFilterPopup(undefined);
            setContextMenu((current) =>
              current?.kind === 'toolbar'
                ? undefined
                : {
                    kind: 'toolbar',
                    repositoryId: state.selectedRepositoryId as string,
                    x: bounds.right - 170,
                    y: bounds.bottom + 2,
                  },
            );
          }}
        >
          ⋮
        </button>
      </header>

      {state.error ? (
        <div className="error-banner" role="alert">
          <span>{state.error}</span>
          <span className="error-actions">
            <button
              type="button"
              aria-label="Retry Git query"
              onClick={() =>
                send({
                  type: 'refresh',
                  requestId: requestId('retry'),
                  ...(state.selectedRepositoryId ? { repositoryId: state.selectedRepositoryId } : {}),
                })
              }
            >
              Retry
            </button>
            <button
              type="button"
              aria-label="Show Git output"
              onClick={() => send({ type: 'showOutput', requestId: requestId('output') })}
            >
              Show Output
            </button>
            <button
              type="button"
              aria-label="Copy diagnostic"
              onClick={() =>
                send({ type: 'copyToClipboard', requestId: requestId('diagnostic'), text: state.error ?? '' })
              }
            >
              Copy
            </button>
          </span>
        </div>
      ) : null}

      <section
        className="workspace-grid"
        style={{
          gridTemplateColumns: `${refsCollapsed ? 0 : state.layout.refsWidth}px ${
            refsCollapsed ? 0 : 4
          }px minmax(340px, 1fr) ${filesCollapsed ? 0 : 4}px ${
            filesCollapsed ? 0 : state.layout.filesWidth
          }px`,
        }}
      >
        <nav
          className="refs-pane pane"
          aria-label="Git references"
          hidden={refsCollapsed}
        >
          <div className="pane-heading">Branches</div>
          <div className="refs-scroll">
            <section className="ref-group">
              <button
                type="button"
                className="ref-group-heading"
                aria-expanded={!collapsedRefGroups.has('head')}
                onClick={() => toggleRefGroup('head')}
              >
                <span aria-hidden="true">{collapsedRefGroups.has('head') ? '›' : '⌄'}</span>
                <span>HEAD</span>
              </button>
              {selectedRepository?.head && !collapsedRefGroups.has('head') ? (
                <button
                  type="button"
                  className="ref-item current-ref"
                  title={selectedRepository.head}
                  data-ref-item="true"
                  onClick={() => {
                    const headRef: RefLabel = {
                      fullName: 'HEAD',
                      shortName: selectedRepository.currentBranch ?? selectedRepository.head?.slice(0, 8) ?? 'HEAD',
                      kind: 'local',
                      target: selectedRepository.head ?? '',
                      ahead: 0,
                      behind: 0,
                      isCurrent: true,
                    };
                    selectRef(headRef);
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    if (!state.selectedRepositoryId || !selectedRepository.head) return;
                    setContextMenu({
                      kind: 'head',
                      repositoryId: state.selectedRepositoryId,
                      hash: selectedRepository.head,
                      x: event.clientX,
                      y: event.clientY,
                    });
                  }}
                >
                  <span className="ref-icon" aria-hidden="true">
                    ●
                  </span>
                  <span>{selectedRepository.currentBranch ?? selectedRepository.head.slice(0, 8)}</span>
                </button>
              ) : null}
            </section>
            {refGroups.map((group) => {
              const refs = state.refs.filter((ref) => ref.kind === group.kind);
              const collapsed = collapsedRefGroups.has(group.kind);
              const remoteGroupName = (ref: RefLabel): string => ref.remote ?? 'Unresolved';
              const remoteGroups =
                group.kind === 'remote'
                  ? [...new Set(refs.map(remoteGroupName))]
                  : [];
              const renderRef = (ref: RefLabel) => (
                <button
                  type="button"
                  className={`ref-item${ref.isCurrent ? ' current-ref' : ''}`}
                  key={ref.fullName}
                  title={ref.fullName}
                  data-ref-item="true"
                  onClick={() => selectRef(ref)}
                  onKeyDown={(event) => handleRefKeyDown(event, ref)}
                  onDoubleClick={() => {
                    if (ref.kind === 'local' && !selectedRepository?.isBare) {
                      runOperation({ kind: 'checkout', ref: ref.shortName });
                    }
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    if (!state.selectedRepositoryId) return;
                    setContextMenu({
                      kind: 'ref',
                      repositoryId: state.selectedRepositoryId,
                      ref,
                      x: event.clientX,
                      y: event.clientY,
                    });
                  }}
                >
                  <span className="ref-icon" aria-hidden="true">
                    {ref.kind === 'tag' ? '◆' : '⌁'}
                  </span>
                  <span className="ref-name">
                    {ref.kind === 'remote' && ref.remote
                      ? ref.shortName.slice(ref.remote.length + 1)
                      : ref.shortName}
                  </span>
                  {ref.upstream ? <span className="upstream">{ref.upstream}</span> : null}
                  {ref.ahead || ref.behind ? (
                    <span className="tracking">
                      {ref.ahead ? `↑${String(ref.ahead)}` : ''}
                      {ref.behind ? ` ↓${String(ref.behind)}` : ''}
                    </span>
                  ) : null}
                </button>
              );
              return (
                <section className="ref-group" key={group.kind}>
                  <button
                    type="button"
                    className="ref-group-heading"
                    aria-expanded={!collapsed}
                    onClick={() => toggleRefGroup(group.kind)}
                  >
                    <span aria-hidden="true">{collapsed ? '›' : '⌄'}</span>
                    <span>{group.label}</span>
                    <span className="ref-count">{refs.length}</span>
                  </button>
                  {!collapsed && group.kind === 'remote'
                    ? remoteGroups.map((remote) => (
                        <div
                          className="remote-ref-group"
                          role="group"
                          aria-label={`Remote ${remote}`}
                          key={remote}
                        >
                          <div className="remote-ref-heading">{remote}</div>
                          {refs.filter((ref) => remoteGroupName(ref) === remote).map(renderRef)}
                        </div>
                      ))
                    : null}
                  {!collapsed && group.kind !== 'remote' ? refs.map(renderRef) : null}
                </section>
              );
            })}
          </div>
        </nav>

        <div
          className="pane-resizer vertical"
          role="separator"
          aria-label="Resize references pane"
          aria-orientation="vertical"
          aria-valuemin={160}
          aria-valuenow={state.layout.refsWidth}
          hidden={refsCollapsed}
          tabIndex={0}
          onPointerDown={(event) => beginResize('refsWidth', event)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') resizeLayout('refsWidth', -10);
            if (event.key === 'ArrowRight') resizeLayout('refsWidth', 10);
          }}
        />

        <section
          ref={logRef}
          className="log-pane pane"
          role="grid"
          aria-label="Commit log"
          tabIndex={0}
          style={
            {
              '--refs-column-width': `${String(state.layout.refsColumnWidth ?? 150)}px`,
              '--author-column-width': `${String(state.layout.authorColumnWidth ?? 130)}px`,
              '--date-column-width': `${String(state.layout.dateColumnWidth ?? 125)}px`,
              '--log-content-width': `${String(logContentWidth)}px`,
              '--log-grid-columns': `${
                state.layout.commitColumnWidth
                  ? `${String(state.layout.commitColumnWidth)}px`
                  : 'minmax(260px, 1fr)'
              } ${String(state.layout.authorColumnWidth ?? 130)}px ${String(
                state.layout.dateColumnWidth ?? 125,
              )}px ${String(state.layout.refsColumnWidth ?? 150)}px`,
            } as CSSProperties
          }
        >
          <div className="log-header-viewport" ref={logHeaderViewportRef}>
            <div className="log-header" role="row">
              <span className="column-header" role="columnheader">
                Commit
                <div
                  className="column-resizer"
                  role="separator"
                  aria-label="Resize commit column"
                  aria-orientation="vertical"
                  aria-valuemin={160}
                  aria-valuenow={state.layout.commitColumnWidth}
                  aria-valuetext={
                    state.layout.commitColumnWidth === undefined ? 'Auto width' : undefined
                  }
                  tabIndex={0}
                  onPointerDown={(event) =>
                    beginColumnResize(
                      'commitColumnWidth',
                      event,
                      event.currentTarget.parentElement?.getBoundingClientRect().width,
                    )
                  }
                  onKeyDown={(event) => {
                    const measuredWidth =
                      event.currentTarget.parentElement?.getBoundingClientRect().width;
                    if (event.key === 'ArrowLeft') {
                      resizeColumn('commitColumnWidth', -10, measuredWidth);
                    }
                    if (event.key === 'ArrowRight') {
                      resizeColumn('commitColumnWidth', 10, measuredWidth);
                    }
                  }}
                />
              </span>
              <span className="column-header" role="columnheader">
                Author
                <div
                  className="column-resizer"
                  role="separator"
                  aria-label="Resize author column"
                  aria-orientation="vertical"
                  aria-valuenow={state.layout.authorColumnWidth ?? 130}
                  tabIndex={0}
                  onPointerDown={(event) => beginColumnResize('authorColumnWidth', event)}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowLeft') resizeColumn('authorColumnWidth', -10);
                    if (event.key === 'ArrowRight') resizeColumn('authorColumnWidth', 10);
                  }}
                />
              </span>
              <span className="column-header" role="columnheader">
                Date
                <div
                  className="column-resizer"
                  role="separator"
                  aria-label="Resize date column"
                  aria-orientation="vertical"
                  aria-valuenow={state.layout.dateColumnWidth ?? 125}
                  tabIndex={0}
                  onPointerDown={(event) => beginColumnResize('dateColumnWidth', event)}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowLeft') resizeColumn('dateColumnWidth', -10);
                    if (event.key === 'ArrowRight') resizeColumn('dateColumnWidth', 10);
                  }}
                />
              </span>
              <span className="column-header" role="columnheader">
                Refs
                <div
                  className="column-resizer"
                  role="separator"
                  aria-label="Resize refs column"
                  aria-orientation="vertical"
                  aria-valuenow={state.layout.refsColumnWidth ?? 150}
                  tabIndex={0}
                  onPointerDown={(event) => beginColumnResize('refsColumnWidth', event)}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowLeft') resizeColumn('refsColumnWidth', -10);
                    if (event.key === 'ArrowRight') resizeColumn('refsColumnWidth', 10);
                  }}
                />
              </span>
            </div>
          </div>
          {(state.history?.entries ?? state.commits).length ? (
            <CommitList
              commits={state.history?.entries ?? state.commits}
              graphLayout={graphLayout}
              selectedHash={state.selectedHash}
              headHash={selectedRepository?.head}
              hasMore={state.history?.hasMore ?? state.hasMore}
              loading={state.loading === 'log'}
              initialScrollTop={
                state.history
                  ? 0
                  : state.selectedRepositoryId
                  ? (scrollTopByRepository[state.selectedRepositoryId] ?? 0)
                  : 0
              }
              onScrollTopChange={(scrollTop) => {
                if (state.history || !state.selectedRepositoryId) return;
                const repositoryId = state.selectedRepositoryId;
                setScrollTopByRepository((current) => {
                  const next = { ...current, [repositoryId]: scrollTop };
                  vscode.setState({ scrollTopByRepository: next });
                  return next;
                });
                if (scrollPersistTimer.current !== undefined) {
                  window.clearTimeout(scrollPersistTimer.current);
                }
                scrollPersistTimer.current = window.setTimeout(() => {
                  const logWindow = logWindowRef.current;
                  send({
                    type: 'updateScrollAnchor',
                    requestId: requestId('scroll'),
                    repositoryId,
                    scrollTop,
                    logOffset: logWindow.startLogOffset,
                    ...(logWindow.graphContinuation
                      ? { graphContinuation: logWindow.graphContinuation }
                      : {}),
                  });
                }, 200);
              }}
              onHorizontalScroll={(scrollLeft) => {
                if (logHeaderViewportRef.current) {
                  logHeaderViewportRef.current.scrollLeft = scrollLeft;
                }
              }}
              onSelect={selectCommit}
              onContextMenu={(commit, x, y) => {
                if (state.history) return;
                if (!state.selectedRepositoryId) return;
                setContextMenu({
                  kind: 'commit',
                  repositoryId: state.selectedRepositoryId,
                  commit,
                  x,
                  y,
                });
              }}
              onLoadMore={loadMore}
            />
          ) : state.loading === 'repositories' || state.loading === 'log' ? (
            <div className="skeleton-list" role="status" aria-label="Loading Git history">
              {Array.from({ length: 10 }, (_, index) => (
                <div className="commit-skeleton-row" data-testid="commit-skeleton-row" key={index}>
                  <span className="skeleton-graph" />
                  <span className="skeleton-subject" />
                  <span className="skeleton-author" />
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-log" role="row">
              <div>
                <strong>
                  {state.history
                    ? state.history.notice ?? 'No history found'
                    : state.repositories.length
                      ? 'No commits found'
                      : 'No repository selected'}
                </strong>
                <span>
                  {state.history
                    ? 'Try another line, selection, or file.'
                    : state.repositories.length
                      ? 'This repository has no commits or the current filters returned no results.'
                      : 'Open a workspace containing a Git repository.'}
                </span>
              </div>
            </div>
          )}
        </section>

        <div
          className="pane-resizer vertical"
          role="separator"
          aria-label="Resize changed files pane"
          aria-orientation="vertical"
          aria-valuemin={220}
          aria-valuenow={state.layout.filesWidth}
          hidden={filesCollapsed}
          tabIndex={0}
          onPointerDown={(event) => beginResize('filesWidth', event)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') resizeLayout('filesWidth', 10);
            if (event.key === 'ArrowRight') resizeLayout('filesWidth', -10);
          }}
        />

        <section
          className="files-pane pane"
          role="region"
          aria-label="Changed files"
          hidden={filesCollapsed}
        >
          <div className="pane-heading files-heading">
            <span>Changed Files</span>
            {state.details && state.details.parents.length > 1 ? (
              <select
                className="parent-selector"
                aria-label="Diff parent"
                value={state.selectedParent ?? ''}
                onChange={(event) => {
                  const parent = event.target.value;
                  setState((current) => ({ ...current, selectedParent: parent }));
                  if (state.detailsRepositoryId && state.details) {
                    const parentRequestId = requestId('parent');
                    activeSelectionRequest.current = {
                      requestId: parentRequestId,
                      repositoryId: state.detailsRepositoryId,
                      hash: state.details.hash,
                    };
                    send({
                      type: 'selectParent',
                      requestId: parentRequestId,
                      repositoryId: state.detailsRepositoryId,
                      hash: state.details.hash,
                      parent,
                    });
                  }
                }}
              >
                {state.details.parents.map((parent, index) => (
                  <option value={parent} key={parent}>
                    Parent {String(index + 1)} · {parent.slice(0, 8)}
                  </option>
                ))}
              </select>
            ) : null}
            <span className="segmented-control" aria-label="Changed files display mode">
              <button
                type="button"
                aria-pressed={state.layout.filesViewMode === 'tree'}
                title="Tree view"
                onClick={() => updateFilesViewMode('tree')}
              >
                Tree
              </button>
              <button
                type="button"
                aria-pressed={state.layout.filesViewMode === 'list'}
                title="List view"
                onClick={() => updateFilesViewMode('list')}
              >
                List
              </button>
            </span>
          </div>
          {state.files.length ? (
            <div className="file-list">
              <div className="file-list-content">
                {state.layout.filesViewMode === 'tree' ? (
                  <FileTreeNodes
                    nodes={buildFileTree(state.files)}
                    depth={0}
                    onOpen={openDiff}
                    onSelect={(file) => setState((current) => ({ ...current, selectedFile: file }))}
                    onContextMenu={(file, x, y) => {
                      if (!state.detailsRepositoryId) return;
                      setContextMenu({
                        kind: 'file',
                        repositoryId: state.detailsRepositoryId,
                        file,
                        x,
                        y,
                      });
                    }}
                  />
                ) : (
                  state.files.map((file) => (
                    <ChangedFileRow
                      file={file}
                      onOpen={openDiff}
                      onSelect={(selectedFile) =>
                        setState((current) => ({ ...current, selectedFile }))
                      }
                      onContextMenu={(selectedFile, x, y) => {
                        if (!state.detailsRepositoryId) return;
                        setContextMenu({
                          kind: 'file',
                          repositoryId: state.detailsRepositoryId,
                          file: selectedFile,
                          x,
                          y,
                        });
                      }}
                      key={`${file.oldPath ?? ''}:${file.path}`}
                    />
                  ))
                )}
              </div>
            </div>
          ) : (
            <div className="empty-pane">
              {state.loading === 'selection' ? 'Loading changed files…' : 'Select a commit to inspect its files.'}
            </div>
          )}
          {state.selectedFile ? (
            <div className="file-preview" role="status" aria-label="Changed file preview">
              <span>{state.selectedFile.path}</span>
              <span> · {changedFileStatusLabel(state.selectedFile.status)}</span>
              {state.selectedFile.additions !== undefined ? (
                <span className="file-stat-additions">
                  {' '}· +{String(state.selectedFile.additions)}
                </span>
              ) : null}
              {state.selectedFile.deletions !== undefined ? (
                <span className="file-stat-deletions">
                  {' '}−{String(state.selectedFile.deletions)}
                </span>
              ) : null}
            </div>
          ) : null}
        </section>
      </section>

      {selectedOperationInFlight ? (
        <div className="operation-status" role="status" aria-live="polite">
          Running Git operation…
        </div>
      ) : null}

      <div
        className="pane-resizer horizontal"
        role="separator"
        aria-label="Resize commit details pane"
        aria-orientation="horizontal"
        aria-valuemin={100}
        aria-valuenow={state.layout.detailsHeight}
        tabIndex={0}
        onPointerDown={(event) => beginResize('detailsHeight', event)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowUp') resizeLayout('detailsHeight', 10);
          if (event.key === 'ArrowDown') resizeLayout('detailsHeight', -10);
        }}
      />

      <section
        ref={detailsRef}
        className="details-pane pane"
        role="region"
        aria-label="Commit details"
        tabIndex={-1}
      >
        {state.details ? (
          <div className="details-content">
            <div className="details-heading-row">
              <div className="details-message">{state.details.subject}</div>
              <div className="details-actions" role="toolbar" aria-label="Commit actions">
                <button
                  type="button"
                  aria-label="Cherry-pick selected commit"
                  disabled={
                    selectedRepository?.isBare ||
                    Boolean(selectedRepository?.operationState) ||
                    selectedOperationInFlight
                  }
                  onClick={() =>
                    runOperation(
                      { kind: 'cherryPick', hash: state.details?.hash ?? '' },
                      state.detailsRepositoryId,
                    )
                  }
                >
                  Cherry-pick
                </button>
                <button
                  type="button"
                  aria-label="Revert selected commit"
                  disabled={
                    selectedRepository?.isBare ||
                    Boolean(selectedRepository?.operationState) ||
                    selectedOperationInFlight
                  }
                  onClick={() =>
                    runOperation(
                      { kind: 'revert', hash: state.details?.hash ?? '' },
                      state.detailsRepositoryId,
                    )
                  }
                >
                  Revert
                </button>
              </div>
            </div>
            <div className="details-meta">
              <span>Author: {state.details.authorName} &lt;{state.details.authorEmail}&gt;</span>
              <span>Authored: {formatDate(state.details.authorTime)}</span>
              <span>
                Committer: {state.details.committerName} &lt;{state.details.committerEmail}&gt;
              </span>
              <span>Committed: {formatDate(state.details.commitTime)}</span>
              <span className="details-hash">
                <code>{state.details.hash}</code>
                <button
                  type="button"
                  aria-label="Copy full commit hash"
                  disabled={detailsHashCopyState === 'copying'}
                  onClick={() => {
                    const copyRequestId = requestId('copy-hash');
                    detailsHashCopyRequest.current = copyRequestId;
                    if (detailsHashCopyTimer.current !== undefined) {
                      window.clearTimeout(detailsHashCopyTimer.current);
                      detailsHashCopyTimer.current = undefined;
                    }
                    setDetailsHashCopyState('copying');
                    send({
                      type: 'copyToClipboard',
                      requestId: copyRequestId,
                      text: state.details?.hash ?? '',
                    });
                  }}
                >
                  {detailsHashCopyState === 'copying'
                    ? 'Copying…'
                    : detailsHashCopyState === 'copied'
                      ? 'Copied'
                      : 'Copy'}
                </button>
              </span>
              {state.details.parents.length ? (
                <span className="details-parents">
                  Parents:{' '}
                  {state.details.parents.map((parent) => (
                    <button
                      type="button"
                      aria-label={`Parent ${parent}`}
                      title={parent}
                      key={parent}
                      onClick={() => selectHash(parent, 'parent')}
                    >
                      {parent.slice(0, 8)}
                    </button>
                  ))}
                </span>
              ) : (
                <span>Parents: root commit</span>
              )}
              {state.details.refs.length ? (
                <span className="details-refs">
                  Refs: {state.details.refs.map((ref) => <span key={ref.fullName}>{ref.shortName}</span>)}
                </span>
              ) : null}
              <span>Signature: {state.details.signature}</span>
            </div>
            <div className="details-body">
              {state.details.body
                .split(/\r?\n/u)
                .filter((line, index) => index > 0 && line.length > 0)
                .map((line, index) => (
                  <p key={`${String(index)}:${line}`}>{line}</p>
                ))}
            </div>
          </div>
        ) : (
          <>
            <div className="details-message">Commit Details</div>
            <div className="details-placeholder">Select a commit to view its message and metadata.</div>
          </>
        )}
      </section>

      {contextMenu ? (
        <div
          className="context-menu"
          role="menu"
          aria-label={`${contextMenu.kind} actions`}
          style={{ left: Math.max(4, contextMenu.x), top: Math.max(4, contextMenu.y) }}
          onClick={(event) => {
            const target = event.target;
            if (!(target instanceof Element)) return;
            const menuItem = target.closest<HTMLButtonElement>('button[role="menuitem"]');
            if (menuItem && !menuItem.disabled) setContextMenu(undefined);
          }}
        >
          {contextMenu.kind === 'toolbar' ? (
            selectedRepository?.operationState ? (
              <span className="menu-note">
                Git {selectedRepository.operationState} is in progress. Finish or abort it first.
              </span>
            ) : selectedRepository?.isBare ? (
              <span className="menu-note">Bare repositories are read-only.</span>
            ) : (
              <>
              <button
                type="button"
                role="menuitem"
                disabled={!selectedRepository?.currentBranch}
                onClick={() => runOperation({ kind: 'pull' }, contextMenu.repositoryId)}
              >
                Pull
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={!selectedRepository?.currentBranch}
                onClick={() => runOperation({ kind: 'push' }, contextMenu.repositoryId)}
              >
                Push
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={!selectedRepository?.currentBranch}
                onClick={() =>
                  runOperation({ kind: 'push', forceWithLease: true }, contextMenu.repositoryId)
                }
              >
                Force Push with Lease…
              </button>
              </>
            )
          ) : null}
          {contextMenu.kind === 'commit' ? (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  selectHash(contextMenu.commit.hash, 'details');
                  setContextMenu(undefined);
                  detailsRef.current?.focus();
                }}
              >
                Show Details
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={!contextMenu.commit.parents[0]}
                title={contextMenu.commit.parents[0] ? 'Open all changed text files' : 'Root commit has no parent'}
                onClick={() =>
                  openCommitComparison(
                    contextMenu.commit.hash,
                    'parent',
                    contextMenu.commit.parents[0],
                  )
                }
              >
                Compare with Parent
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={!selectedRepository?.head || selectedRepository.head === contextMenu.commit.hash}
                title="Compare this commit with the current HEAD"
                onClick={() => openCommitComparison(contextMenu.commit.hash, 'current')}
              >
                Compare with Current
              </button>
              {!selectedRepository?.isBare && !selectedRepository?.operationState ? (
                <>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setNamedOperation({
                    kind: 'createBranch',
                    repositoryId: contextMenu.repositoryId,
                    target: contextMenu.commit.hash,
                    value: '',
                  });
                  setContextMenu(undefined);
                }}
              >
                New Branch…
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setNamedOperation({
                    kind: 'createTag',
                    repositoryId: contextMenu.repositoryId,
                    target: contextMenu.commit.hash,
                    value: '',
                  });
                  setContextMenu(undefined);
                }}
              >
                New Tag…
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() =>
                  runOperation(
                    { kind: 'cherryPick', hash: contextMenu.commit.hash },
                    contextMenu.repositoryId,
                  )
                }
              >
                Cherry-pick
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() =>
                  runOperation(
                    { kind: 'revert', hash: contextMenu.commit.hash },
                    contextMenu.repositoryId,
                  )
                }
              >
                Revert
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={
                  !selectedRepository?.currentBranch ||
                  selectedRepository.head === contextMenu.commit.hash
                }
                onClick={() =>
                  runOperation(
                    { kind: 'merge', ref: contextMenu.commit.hash },
                    contextMenu.repositoryId,
                  )
                }
              >
                Merge into Current
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={
                  !selectedRepository?.currentBranch ||
                  selectedRepository.head === contextMenu.commit.hash
                }
                onClick={() =>
                  runOperation(
                    { kind: 'rebase', ref: contextMenu.commit.hash },
                    contextMenu.repositoryId,
                  )
                }
              >
                Rebase Current onto This
              </button>
              {selectedRepository?.currentBranch
                ? (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() =>
                        runOperation(
                          { kind: 'reset', mode: 'soft', hash: contextMenu.commit.hash },
                          contextMenu.repositoryId,
                        )
                      }
                    >
                      Soft Reset
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() =>
                        runOperation(
                          { kind: 'reset', mode: 'mixed', hash: contextMenu.commit.hash },
                          contextMenu.repositoryId,
                        )
                      }
                    >
                      Mixed Reset
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() =>
                        runOperation(
                          { kind: 'reset', mode: 'hard', hash: contextMenu.commit.hash },
                          contextMenu.repositoryId,
                        )
                      }
                    >
                      Hard Reset…
                    </button>
                  </>
                )
                : null}
                </>
              ) : null}
              <button
                type="button"
                role="menuitem"
                onClick={() =>
                  send({
                    type: 'copyToClipboard',
                    requestId: requestId('copy-hash'),
                    text: contextMenu.commit.hash,
                  })
                }
              >
                Copy Hash
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() =>
                  send({
                    type: 'copyToClipboard',
                    requestId: requestId('copy-subject'),
                    text: contextMenu.commit.subject,
                  })
                }
              >
                Copy Subject
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={state.details?.hash !== contextMenu.commit.hash}
                title={
                  state.details?.hash === contextMenu.commit.hash
                    ? 'Copy the complete commit message'
                    : 'Show Details first to load the full message'
                }
                onClick={() =>
                  send({
                    type: 'copyToClipboard',
                    requestId: requestId('copy-message'),
                    text: state.details?.body ?? '',
                  })
                }
              >
                Copy Full Message
              </button>
            </>
          ) : null}
          {contextMenu.kind === 'file' ? (
            <>
              <button
                type="button"
                role="menuitem"
                disabled={contextMenu.file.binary}
                title={contextMenu.file.binary ? 'Binary files cannot be opened in the text diff editor' : undefined}
                onClick={() => {
                  openDiff(contextMenu.file);
                  setContextMenu(undefined);
                }}
              >
                Show Diff
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={
                  contextMenu.file.binary ||
                  (contextMenu.file.status === 'D' && !state.selectedParent)
                }
                title={
                  contextMenu.file.binary
                    ? 'Binary files cannot be opened in the text editor'
                    : contextMenu.file.status === 'D' && !state.selectedParent
                      ? 'The deleted file has no available parent revision'
                      : undefined
                }
                onClick={() => openFile(contextMenu.file, 'revision')}
              >
                Open File at Revision
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => openFile(contextMenu.file, 'current')}
              >
                Open Current File
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  send({
                    type: 'copyToClipboard',
                    requestId: requestId('copy-path'),
                    text: contextMenu.file.path,
                  });
                  setContextMenu(undefined);
                }}
              >
                Copy Path
              </button>
            </>
          ) : null}
          {contextMenu.kind === 'ref' ? (
            <>
              <button
                type="button"
                role="menuitem"
                disabled={!selectedRepository?.head || selectedRepository.head === contextMenu.ref.target}
                onClick={() => openCommitComparison(contextMenu.ref.target, 'current')}
              >
                Compare with Current
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() =>
                  send({
                    type: 'copyToClipboard',
                    requestId: requestId('copy-ref'),
                    text: contextMenu.ref.shortName,
                  })
                }
              >
                Copy Name
              </button>
              {!selectedRepository?.isBare && !selectedRepository?.operationState ? (
                <>
                  {contextMenu.ref.kind === 'local' ? (
                    <button
                      type="button"
                      role="menuitem"
                      disabled={contextMenu.ref.isCurrent}
                      onClick={() =>
                        runOperation(
                          { kind: 'checkout', ref: contextMenu.ref.shortName },
                          contextMenu.repositoryId,
                        )
                      }
                    >
                      Checkout
                    </button>
                  ) : null}
                  {contextMenu.ref.kind === 'remote' &&
                  contextMenu.ref.remote &&
                  !contextMenu.ref.shortName.endsWith('/HEAD') ? (
                    <>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          const remote = contextMenu.ref.remote;
                          if (!remote) return;
                          const branch = contextMenu.ref.shortName.slice(remote.length + 1);
                          setNamedOperation({
                            kind: 'checkoutRemote',
                            repositoryId: contextMenu.repositoryId,
                            startPoint: contextMenu.ref.shortName,
                            value: branch,
                          });
                          setContextMenu(undefined);
                        }}
                      >
                        Checkout as New Local…
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          const remote = contextMenu.ref.remote;
                          if (!remote) return;
                          runOperation(
                            { kind: 'fetch', remote },
                            contextMenu.repositoryId,
                          )
                        }}
                      >
                        Fetch
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          const remote = contextMenu.ref.remote;
                          if (!remote) return;
                          const branch = contextMenu.ref.shortName.slice(remote.length + 1);
                          runOperation(
                            { kind: 'deleteRemoteBranch', remote, branch },
                            contextMenu.repositoryId,
                          );
                        }}
                      >
                        Delete Remote Branch…
                      </button>
                    </>
                  ) : null}
                  {contextMenu.ref.kind === 'tag' ? (
                    <>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() =>
                          runOperation(
                            { kind: 'checkout', ref: contextMenu.ref.fullName },
                            contextMenu.repositoryId,
                          )
                        }
                      >
                        Checkout
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() =>
                          runOperation(
                            { kind: 'deleteTag', name: contextMenu.ref.shortName },
                            contextMenu.repositoryId,
                          )
                        }
                      >
                        Delete Local Tag…
                      </button>
                    </>
                  ) : null}
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setNamedOperation({
                        kind: 'createBranch',
                        repositoryId: contextMenu.repositoryId,
                        target: contextMenu.ref.fullName,
                        value: '',
                      });
                      setContextMenu(undefined);
                    }}
                  >
                    New Branch from…
                  </button>
                  {contextMenu.ref.kind === 'local' ? (
                    <>
                      <button
                        type="button"
                        role="menuitem"
                        disabled={!selectedRepository?.currentBranch || contextMenu.ref.isCurrent}
                        onClick={() =>
                          runOperation(
                            { kind: 'merge', ref: contextMenu.ref.shortName },
                            contextMenu.repositoryId,
                          )
                        }
                      >
                        Merge into Current
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        disabled={!selectedRepository?.currentBranch || contextMenu.ref.isCurrent}
                        onClick={() =>
                          runOperation(
                            { kind: 'rebase', ref: contextMenu.ref.shortName },
                            contextMenu.repositoryId,
                          )
                        }
                      >
                        Rebase Current onto
                      </button>
                    </>
                  ) : null}
                  {contextMenu.ref.kind === 'local' ? (
                    <>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!contextMenu.ref.isCurrent}
                    title={contextMenu.ref.isCurrent ? 'Push the current branch' : 'Checkout this branch before pushing it'}
                    onClick={() => runOperation({ kind: 'push' }, contextMenu.repositoryId)}
                  >
                    Push
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setNamedOperation({
                        kind: 'renameBranch',
                        repositoryId: contextMenu.repositoryId,
                        oldName: contextMenu.ref.shortName,
                        value: contextMenu.ref.shortName,
                      });
                      setContextMenu(undefined);
                    }}
                  >
                    Rename…
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={contextMenu.ref.isCurrent}
                    onClick={() =>
                      runOperation(
                        { kind: 'deleteBranch', name: contextMenu.ref.shortName, force: false },
                        contextMenu.repositoryId,
                      )
                    }
                  >
                    Delete…
                  </button>
                    </>
                  ) : null}
                </>
              ) : null}
            </>
          ) : null}
          {contextMenu.kind === 'head' ? (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  send({
                    type: 'copyToClipboard',
                    requestId: requestId('copy-head'),
                    text: contextMenu.hash,
                  });
                  setContextMenu(undefined);
                }}
              >
                Copy Revision
              </button>
              {!selectedRepository?.isBare && !selectedRepository?.operationState ? (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setNamedOperation({
                        kind: 'createBranch',
                        repositoryId: contextMenu.repositoryId,
                        target: contextMenu.hash,
                        value: '',
                      });
                      setContextMenu(undefined);
                    }}
                  >
                    Create Branch…
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setNamedOperation({
                        kind: 'createTag',
                        repositoryId: contextMenu.repositoryId,
                        target: contextMenu.hash,
                        value: '',
                      });
                      setContextMenu(undefined);
                    }}
                  >
                    Create Tag…
                  </button>
                  {selectedRepository?.currentBranch
                    ? (
                      <>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() =>
                            runOperation(
                              { kind: 'reset', mode: 'soft', hash: contextMenu.hash },
                              contextMenu.repositoryId,
                            )
                          }
                        >
                          Reset Current Branch (soft)
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() =>
                            runOperation(
                              { kind: 'reset', mode: 'mixed', hash: contextMenu.hash },
                              contextMenu.repositoryId,
                            )
                          }
                        >
                          Reset Current Branch (mixed)
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() =>
                            runOperation(
                              { kind: 'reset', mode: 'hard', hash: contextMenu.hash },
                              contextMenu.repositoryId,
                            )
                          }
                        >
                          Reset Current Branch (hard)…
                        </button>
                      </>
                    )
                    : null}
                </>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      {historyParentPicker ? (
        <div className="operation-dialog-backdrop">
          <div
            className="operation-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Select history parent"
          >
            <strong>Select a parent for this merge commit</strong>
            <span>{historyParentPicker.commit.subject}</span>
            <div className="history-parent-options">
              {historyParentPicker.commit.parents.map((parent, index) => (
                <button
                  type="button"
                  aria-label={`Compare with parent ${parent.slice(0, 8)}`}
                  title={parent}
                  key={parent}
                  onClick={() => {
                    historyParentChoices.current.set(historyParentPicker.commit.hash, parent);
                    send({
                      type: 'openHistoryDiff',
                      requestId: requestId('history-diff'),
                      repositoryId: historyParentPicker.repositoryId,
                      hash: historyParentPicker.commit.hash,
                      parent,
                    });
                    setHistoryParentPicker(undefined);
                  }}
                >
                  Parent {String(index + 1)} · {parent.slice(0, 8)}
                </button>
              ))}
            </div>
            <div className="operation-dialog-actions">
              <button type="button" onClick={() => setHistoryParentPicker(undefined)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {namedOperation ? (
        <div className="operation-dialog-backdrop">
          <form
            className="operation-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={
              namedOperation.kind === 'createBranch'
                ? 'Create Branch'
                : namedOperation.kind === 'createTag'
                  ? 'Create Tag'
                  : namedOperation.kind === 'checkoutRemote'
                    ? 'Checkout Remote Branch'
                    : 'Rename Branch'
            }
            onSubmit={(event) => {
              event.preventDefault();
              submitNamedOperation();
            }}
          >
            <label>
              <span>
                {namedOperation.kind === 'createBranch'
                  ? 'Branch name'
                  : namedOperation.kind === 'createTag'
                    ? 'Tag name'
                    : namedOperation.kind === 'checkoutRemote'
                      ? 'Local branch name'
                      : 'New branch name'}
              </span>
              <input
                autoFocus
                aria-label={
                  namedOperation.kind === 'createBranch'
                    ? 'Branch name'
                    : namedOperation.kind === 'createTag'
                      ? 'Tag name'
                      : namedOperation.kind === 'checkoutRemote'
                        ? 'Local branch name'
                        : 'New branch name'
                }
                value={namedOperation.value}
                onChange={(event) =>
                  setNamedOperation((current) =>
                    current ? { ...current, value: event.target.value } : current,
                  )
                }
              />
            </label>
            <div className="operation-dialog-actions">
              <button type="button" onClick={() => setNamedOperation(undefined)}>
                Cancel
              </button>
              <button type="submit" disabled={!namedOperation.value.trim()}>
                {namedOperation.kind === 'createBranch'
                  ? 'Create Branch'
                  : namedOperation.kind === 'createTag'
                    ? 'Create Tag'
                    : namedOperation.kind === 'checkoutRemote'
                      ? 'Checkout'
                      : 'Rename Branch'}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </main>
  );
}
