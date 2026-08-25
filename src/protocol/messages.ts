import type {
  ChangedFile,
  CommitDetails,
  CommitSummary,
  EditorHistoryKind,
  HistoryEntry,
  RefLabel,
  RepositorySummary,
  StashEntry,
} from '../shared/models';
import type { GraphContinuationState } from '../graph/layoutCommitGraph';

const MAX_IDENTIFIER_LENGTH = 512;
const MAX_FILTER_TEXT_LENGTH = 2000;
const MAX_FILTER_ITEMS = 100;
const MAX_FILTER_ITEM_LENGTH = 4096;
const MAX_LOG_OFFSET = 10_000_000;
const MAX_UNIX_SECONDS = 253_402_300_799;
const MAX_COMMIT_RANGE = 100;
const MAX_COMMIT_MESSAGE_LENGTH = 100_000;

export interface LogFilters {
  text: string;
  branches: string[];
  authors: string[];
  dateFrom?: number;
  dateTo?: number;
  paths: string[];
}

export interface WorkbenchLayout {
  refsWidth: number;
  filesWidth: number;
  detailsHeight: number;
  detailsPlacement?: 'bottom' | 'changes';
  filesViewMode: 'tree' | 'list';
  commitColumnWidth?: number;
  refsColumnWidth?: number;
  authorColumnWidth?: number;
  dateColumnWidth?: number;
  refsCollapsed?: boolean;
  filesCollapsed?: boolean;
  hiddenColumns?: Array<'refs' | 'author' | 'date'>;
}

export interface PersistedWorkbenchState {
  selectedRepositoryId?: string;
  repositories: Record<
    string,
    {
      filters: LogFilters;
      selectedHash?: string;
      scrollTop?: number;
      logOffset?: number;
      graphContinuation?: GraphContinuationState;
    }
  >;
}

export type WebviewToExtensionMessage =
  | { type: 'ready'; requestId: string }
  | { type: 'selectRepository'; requestId: string; repositoryId: string }
  | {
      type: 'selectCommit';
      requestId: string;
      repositoryId: string;
      hash: string;
      hashes?: string[];
    }
  | {
      type: 'requestCommitMessages';
      requestId: string;
      repositoryId: string;
      hashes: string[];
    }
  | {
      type: 'selectParent';
      requestId: string;
      repositoryId: string;
      hash: string;
      parent: string;
    }
  | { type: 'requestLogPage'; requestId: string; repositoryId: string; skip: number }
  | { type: 'requestHistoryPage'; requestId: string; repositoryId: string; skip: number }
  | { type: 'switchHistoryToFile'; requestId: string; repositoryId: string }
  | {
      type: 'openHistoryDiff';
      requestId: string;
      repositoryId: string;
      hash: string;
      parent?: string;
    }
  | { type: 'closeHistory'; requestId: string; repositoryId: string }
  | { type: 'requestStashState'; requestId: string; repositoryId: string }
  | { type: 'openStashComparison'; requestId: string; repositoryId: string; hash: string }
  | { type: 'refresh'; requestId: string; repositoryId?: string }
  | { type: 'showOutput'; requestId: string }
  | { type: 'copyToClipboard'; requestId: string; text: string }
  | {
      type: 'updateScrollAnchor';
      requestId: string;
      repositoryId: string;
      scrollTop: number;
      logOffset?: number;
      graphContinuation?: GraphContinuationState;
    }
  | { type: 'updateFilters'; requestId: string; repositoryId: string; filters: LogFilters }
  | {
      type: 'openDiff';
      requestId: string;
      repositoryId: string;
      hash: string;
      parent?: string;
      path: string;
      oldPath?: string;
      status: ChangedFile['status'];
    }
  | {
      type: 'openFile';
      requestId: string;
      repositoryId: string;
      hash: string;
      parent?: string;
      path: string;
      oldPath?: string;
      status: ChangedFile['status'];
      mode: 'revision' | 'current';
    }
  | {
      type: 'openCommitComparison';
      requestId: string;
      repositoryId: string;
      hash: string;
      mode: 'parent' | 'current';
      parent?: string;
    }
  | { type: 'updateLayout'; requestId: string; layout: WorkbenchLayout }
  | { type: 'runOperation'; requestId: string; repositoryId: string; operation: GitOperationRequest };

export type GitOperationRequest =
  | { kind: 'checkout'; ref: string }
  | { kind: 'createBranch'; name: string; startPoint: string }
  | { kind: 'createTag'; name: string; target: string }
  | { kind: 'deleteTag'; name: string }
  | { kind: 'checkoutRemote'; name: string; startPoint: string }
  | { kind: 'deleteRemoteBranch'; remote: string; branch: string }
  | { kind: 'fetch'; remote?: string }
  | { kind: 'pull' }
  | { kind: 'push'; forceWithLease?: boolean; remote?: string; targetRef?: string }
  | { kind: 'cherryPick'; hash: string }
  | { kind: 'revert'; hash: string }
  | { kind: 'merge'; ref: string }
  | { kind: 'rebase'; ref: string }
  | { kind: 'reset'; hash: string; mode: 'soft' | 'mixed' | 'hard' }
  | { kind: 'renameBranch'; oldName: string; newName: string }
  | { kind: 'deleteBranch'; name: string; force: boolean }
  | { kind: 'createStash'; message: string; includeUntracked: boolean }
  | { kind: 'applyStash'; stash: string }
  | { kind: 'popStash'; stash: string }
  | { kind: 'dropStash'; stash: string }
  | { kind: 'amendCommit'; message: string }
  | { kind: 'dropCommits'; hashes: string[] }
  | { kind: 'squashCommits'; hashes: string[]; message: string };

export type ErrorRecoveryAction = { kind: 'forceDeleteBranch'; branch: string };

export type ExtensionToWebviewMessage =
  | {
      type: 'initialize';
      requestId: string;
      repositories: RepositorySummary[];
      selectedRepositoryId?: string;
      pageSize: number;
      maxCachedCommits: number;
      layout: WorkbenchLayout;
    }
  | {
      type: 'repositoryData';
      requestId: string;
      repositoryId: string;
      refs: RefLabel[];
      commits: CommitSummary[];
      filters: LogFilters;
      selectedHash?: string;
      scrollTop?: number;
      startLogOffset?: number;
      graphContinuation?: GraphContinuationState;
      replace: boolean;
      hasMore: boolean;
    }
  | {
      type: 'repositoriesUpdated';
      requestId: string;
      repositories: RepositorySummary[];
      selectedRepositoryId?: string;
    }
  | {
      type: 'selectionDetailsLoaded';
      requestId: string;
      repositoryId: string;
      details: CommitDetails;
      files: ChangedFile[];
      selectedParent?: string;
    }
  | {
      type: 'commitMessagesLoaded';
      requestId: string;
      repositoryId: string;
      messages: Array<{ hash: string; message: string }>;
    }
  | {
      type: 'historyOpened';
      requestId: string;
      repositoryId: string;
      kind: EditorHistoryKind;
      path: string;
      startLine?: number;
      endLine?: number;
      entries: HistoryEntry[];
      replace: boolean;
      hasMore: boolean;
      notice?: string;
    }
  | { type: 'historyClosed'; requestId: string; repositoryId: string; reason?: string }
  | {
      type: 'loading';
      requestId: string;
      repositoryId?: string;
      scope: 'repositories' | 'log' | 'selection' | 'operation';
    }
  | { type: 'operationCompleted'; requestId: string; repositoryId: string; message: string }
  | { type: 'operationCancelled'; requestId: string; repositoryId: string }
  | { type: 'clipboardCopied'; requestId: string }
  | {
      type: 'stashStateLoaded';
      requestId: string;
      repositoryId: string;
      stashes: StashEntry[];
    }
  | {
      type: 'error';
      requestId: string;
      repositoryId?: string;
      message: string;
      detail?: string;
      recovery?: ErrorRecoveryAction;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasBase(value: Record<string, unknown>): value is Record<string, unknown> & {
  type: string;
  requestId: string;
} {
  return (
    typeof value.type === 'string' &&
    typeof value.requestId === 'string' &&
    value.requestId.length > 0 &&
    value.requestId.length <= MAX_IDENTIFIER_LENGTH &&
    !/[\0\r\n]/u.test(value.requestId)
  );
}

function hasRepository(value: Record<string, unknown>): value is Record<string, unknown> & {
  repositoryId: string;
} {
  return (
    typeof value.repositoryId === 'string' &&
    value.repositoryId.length > 0 &&
    value.repositoryId.length <= MAX_IDENTIFIER_LENGTH &&
    !/[\0\r\n]/u.test(value.repositoryId)
  );
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{4,64}$/iu.test(value);
}

function isCommitRange(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    value.length <= MAX_COMMIT_RANGE &&
    value.every(isHash) &&
    new Set(value).size === value.length
  );
}

function isCommitSelection(value: unknown, selectedHash: string): value is string[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= MAX_COMMIT_RANGE &&
    value.every(isHash) &&
    new Set(value).size === value.length &&
    value.includes(selectedHash)
  );
}

function isLayout(value: unknown): value is WorkbenchLayout {
  if (!isRecord(value)) return false;
  const inRange = (candidate: unknown, minimum: number, maximum: number): candidate is number =>
    typeof candidate === 'number' &&
    Number.isFinite(candidate) &&
    candidate >= minimum &&
    candidate <= maximum;
  return (
    inRange(value.refsWidth, 120, 2000) &&
    inRange(value.filesWidth, 160, 3000) &&
    inRange(value.detailsHeight, 80, 2000) &&
    (value.detailsPlacement === undefined ||
      value.detailsPlacement === 'bottom' ||
      value.detailsPlacement === 'changes') &&
    (value.filesViewMode === 'tree' || value.filesViewMode === 'list') &&
    (value.commitColumnWidth === undefined || inRange(value.commitColumnWidth, 160, 2000)) &&
    (value.refsColumnWidth === undefined || inRange(value.refsColumnWidth, 40, 2000)) &&
    (value.authorColumnWidth === undefined || inRange(value.authorColumnWidth, 40, 2000)) &&
    (value.dateColumnWidth === undefined || inRange(value.dateColumnWidth, 40, 2000)) &&
    (value.refsCollapsed === undefined || typeof value.refsCollapsed === 'boolean') &&
    (value.filesCollapsed === undefined || typeof value.filesCollapsed === 'boolean') &&
    (value.hiddenColumns === undefined ||
      (Array.isArray(value.hiddenColumns) &&
        value.hiddenColumns.length <= 3 &&
        new Set(value.hiddenColumns).size === value.hiddenColumns.length &&
        value.hiddenColumns.every((column) => ['refs', 'author', 'date'].includes(String(column)))))
  );
}

function isFilters(value: unknown): value is LogFilters {
  if (!isRecord(value)) return false;
  const isFilterText = (item: unknown, maximumLength: number): item is string =>
    typeof item === 'string' &&
    item.length <= maximumLength &&
    !/[\0\r\n]/u.test(item);
  const isFilterArray = (
    candidate: unknown,
    predicate: (item: unknown) => boolean,
  ): candidate is string[] =>
    Array.isArray(candidate) &&
    candidate.length <= MAX_FILTER_ITEMS &&
    candidate.every(predicate);
  const isDate = (candidate: unknown): candidate is number =>
    typeof candidate === 'number' &&
    Number.isSafeInteger(candidate) &&
    candidate >= 0 &&
    candidate <= MAX_UNIX_SECONDS;
  const dateFrom = value.dateFrom;
  const dateTo = value.dateTo;
  return (
    isFilterText(value.text, MAX_FILTER_TEXT_LENGTH) &&
    isFilterArray(
      value.branches,
      (item) =>
        isFilterText(item, MAX_FILTER_ITEM_LENGTH) &&
        /^refs\/(heads|remotes|tags)\//u.test(item) &&
        !item.startsWith('-'),
    ) &&
    isFilterArray(value.authors, (item) => isFilterText(item, MAX_FILTER_ITEM_LENGTH)) &&
    isFilterArray(
      value.paths,
      (item) => isFilterText(item, MAX_FILTER_ITEM_LENGTH) && item.length > 0,
    ) &&
    (dateFrom === undefined || isDate(dateFrom)) &&
    (dateTo === undefined || isDate(dateTo)) &&
    (dateFrom === undefined || dateTo === undefined || dateFrom <= dateTo)
  );
}

function isRepositoryPath(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_FILTER_ITEM_LENGTH ||
    /[\0\r\n]/u.test(value)
  ) {
    return false;
  }
  const portablePath = value.replace(/\\/gu, '/');
  return (
    !portablePath.startsWith('/') &&
    !/^[a-z]:\//iu.test(portablePath) &&
    !portablePath.split('/').includes('..')
  );
}

function isChangedFileStatus(value: unknown): value is ChangedFile['status'] {
  return typeof value === 'string' && ['A', 'M', 'D', 'R', 'C', 'T', 'U'].includes(value);
}

function isSafeGitToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_FILTER_ITEM_LENGTH &&
    !value.startsWith('-') &&
    !/[\0\r\n]/u.test(value)
  );
}

function isGitRefName(value: unknown): value is string {
  if (!isSafeGitToken(value) || value === '@' || value.startsWith('/') || value.endsWith('/')) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) return false;
  }
  if (
    value.endsWith('.') ||
    value.includes('..') ||
    value.includes('//') ||
    value.includes('@{') ||
    value.includes('[') ||
    /[~^:?*\\]/u.test(value)
  ) {
    return false;
  }
  return value.split('/').every((component) => component && !component.startsWith('.') && !component.endsWith('.lock'));
}

function isGraphContinuation(value: unknown): value is GraphContinuationState {
  if (!isRecord(value) || !Array.isArray(value.lanes) || value.lanes.length > 4096) return false;
  const isCounter = (candidate: unknown): candidate is number =>
    typeof candidate === 'number' &&
    Number.isSafeInteger(candidate) &&
    candidate >= 0 &&
    candidate <= 1_000_000_000;
  if (!isCounter(value.nextLaneId) || !isCounter(value.nextColorIndex)) return false;
  const ids = new Set<number>();
  return value.lanes.every((lane) => {
    if (
      !isRecord(lane) ||
      !isCounter(lane.id) ||
      !isCounter(lane.colorIndex) ||
      !isHash(lane.target) ||
      ids.has(lane.id)
    ) {
      return false;
    }
    ids.add(lane.id);
    return true;
  });
}

function isRemoteBranchName(value: unknown): value is string {
  return (
    isGitRefName(value) &&
    !value.startsWith('refs/') &&
    !value.includes(':') &&
    !value.includes('..') &&
    !value.includes('@{')
  );
}

function isStashRef(value: unknown): value is string {
  return typeof value === 'string' && /^stash@\{\d+\}$/u.test(value);
}

function isGitOperationRequest(value: unknown): value is GitOperationRequest {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  switch (value.kind) {
    case 'checkout':
      return isSafeGitToken(value.ref);
    case 'createBranch':
      return isGitRefName(value.name) && isSafeGitToken(value.startPoint);
    case 'createTag':
      return isGitRefName(value.name) && isSafeGitToken(value.target);
    case 'deleteTag':
      return isGitRefName(value.name);
    case 'checkoutRemote':
      return isGitRefName(value.name) && isSafeGitToken(value.startPoint);
    case 'deleteRemoteBranch':
      return isSafeGitToken(value.remote) && isRemoteBranchName(value.branch);
    case 'fetch':
      return value.remote === undefined || isSafeGitToken(value.remote);
    case 'pull':
      return true;
    case 'push':
      return (
        (value.forceWithLease === undefined || typeof value.forceWithLease === 'boolean') &&
        (value.remote === undefined || isSafeGitToken(value.remote)) &&
        (value.targetRef === undefined || isSafeGitToken(value.targetRef))
      );
    case 'cherryPick':
    case 'revert':
      return isHash(value.hash);
    case 'merge':
    case 'rebase':
      return isSafeGitToken(value.ref);
    case 'reset':
      return isHash(value.hash) && ['soft', 'mixed', 'hard'].includes(String(value.mode));
    case 'renameBranch':
      return isGitRefName(value.oldName) && isGitRefName(value.newName);
    case 'deleteBranch':
      return isGitRefName(value.name) && typeof value.force === 'boolean';
    case 'createStash':
      return (
        typeof value.message === 'string' &&
        value.message.length <= 10_000 &&
        !value.message.includes('\0') &&
        typeof value.includeUntracked === 'boolean'
      );
    case 'applyStash':
    case 'popStash':
    case 'dropStash':
      return isStashRef(value.stash);
    case 'amendCommit':
      return (
        typeof value.message === 'string' &&
        value.message.trim().length > 0 &&
        value.message.length <= MAX_COMMIT_MESSAGE_LENGTH &&
        !value.message.includes('\0')
      );
    case 'dropCommits':
      return isCommitRange(value.hashes);
    case 'squashCommits':
      return (
        isCommitRange(value.hashes) &&
        typeof value.message === 'string' &&
        value.message.trim().length > 0 &&
        value.message.length <= MAX_COMMIT_MESSAGE_LENGTH &&
        !value.message.includes('\0')
      );
    default:
      return false;
  }
}

export function parseWebviewMessage(value: unknown): WebviewToExtensionMessage | undefined {
  if (!isRecord(value) || !hasBase(value)) return undefined;

  switch (value.type) {
    case 'ready':
      return { type: value.type, requestId: value.requestId };
    case 'selectRepository':
      return hasRepository(value)
        ? { type: value.type, requestId: value.requestId, repositoryId: value.repositoryId }
        : undefined;
    case 'selectCommit':
      return hasRepository(value) &&
        isHash(value.hash) &&
        (value.hashes === undefined || isCommitSelection(value.hashes, value.hash))
        ? {
            type: value.type,
            requestId: value.requestId,
            repositoryId: value.repositoryId,
            hash: value.hash,
            ...(Array.isArray(value.hashes) ? { hashes: value.hashes } : {}),
          }
        : undefined;
    case 'requestCommitMessages':
      return hasRepository(value) && isCommitRange(value.hashes)
        ? {
            type: value.type,
            requestId: value.requestId,
            repositoryId: value.repositoryId,
            hashes: value.hashes,
          }
        : undefined;
    case 'selectParent':
      return hasRepository(value) && isHash(value.hash) && isHash(value.parent)
        ? {
            type: value.type,
            requestId: value.requestId,
            repositoryId: value.repositoryId,
            hash: value.hash,
            parent: value.parent,
          }
        : undefined;
    case 'requestLogPage':
      return hasRepository(value) &&
        Number.isSafeInteger(value.skip) &&
        Number(value.skip) >= 0 &&
        Number(value.skip) <= MAX_LOG_OFFSET
        ? {
            type: value.type,
            requestId: value.requestId,
            repositoryId: value.repositoryId,
            skip: Number(value.skip),
          }
        : undefined;
    case 'requestHistoryPage':
      return hasRepository(value) &&
        Number.isSafeInteger(value.skip) &&
        Number(value.skip) >= 0 &&
        Number(value.skip) <= MAX_LOG_OFFSET
        ? {
            type: value.type,
            requestId: value.requestId,
            repositoryId: value.repositoryId,
            skip: Number(value.skip),
          }
        : undefined;
    case 'switchHistoryToFile':
      return hasRepository(value)
        ? {
            type: value.type,
            requestId: value.requestId,
            repositoryId: value.repositoryId,
          }
        : undefined;
    case 'openHistoryDiff':
      return hasRepository(value) &&
        isHash(value.hash) &&
        (value.parent === undefined || isHash(value.parent))
        ? {
            type: value.type,
            requestId: value.requestId,
            repositoryId: value.repositoryId,
            hash: value.hash,
            ...(typeof value.parent === 'string' ? { parent: value.parent } : {}),
          }
        : undefined;
    case 'closeHistory':
      return hasRepository(value)
        ? {
            type: value.type,
            requestId: value.requestId,
            repositoryId: value.repositoryId,
          }
        : undefined;
    case 'requestStashState':
      return hasRepository(value)
        ? { type: value.type, requestId: value.requestId, repositoryId: value.repositoryId }
        : undefined;
    case 'openStashComparison':
      return hasRepository(value) && isHash(value.hash)
        ? {
            type: value.type,
            requestId: value.requestId,
            repositoryId: value.repositoryId,
            hash: value.hash,
          }
        : undefined;
    case 'refresh':
      if (
        value.repositoryId !== undefined &&
        !(
          typeof value.repositoryId === 'string' &&
          value.repositoryId.length > 0 &&
          value.repositoryId.length <= MAX_IDENTIFIER_LENGTH &&
          !/[\0\r\n]/u.test(value.repositoryId)
        )
      ) {
        return undefined;
      }
      return {
        type: value.type,
        requestId: value.requestId,
        ...(typeof value.repositoryId === 'string' ? { repositoryId: value.repositoryId } : {}),
      };
    case 'showOutput':
      return { type: value.type, requestId: value.requestId };
    case 'copyToClipboard':
      return typeof value.text === 'string' && value.text.length <= 100_000
        ? { type: value.type, requestId: value.requestId, text: value.text }
        : undefined;
    case 'updateScrollAnchor':
      return hasRepository(value) &&
        typeof value.scrollTop === 'number' &&
        Number.isFinite(value.scrollTop) &&
        value.scrollTop >= 0 &&
        value.scrollTop <= 1_000_000_000 &&
        (value.logOffset === undefined ||
          (typeof value.logOffset === 'number' &&
            Number.isSafeInteger(value.logOffset) &&
            value.logOffset >= 0 &&
            value.logOffset <= MAX_LOG_OFFSET)) &&
        (value.graphContinuation === undefined || isGraphContinuation(value.graphContinuation))
        ? {
            type: value.type,
            requestId: value.requestId,
            repositoryId: value.repositoryId,
            scrollTop: value.scrollTop,
            ...(typeof value.logOffset === 'number' ? { logOffset: value.logOffset } : {}),
            ...(isGraphContinuation(value.graphContinuation)
              ? { graphContinuation: value.graphContinuation }
              : {}),
          }
        : undefined;
    case 'updateFilters':
      return hasRepository(value) && isFilters(value.filters)
        ? {
            type: value.type,
            requestId: value.requestId,
            repositoryId: value.repositoryId,
            filters: value.filters,
          }
        : undefined;
    case 'updateLayout':
      return isLayout(value.layout)
        ? { type: value.type, requestId: value.requestId, layout: value.layout }
        : undefined;
    case 'openDiff':
      if (
        !hasRepository(value) ||
        !isHash(value.hash) ||
        !isRepositoryPath(value.path) ||
        !isChangedFileStatus(value.status) ||
        (value.parent !== undefined && !isHash(value.parent)) ||
        (value.oldPath !== undefined && !isRepositoryPath(value.oldPath))
      ) {
        return undefined;
      }
      return {
        type: value.type,
        requestId: value.requestId,
        repositoryId: value.repositoryId,
        hash: value.hash,
        path: value.path,
        status: value.status,
        ...(typeof value.parent === 'string' ? { parent: value.parent } : {}),
        ...(typeof value.oldPath === 'string' ? { oldPath: value.oldPath } : {}),
      };
    case 'openFile':
      if (
        !hasRepository(value) ||
        !isHash(value.hash) ||
        !isRepositoryPath(value.path) ||
        !isChangedFileStatus(value.status) ||
        (value.parent !== undefined && !isHash(value.parent)) ||
        (value.oldPath !== undefined && !isRepositoryPath(value.oldPath)) ||
        (value.mode !== 'revision' && value.mode !== 'current')
      ) {
        return undefined;
      }
      return {
        type: value.type,
        requestId: value.requestId,
        repositoryId: value.repositoryId,
        hash: value.hash,
        path: value.path,
        status: value.status,
        mode: value.mode,
        ...(typeof value.parent === 'string' ? { parent: value.parent } : {}),
        ...(typeof value.oldPath === 'string' ? { oldPath: value.oldPath } : {}),
      };
    case 'openCommitComparison':
      return hasRepository(value) &&
        isHash(value.hash) &&
        (value.mode === 'parent' || value.mode === 'current') &&
        (value.parent === undefined || isHash(value.parent))
        ? {
            type: value.type,
            requestId: value.requestId,
            repositoryId: value.repositoryId,
            hash: value.hash,
            mode: value.mode,
            ...(typeof value.parent === 'string' ? { parent: value.parent } : {}),
          }
        : undefined;
    case 'runOperation':
      return hasRepository(value) && isGitOperationRequest(value.operation)
        ? {
            type: value.type,
            requestId: value.requestId,
            repositoryId: value.repositoryId,
            operation: value.operation,
          }
        : undefined;
    default:
      return undefined;
  }
}
