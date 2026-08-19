import { fileURLToPath } from 'node:url';
import { GitCommandError, type GitRunner } from '../git/GitRunner';
import type { GitService } from '../git/GitService';
import type { FileHistoryService } from '../git/FileHistoryService';
import { classifyGitError } from '../git/classifyGitError';
import {
  type GitOperationResult,
  type GitOperationService,
  type OperationConfirmation,
} from '../git/GitOperationService';
import { EMPTY_LOG_FILTERS } from '../git/logQuery';
import type { GraphContinuationState } from '../graph/layoutCommitGraph';
import type {
  ErrorRecoveryAction,
  ExtensionToWebviewMessage,
  LogFilters,
  PersistedWorkbenchState,
  WebviewToExtensionMessage,
  WorkbenchLayout,
} from '../protocol/messages';
import {
  discoverRepositories,
  ensureSupportedGit,
  inspectRepository,
} from '../repositories/discoverRepositories';
import type {
  ChangedFile,
  CommitSummary,
  EditorHistoryRequest,
  HistoryEntry,
  RefLabel,
  RepositorySummary,
} from '../shared/models';

export interface WorkbenchControllerOptions {
  workspaceRoots: readonly string[];
  gitService: GitService;
  fileHistoryService?: FileHistoryService;
  gitRunner: GitRunner;
  scanDepth: number;
  repositoryExcludes?: readonly string[];
  initialPageSize: number;
  pageSize: number;
  maxCachedCommits?: number;
  initialLayout: WorkbenchLayout;
  initialState?: PersistedWorkbenchState;
  postMessage(message: ExtensionToWebviewMessage): Promise<boolean>;
  persistLayout(layout: WorkbenchLayout): Promise<void>;
  persistState?(state: PersistedWorkbenchState): Promise<void>;
  showOutput?(): void;
  copyToClipboard?(text: string): Promise<void>;
  operationService?: Pick<GitOperationService, 'run'>;
  confirmOperation?(confirmation: OperationConfirmation): Promise<boolean>;
  withProgress?<T>(title: string, task: () => Promise<T>): Promise<T>;
  onRepositoriesChanged?(repositories: readonly RepositorySummary[]): void;
  openDiff?(
    repository: RepositorySummary,
    request: Extract<WebviewToExtensionMessage, { type: 'openDiff' }>,
  ): Promise<void>;
  openFile?(
    repository: RepositorySummary,
    request: Extract<WebviewToExtensionMessage, { type: 'openFile' }>,
  ): Promise<void>;
  openCommitComparison?(
    repository: RepositorySummary,
    request: { hash: string; parent: string },
    files: readonly ChangedFile[],
  ): Promise<void>;
}

function mergeSelectedCommitFiles(files: readonly ChangedFile[]): ChangedFile[] {
  const merged = new Map<string, ChangedFile>();
  for (const file of files) {
    const key = `${file.oldPath ?? ''}\0${file.path}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, file);
      continue;
    }
    const additions =
      existing.additions === undefined && file.additions === undefined
        ? undefined
        : (existing.additions ?? 0) + (file.additions ?? 0);
    const deletions =
      existing.deletions === undefined && file.deletions === undefined
        ? undefined
        : (existing.deletions ?? 0) + (file.deletions ?? 0);
    merged.set(key, {
      ...existing,
      ...(additions === undefined ? {} : { additions }),
      ...(deletions === undefined ? {} : { deletions }),
      binary: existing.binary || file.binary,
    });
  }
  return [...merged.values()];
}

export class WorkbenchController {
  private repositories = new Map<string, RepositorySummary>();
  private refs = new Map<string, RefLabel[]>();
  private filters = new Map<string, LogFilters>();
  private selectedCommits = new Map<string, string>();
  private selectedCommitRanges = new Map<string, string[]>();
  private scrollTops = new Map<string, number>();
  private logOffsets = new Map<string, number>();
  private graphContinuations = new Map<string, GraphContinuationState>();
  private selectedRepositoryId: string | undefined;
  private layout: WorkbenchLayout;
  private logAbortController: AbortController | undefined;
  private selectionAbortController: AbortController | undefined;
  private historyAbortController: AbortController | undefined;
  private activeHistory:
    | { request: EditorHistoryRequest; entries: HistoryEntry[]; refs: RefLabel[] }
    | undefined;
  private workspaceRoots: readonly string[];
  private automaticRequestSequence = 0;
  private repositorySelectionSequence = 0;
  private initializationSequence = 0;
  private logRequestSequence = 0;
  private readonly activeOperationGroups = new Map<string, number>();
  private readonly pendingOperationRefreshGroups = new Set<string>();
  private readonly dirtyOperationGroups = new Set<string>();
  private gitVersionChecked = false;

  constructor(private readonly options: WorkbenchControllerOptions) {
    this.layout = options.initialLayout;
    this.workspaceRoots = options.workspaceRoots;
    this.selectedRepositoryId = options.initialState?.selectedRepositoryId;
    for (const [repositoryId, state] of Object.entries(options.initialState?.repositories ?? {})) {
      this.filters.set(repositoryId, state.filters);
      if (state.selectedHash) {
        this.selectedCommits.set(repositoryId, state.selectedHash);
        this.selectedCommitRanges.set(repositoryId, [state.selectedHash]);
      }
      if (state.scrollTop !== undefined) this.scrollTops.set(repositoryId, state.scrollTop);
      if (state.logOffset !== undefined) this.logOffsets.set(repositoryId, state.logOffset);
      if (state.graphContinuation) {
        this.graphContinuations.set(repositoryId, state.graphContinuation);
      }
    }
  }

  async notifyRepositoryChanged(repositoryId: string): Promise<void> {
    const refreshesSelectedRepository = repositoryId === this.selectedRepositoryId;
    const refreshesActiveHistory = this.activeHistory?.request.repository.id === repositoryId;
    if ((!refreshesSelectedRepository && !refreshesActiveHistory) || !this.repositories.has(repositoryId)) {
      return;
    }
    const repository = this.requireRepository(repositoryId);
    const operationGroup = this.getOperationGroup(repository);
    if ((this.activeOperationGroups.get(operationGroup) ?? 0) > 0) {
      this.pendingOperationRefreshGroups.add(operationGroup);
      return;
    }
    this.automaticRequestSequence += 1;
    const requestId = `watch-${String(this.automaticRequestSequence)}`;
    if (refreshesActiveHistory) {
      const active = this.activeHistory;
      if (active) {
        active.request = { ...active.request, repository };
        active.entries = [];
        this.options.fileHistoryService?.invalidate(fileURLToPath(repository.rootUri));
        await this.loadEditorHistoryPage(`${requestId}-history`, 0, true);
      }
    }
    if (refreshesSelectedRepository) await this.refresh(requestId, repositoryId);
  }

  async updateWorkspaceRoots(workspaceRoots: readonly string[]): Promise<void> {
    this.workspaceRoots = workspaceRoots;
    this.automaticRequestSequence += 1;
    await this.initialize(`workspace-${String(this.automaticRequestSequence)}`);
  }

  async handleMessage(message: WebviewToExtensionMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
          await this.initialize(message.requestId);
          break;
        case 'selectRepository': {
          this.requireRepository(message.repositoryId);
          const logSequence = ++this.logRequestSequence;
          this.repositorySelectionSequence += 1;
          const selectionSequence = this.repositorySelectionSequence;
          this.selectionAbortController?.abort();
          this.logAbortController?.abort();
          this.selectedRepositoryId = message.repositoryId;
          await this.persistWorkbenchState();
          if (
            selectionSequence !== this.repositorySelectionSequence ||
            logSequence !== this.logRequestSequence ||
            this.selectedRepositoryId !== message.repositoryId
          ) {
            return;
          }
          await this.refreshDirtyOperationGroup(message.repositoryId);
          if (
            selectionSequence !== this.repositorySelectionSequence ||
            logSequence !== this.logRequestSequence ||
            this.selectedRepositoryId !== message.repositoryId
          ) {
            return;
          }
          await this.options.postMessage({
            type: 'repositoriesUpdated',
            requestId: message.requestId,
            repositories: [...this.repositories.values()],
            selectedRepositoryId: message.repositoryId,
          });
          this.options.gitService.invalidateLogCache?.(
            fileURLToPath(this.requireRepository(message.repositoryId).rootUri),
          );
          await this.loadRepository(
            message.repositoryId,
            message.requestId,
            true,
            this.logOffsets.get(message.repositoryId) ?? 0,
            logSequence,
          );
          break;
        }
        case 'selectCommit':
          this.requireSelectedRepository(message.repositoryId);
          this.selectedCommits.set(message.repositoryId, message.hash);
          this.selectedCommitRanges.set(
            message.repositoryId,
            message.hashes ?? [message.hash],
          );
          await this.persistWorkbenchState();
          await this.loadSelection(
            message.repositoryId,
            message.hash,
            message.requestId,
            undefined,
            message.hashes ?? [message.hash],
          );
          break;
        case 'requestCommitMessages': {
          this.requireSelectedRepository(message.repositoryId);
          const repository = this.requireRepository(message.repositoryId);
          const cwd = fileURLToPath(repository.rootUri);
          const messages: Array<{ hash: string; message: string }> = [];
          for (const hash of message.hashes) {
            messages.push({
              hash,
              message: await this.options.gitService.getCommitMessage(cwd, hash),
            });
          }
          await this.options.postMessage({
            type: 'commitMessagesLoaded',
            requestId: message.requestId,
            repositoryId: message.repositoryId,
            messages,
          });
          break;
        }
        case 'selectParent':
          this.requireSelectedRepository(message.repositoryId);
          this.selectedCommits.set(message.repositoryId, message.hash);
          await this.persistWorkbenchState();
          await this.loadSelection(
            message.repositoryId,
            message.hash,
            message.requestId,
            message.parent,
            this.selectedCommitRanges.get(message.repositoryId) ?? [message.hash],
          );
          break;
        case 'requestLogPage':
          this.requireSelectedRepository(message.repositoryId);
          await this.loadRepository(
            message.repositoryId,
            message.requestId,
            false,
            message.skip,
            ++this.logRequestSequence,
          );
          break;
        case 'requestHistoryPage':
          if (
            this.activeHistory?.request.repository.id !== message.repositoryId ||
            message.skip !== this.activeHistory.entries.length
          ) {
            break;
          }
          await this.loadEditorHistoryPage(message.requestId, message.skip, false);
          break;
        case 'switchHistoryToFile': {
          const active = this.activeHistory;
          if (
            !active ||
            active.request.repository.id !== message.repositoryId ||
            active.request.kind !== 'line'
          ) {
            break;
          }
          active.request = {
            kind: 'file',
            repository: active.request.repository,
            path: active.request.path,
          };
          active.entries = [];
          await this.loadEditorHistoryPage(message.requestId, 0, true);
          break;
        }
        case 'openHistoryDiff':
          await this.openEditorHistoryDiff(message);
          break;
        case 'closeHistory':
          if (this.activeHistory?.request.repository.id === message.repositoryId) {
            this.historyAbortController?.abort();
            this.activeHistory = undefined;
            await this.options.postMessage({
              type: 'historyClosed',
              requestId: message.requestId,
              repositoryId: message.repositoryId,
            });
          }
          break;
        case 'refresh':
          await this.refresh(message.requestId, message.repositoryId ?? this.selectedRepositoryId);
          break;
        case 'showOutput':
          this.options.showOutput?.();
          break;
        case 'copyToClipboard':
          if (!this.options.copyToClipboard) throw new Error('Clipboard integration is not available.');
          await this.options.copyToClipboard(message.text);
          await this.options.postMessage({
            type: 'clipboardCopied',
            requestId: message.requestId,
          });
          break;
        case 'updateScrollAnchor':
          this.requireSelectedRepository(message.repositoryId);
          this.scrollTops.set(message.repositoryId, message.scrollTop);
          if (message.logOffset !== undefined) {
            this.logOffsets.set(message.repositoryId, message.logOffset);
          }
          if (message.graphContinuation) {
            this.graphContinuations.set(message.repositoryId, message.graphContinuation);
          } else if (message.logOffset === 0) {
            this.graphContinuations.delete(message.repositoryId);
          }
          await this.persistWorkbenchState();
          break;
        case 'updateLayout':
          this.layout = message.layout;
          await this.options.persistLayout(message.layout);
          break;
        case 'openDiff':
          if (!this.options.openDiff) throw new Error('Diff integration is not available.');
          this.requireSelectedRepository(message.repositoryId);
          await this.options.openDiff(this.requireRepository(message.repositoryId), message);
          break;
        case 'openFile':
          if (!this.options.openFile) throw new Error('File integration is not available.');
          this.requireSelectedRepository(message.repositoryId);
          await this.options.openFile(this.requireRepository(message.repositoryId), message);
          break;
        case 'openCommitComparison':
          await this.openCommitComparison(message);
          break;
        case 'updateFilters': {
          this.requireSelectedRepository(message.repositoryId);
          const logSequence = ++this.logRequestSequence;
          this.filters.set(message.repositoryId, message.filters);
          this.scrollTops.set(message.repositoryId, 0);
          this.logOffsets.set(message.repositoryId, 0);
          this.graphContinuations.delete(message.repositoryId);
          await this.persistWorkbenchState();
          if (logSequence !== this.logRequestSequence) break;
          await this.loadRepository(message.repositoryId, message.requestId, true, 0, logSequence);
          break;
        }
        case 'runOperation':
          await this.runOperation(message);
          break;
      }
    } catch (error) {
      const repositoryId =
        'repositoryId' in message
          ? message.repositoryId
          : message.type === 'refresh'
            ? this.selectedRepositoryId
            : undefined;
      if (error instanceof GitCommandError) {
        if (error.cancelled) return;
        const classified = classifyGitError(error);
        const recovery: ErrorRecoveryAction | undefined =
          message.type === 'runOperation' &&
          message.operation.kind === 'deleteBranch' &&
          !message.operation.force &&
          /\bbranch\b[^\r\n]*\bis not fully merged\b/iu.test(classified.detail)
            ? { kind: 'forceDeleteBranch', branch: message.operation.name }
            : undefined;
        await this.postError(
          message.requestId,
          classified.message,
          classified.detail,
          repositoryId,
          recovery,
        );
        return;
      }
      await this.postError(
        message.requestId,
        error instanceof Error ? error.message : 'An unknown Git Log error occurred.',
        error instanceof Error && error.stack ? error.stack : undefined,
        repositoryId,
      );
    }
  }

  dispose(): void {
    this.logAbortController?.abort();
    this.selectionAbortController?.abort();
    this.historyAbortController?.abort();
  }

  async openEditorHistory(request: EditorHistoryRequest): Promise<void> {
    if (!request.path || request.path.includes('\0')) throw new Error('Invalid history path.');
    this.repositories.set(request.repository.id, request.repository);
    this.options.onRepositoriesChanged?.([...this.repositories.values()]);
    this.activeHistory = { request, entries: [], refs: [] };
    const requestId = `editor-history-${String(++this.automaticRequestSequence)}`;
    try {
      await this.loadEditorHistoryPage(requestId, 0, true);
    } catch (error) {
      if (error instanceof GitCommandError) {
        if (error.cancelled) return;
        const classified = classifyGitError(error);
        if (request.kind === 'line') {
          await this.postLineHistoryErrorState(requestId, request, classified.message);
          return;
        }
        await this.postError(
          requestId,
          classified.message,
          classified.detail,
          request.repository.id,
        );
        return;
      }
      if (request.kind === 'line') {
        await this.postLineHistoryErrorState(
          requestId,
          request,
          error instanceof Error ? error.message : 'Unable to load line history.',
        );
        return;
      }
      await this.postError(
        requestId,
        error instanceof Error ? error.message : 'Unable to open editor history.',
        error instanceof Error ? error.stack : undefined,
        request.repository.id,
      );
    }
  }

  private async postLineHistoryErrorState(
    requestId: string,
    request: EditorHistoryRequest,
    notice: string,
  ): Promise<void> {
    const active = this.activeHistory;
    if (!active || active.request !== request) return;
    active.entries = [];
    await this.options.postMessage({
      type: 'historyOpened',
      requestId,
      repositoryId: request.repository.id,
      kind: 'line',
      path: request.path,
      ...(request.startLine !== undefined ? { startLine: request.startLine } : {}),
      ...(request.endLine !== undefined ? { endLine: request.endLine } : {}),
      entries: [],
      replace: true,
      hasMore: false,
      notice,
    });
  }

  private async loadEditorHistoryPage(
    requestId: string,
    skip: number,
    replace: boolean,
  ): Promise<void> {
    const active = this.activeHistory;
    if (!active) throw new Error('No editor history is active.');
    if (!this.options.fileHistoryService) throw new Error('File history is not available.');
    this.historyAbortController?.abort();
    const abortController = new AbortController();
    this.historyAbortController = abortController;
    const repository = active.request.repository;
    const cwd = fileURLToPath(repository.rootUri);
    if (!repository.head) {
      if (abortController.signal.aborted || this.activeHistory !== active) return;
      active.refs = [];
      active.entries = [];
      await this.options.postMessage({
        type: 'historyOpened',
        requestId,
        repositoryId: repository.id,
        kind: active.request.kind,
        path: active.request.path,
        ...(active.request.startLine !== undefined
          ? { startLine: active.request.startLine }
          : {}),
        ...(active.request.endLine !== undefined ? { endLine: active.request.endLine } : {}),
        entries: [],
        replace: true,
        hasMore: false,
        notice: 'This repository has no commits yet.',
      });
      return;
    }
    const refs = replace
      ? await this.options.gitService.getRefs(cwd, repository.currentBranch, abortController.signal)
      : active.refs;
    let entries: HistoryEntry[];
    let hasMore: boolean;
    let notice: string | undefined;
    if (active.request.kind === 'line') {
      if (!replace || skip > 0) return;
      const startLine = active.request.startLine;
      const endLine = active.request.endLine;
      if (startLine === undefined || endLine === undefined) {
        throw new Error('Line history requires a valid line range.');
      }
      const mapping = await this.options.fileHistoryService.resolveHeadLineRange(
        cwd,
        active.request.path,
        startLine,
        endLine,
        abortController.signal,
        active.request.workingContent,
      );
      if (abortController.signal.aborted || this.activeHistory !== active) return;
      if (mapping.status === 'file-not-in-head') {
        entries = [];
        notice = mapping.hasHistory
          ? 'This file does not exist in HEAD. Use File History instead.'
          : startLine === endLine
            ? 'This line has no committed history yet.'
            : 'These lines have no committed history yet.';
      } else if (mapping.status === 'uncommitted-only') {
        entries = [];
        notice =
          startLine === endLine
            ? 'This line has no committed history yet.'
            : 'These lines have no committed history yet.';
      } else if (mapping.status === 'discontinuous') {
        entries = [];
        notice =
          'The selected lines do not map to a continuous committed range. Select a smaller range.';
      } else {
        const result = await this.options.fileHistoryService.getLineHistory(
          cwd,
          active.request.path,
          mapping.startLine,
          mapping.endLine,
          refs,
          abortController.signal,
        );
        entries = result.entries.map(({ linePatch, ...entry }) => {
          void linePatch;
          return entry;
        });
        const notices: string[] = [];
        if (mapping.partiallyUncommitted) {
          notices.push(
            'Part of the selection has not been committed; showing history for the committed lines.',
          );
        }
        if (result.truncated) notices.push('Showing the first 500 matching commits.');
        notice = notices.length ? notices.join(' ') : undefined;
      }
      hasMore = false;
    } else {
      const limit = replace ? this.options.initialPageSize : this.options.pageSize;
      const queryLimit = Math.min(5000, limit + 1);
      entries = await this.options.fileHistoryService.getFileHistory(
        cwd,
        active.request.path,
        refs,
        { limit: queryLimit, skip, signal: abortController.signal },
      );
      hasMore = entries.length > limit || (queryLimit === limit && entries.length === limit);
      entries = entries.slice(0, limit);
    }
    if (abortController.signal.aborted || this.activeHistory !== active) return;
    active.refs = refs;
    active.entries = replace ? entries : [...active.entries, ...entries];
    await this.options.postMessage({
      type: 'historyOpened',
      requestId,
      repositoryId: repository.id,
      kind: active.request.kind,
      path: active.request.path,
      ...(active.request.startLine !== undefined ? { startLine: active.request.startLine } : {}),
      ...(active.request.endLine !== undefined ? { endLine: active.request.endLine } : {}),
      entries,
      replace,
      hasMore,
      ...(notice ? { notice } : {}),
    });
  }

  private async openEditorHistoryDiff(
    message: Extract<WebviewToExtensionMessage, { type: 'openHistoryDiff' }>,
  ): Promise<void> {
    const active = this.activeHistory;
    if (!active || active.request.repository.id !== message.repositoryId) {
      throw new Error('Editor history is no longer active.');
    }
    if (!this.options.openDiff) throw new Error('Diff integration is not available.');
    const entry = active.entries.find((candidate) => candidate.hash === message.hash);
    if (!entry) throw new Error('Unknown history entry.');
    if (entry.binary) {
      throw new Error('Binary files cannot be opened in the text diff editor.');
    }
    if (message.parent && !entry.parents.includes(message.parent)) {
      throw new Error('The selected parent does not belong to this history commit.');
    }
    const parent = message.parent ?? entry.parents[0];
    const files = await this.options.gitService.getChangedFiles(
      fileURLToPath(active.request.repository.rootUri),
      entry.hash,
      parent,
    );
    const historyPaths = new Set(
      [entry.path, entry.oldPath].filter((path): path is string => path !== undefined),
    );
    const file = files.find(
      (candidate) =>
        historyPaths.has(candidate.path) ||
        (candidate.oldPath !== undefined && historyPaths.has(candidate.oldPath)),
    );
    if (!file) throw new Error('The selected commit does not contain the history file.');
    await this.options.openDiff(active.request.repository, {
      type: 'openDiff',
      requestId: message.requestId,
      repositoryId: message.repositoryId,
      hash: entry.hash,
      ...(parent ? { parent } : {}),
      path: file.path,
      ...(file.oldPath ? { oldPath: file.oldPath } : {}),
      status: file.status,
      ...(entry.newStartLine !== undefined
        ? { revealLine: Math.max(1, entry.newStartLine) }
        : entry.oldStartLine !== undefined
          ? { revealLine: Math.max(1, entry.oldStartLine) }
          : {}),
    });
  }

  private async initialize(requestId: string): Promise<void> {
    const initializationSequence = ++this.initializationSequence;
    const workspaceRoots = this.workspaceRoots;
    this.options.gitService.invalidateLogCache?.();
    await this.options.postMessage({ type: 'loading', requestId, scope: 'repositories' });
    if (!this.gitVersionChecked) {
      await ensureSupportedGit(this.options.gitRunner, workspaceRoots[0] ?? process.cwd());
      this.gitVersionChecked = true;
    }
    const repositories = await discoverRepositories(
      workspaceRoots,
      this.options.gitRunner,
      {
        scanDepth: this.options.scanDepth,
        excludePatterns: this.options.repositoryExcludes ?? [],
      },
    );
    if (initializationSequence !== this.initializationSequence) return;
    const logSequence = ++this.logRequestSequence;

    this.repositories = new Map(repositories.map((repository) => [repository.id, repository]));
    this.options.onRepositoriesChanged?.(repositories);
    const unavailableHistory = this.activeHistory;
    if (
      unavailableHistory &&
      !this.repositories.has(unavailableHistory.request.repository.id)
    ) {
      this.historyAbortController?.abort();
      this.activeHistory = undefined;
      await this.options.postMessage({
        type: 'historyClosed',
        requestId,
        repositoryId: unavailableHistory.request.repository.id,
        reason: 'The repository for this editor history is no longer available.',
      });
    }
    this.selectedRepositoryId =
      this.selectedRepositoryId && this.repositories.has(this.selectedRepositoryId)
        ? this.selectedRepositoryId
        : repositories[0]?.id;
    await this.persistWorkbenchState();
    if (initializationSequence !== this.initializationSequence) return;

    await this.options.postMessage({
      type: 'initialize',
      requestId,
      repositories,
      ...(this.selectedRepositoryId ? { selectedRepositoryId: this.selectedRepositoryId } : {}),
      pageSize: this.options.pageSize,
      maxCachedCommits: this.options.maxCachedCommits ?? 5000,
      layout: this.layout,
    });

    if (this.selectedRepositoryId) {
      await this.loadRepository(
        this.selectedRepositoryId,
        requestId,
        true,
        this.logOffsets.get(this.selectedRepositoryId) ?? 0,
        logSequence,
      );
    }
  }

  private async refresh(requestId: string, repositoryId?: string): Promise<void> {
    if (!repositoryId) {
      await this.initialize(requestId);
      return;
    }
    const logSequence = ++this.logRequestSequence;
    const current = this.requireRepository(repositoryId);
    this.options.gitService.invalidateLogCache?.(fileURLToPath(current.rootUri));
    const inspected = await inspectRepository(fileURLToPath(current.rootUri), this.options.gitRunner);
    if (logSequence !== this.logRequestSequence) return;
    const effectiveRepositoryId = inspected?.id ?? repositoryId;
    const headChanged = inspected !== undefined && inspected.head !== current.head;
    if (inspected) {
      if (inspected.id !== repositoryId) this.repositories.delete(repositoryId);
      this.repositories.set(inspected.id, inspected);
      this.options.onRepositoriesChanged?.([...this.repositories.values()]);
      if (this.selectedRepositoryId === repositoryId) {
        this.selectedRepositoryId = effectiveRepositoryId;
      }
      if (headChanged) {
        this.selectionAbortController?.abort();
        this.scrollTops.set(effectiveRepositoryId, 0);
        this.logOffsets.set(effectiveRepositoryId, 0);
        this.graphContinuations.delete(effectiveRepositoryId);
        if (inspected.head) {
          this.selectedCommits.set(effectiveRepositoryId, inspected.head);
          this.selectedCommitRanges.set(effectiveRepositoryId, [inspected.head]);
        } else {
          this.selectedCommits.delete(effectiveRepositoryId);
          this.selectedCommitRanges.delete(effectiveRepositoryId);
        }
        await this.persistWorkbenchState();
      }
      await this.options.postMessage({
        type: 'repositoriesUpdated',
        requestId,
        repositories: [...this.repositories.values()],
        ...(this.selectedRepositoryId ? { selectedRepositoryId: this.selectedRepositoryId } : {}),
      });
    }
    if (logSequence !== this.logRequestSequence) return;
    if (this.selectedRepositoryId !== effectiveRepositoryId) return;
    await this.loadRepository(
      effectiveRepositoryId,
      requestId,
      true,
      headChanged ? 0 : (this.logOffsets.get(effectiveRepositoryId) ?? 0),
      logSequence,
    );
  }

  private async loadRepository(
    repositoryId: string,
    requestId: string,
    replace: boolean,
    skip: number,
    logSequence: number,
  ): Promise<void> {
    if (logSequence !== this.logRequestSequence) return;
    const repository = this.requireRepository(repositoryId);
    this.logAbortController?.abort();
    const abortController = new AbortController();
    this.logAbortController = abortController;

    await this.options.postMessage({ type: 'loading', requestId, repositoryId, scope: 'log' });
    const cwd = fileURLToPath(repository.rootUri);
    const refs = await this.options.gitService.getRefs(
      cwd,
      repository.currentBranch,
      abortController.signal,
    );
    if (logSequence !== this.logRequestSequence) return;
    const storedFilters = this.filters.get(repositoryId) ?? EMPTY_LOG_FILTERS;
    const knownRefs = new Set(refs.map((ref) => ref.fullName));
    const validBranches = storedFilters.branches.filter((branch) => knownRefs.has(branch));
    const filters =
      validBranches.length === storedFilters.branches.length
        ? storedFilters
        : { ...storedFilters, branches: validBranches };
    if (filters !== storedFilters) {
      this.filters.set(repositoryId, filters);
      await this.persistWorkbenchState();
    }
    const scrollTop = this.scrollTops.get(repositoryId) ?? 0;
    const restoredPageSize = Math.ceil(scrollTop / 28) + this.options.initialPageSize;
    const limit = replace
      ? Math.min(
          this.options.maxCachedCommits ?? 5000,
          Math.max(this.options.initialPageSize, restoredPageSize),
        )
      : Math.min(this.options.pageSize, this.options.maxCachedCommits ?? 5000);
    const commits: CommitSummary[] = [];
    while (commits.length < limit) {
      const batchLimit = Math.min(5000, limit - commits.length);
      const batch = await this.options.gitService.getLog(cwd, {
        limit: batchLimit,
        skip: skip + commits.length,
        refs,
        filters,
        signal: abortController.signal,
      });
      if (logSequence !== this.logRequestSequence) return;
      commits.push(...batch);
      if (batch.length < batchLimit) break;
    }
    if (abortController.signal.aborted) return;
    if (logSequence !== this.logRequestSequence) return;
    if (repositoryId !== this.selectedRepositoryId) return;

    this.refs.set(repositoryId, refs);
    if (replace) this.logOffsets.set(repositoryId, skip);
    const selectedHash = this.selectedCommits.get(repositoryId);
    const restoredSelectedHash =
      selectedHash && commits.some((commit) => commit.hash === selectedHash)
        ? selectedHash
        : undefined;
    const rememberedSelection = this.selectedCommitRanges.get(repositoryId) ?? [];
    const restoredSelectedHashes =
      restoredSelectedHash &&
      rememberedSelection.length > 0 &&
      rememberedSelection.every((hash) => commits.some((commit) => commit.hash === hash))
        ? rememberedSelection
        : restoredSelectedHash
          ? [restoredSelectedHash]
          : [];
    if (restoredSelectedHash) {
      this.selectedCommitRanges.set(repositoryId, [...restoredSelectedHashes]);
    }
    const restoredGraphContinuation = this.graphContinuations.get(repositoryId);
    await this.options.postMessage({
      type: 'repositoryData',
      requestId,
      repositoryId,
      refs,
      commits,
      filters,
      ...(restoredSelectedHash ? { selectedHash: restoredSelectedHash } : {}),
      ...(replace
        ? {
            scrollTop,
            startLogOffset: skip,
            ...(restoredGraphContinuation
              ? { graphContinuation: restoredGraphContinuation }
              : {}),
          }
        : {}),
      replace,
      hasMore: commits.length === limit,
    });

    if (replace && restoredSelectedHash && !abortController.signal.aborted) {
      await this.loadSelection(
        repositoryId,
        restoredSelectedHash,
        requestId,
        undefined,
        restoredSelectedHashes,
      );
    }
  }

  private async loadSelection(
    repositoryId: string,
    hash: string,
    requestId: string,
    selectedParent?: string,
    selectedHashes: readonly string[] = [hash],
  ): Promise<void> {
    const repository = this.requireRepository(repositoryId);
    this.selectionAbortController?.abort();
    const abortController = new AbortController();
    this.selectionAbortController = abortController;

    await this.options.postMessage({ type: 'loading', requestId, repositoryId, scope: 'selection' });
    const details = await this.options.gitService.getCommitDetails(
      fileURLToPath(repository.rootUri),
      hash,
      this.refs.get(repositoryId) ?? [],
      abortController.signal,
    );
    const cwd = fileURLToPath(repository.rootUri);
    const selectedFiles: ChangedFile[] = [];
    for (const selectedHash of selectedHashes) {
      if (abortController.signal.aborted) return;
      const selectedDetails =
        selectedHash === hash
          ? details
          : await this.options.gitService.getCommitDetails(
              cwd,
              selectedHash,
              this.refs.get(repositoryId) ?? [],
              abortController.signal,
            );
      const parent = selectedHash === hash
        ? selectedParent ?? selectedDetails.parents[0]
        : selectedDetails.parents[0];
      const files = await this.options.gitService.getChangedFiles(
        cwd,
        selectedHash,
        parent,
        abortController.signal,
      );
      selectedFiles.push(
        ...files.map((file) => ({
          ...file,
          commitHash: selectedHash,
          ...(parent ? { parentHash: parent } : {}),
        })),
      );
    }
    const files = mergeSelectedCommitFiles(selectedFiles);
    if (abortController.signal.aborted) return;
    if (
      repositoryId !== this.selectedRepositoryId ||
      this.selectedCommits.get(repositoryId) !== hash ||
      (this.selectedCommitRanges.get(repositoryId) ?? [hash]).join('\0') !==
        selectedHashes.join('\0')
    ) {
      return;
    }

    await this.options.postMessage({
      type: 'selectionDetailsLoaded',
      requestId,
      repositoryId,
      details,
      files,
      ...((selectedParent ?? details.parents[0])
        ? { selectedParent: selectedParent ?? details.parents[0] }
        : {}),
    });
  }

  private async runOperation(
    message: Extract<WebviewToExtensionMessage, { type: 'runOperation' }>,
  ): Promise<void> {
    if (!this.options.operationService) throw new Error('Git operations are not available.');
    this.requireSelectedRepository(message.repositoryId);
    const repository = this.requireRepository(message.repositoryId);
    const operation = message.operation;
    if (operation.kind === 'deleteRemoteBranch') {
      const fullName = `refs/remotes/${operation.remote}/${operation.branch}`;
      const knownRemoteBranch = (this.refs.get(message.repositoryId) ?? []).some(
        (ref) =>
          ref.kind === 'remote' &&
          ref.remote === operation.remote &&
          ref.fullName === fullName,
      );
      if (!knownRemoteBranch) {
        throw new Error(`Remote branch “${operation.remote}/${operation.branch}” is not in the current ref snapshot.`);
      }
    }

    await this.options.postMessage({
      type: 'loading',
      requestId: message.requestId,
      repositoryId: message.repositoryId,
      scope: 'operation',
    });
    const execute = (): Promise<GitOperationResult> =>
      this.options.operationService?.run(repository, operation, {
        confirm: async (confirmation) => {
          if (!this.options.confirmOperation) {
            throw new Error('A destructive Git operation requires confirmation.');
          }
          return this.options.confirmOperation(confirmation);
        },
      }) ??
      Promise.reject(new Error('Git operations are not available.'));

    const operationGroup = this.getOperationGroup(repository);
    this.activeOperationGroups.set(
      operationGroup,
      (this.activeOperationGroups.get(operationGroup) ?? 0) + 1,
    );
    let result: GitOperationResult | undefined;
    let operationError: unknown;
    try {
      result = this.options.withProgress
        ? await this.options.withProgress(`Git: ${operation.kind}`, execute)
        : await execute();
    } catch (error) {
      operationError = error;
    } finally {
      const deletedRef =
        result && !result.cancelled
          ? operation.kind === 'deleteBranch'
            ? `refs/heads/${operation.name}`
            : operation.kind === 'deleteRemoteBranch'
              ? `refs/remotes/${operation.remote}/${operation.branch}`
              : operation.kind === 'deleteTag'
                ? `refs/tags/${operation.name}`
                : undefined
          : undefined;
      if (deletedRef) {
        let filtersChanged = false;
        for (const candidate of this.repositories.values()) {
          if (this.getOperationGroup(candidate) !== operationGroup) continue;
          const filters = this.filters.get(candidate.id);
          if (!filters?.branches.includes(deletedRef)) continue;
          this.filters.set(candidate.id, {
            ...filters,
            branches: filters.branches.filter((branch) => branch !== deletedRef),
          });
          filtersChanged = true;
        }
        if (filtersChanged) await this.persistWorkbenchState();
      }
      if (!result?.cancelled) this.pendingOperationRefreshGroups.add(operationGroup);
      const remaining = Math.max(0, (this.activeOperationGroups.get(operationGroup) ?? 1) - 1);
      if (remaining > 0) {
        this.activeOperationGroups.set(operationGroup, remaining);
      } else {
        this.activeOperationGroups.delete(operationGroup);
        if (this.pendingOperationRefreshGroups.delete(operationGroup)) {
          this.dirtyOperationGroups.add(operationGroup);
          const selectedRepository = this.selectedRepositoryId
            ? this.repositories.get(this.selectedRepositoryId)
            : undefined;
          if (selectedRepository && this.getOperationGroup(selectedRepository) === operationGroup) {
            await this.refresh(`${message.requestId}-refresh`, selectedRepository.id);
            const repositoriesInGroup = [...this.repositories.values()].filter(
              (candidate) => this.getOperationGroup(candidate) === operationGroup,
            );
            if (repositoriesInGroup.length === 1) this.dirtyOperationGroups.delete(operationGroup);
          }
          const activeHistory = this.activeHistory;
          if (
            activeHistory &&
            this.getOperationGroup(activeHistory.request.repository) === operationGroup
          ) {
            const refreshedRepository = this.repositories.get(
              activeHistory.request.repository.id,
            );
            if (refreshedRepository) {
              activeHistory.request = {
                ...activeHistory.request,
                repository: refreshedRepository,
              };
            }
            activeHistory.entries = [];
            this.options.fileHistoryService?.invalidate(
              fileURLToPath(activeHistory.request.repository.rootUri),
            );
            await this.loadEditorHistoryPage(`${message.requestId}-history-refresh`, 0, true);
          }
        }
      }
    }

    if (operationError) throw operationError;
    if (!result) throw new Error('Git operation completed without a result.');
    if (result.cancelled) {
      await this.options.postMessage({
        type: 'operationCancelled',
        requestId: message.requestId,
        repositoryId: repository.id,
      });
      return;
    }
    await this.options.postMessage({
      type: 'operationCompleted',
      requestId: message.requestId,
      repositoryId: repository.id,
      message: result.message,
    });
  }

  private async openCommitComparison(
    message: Extract<WebviewToExtensionMessage, { type: 'openCommitComparison' }>,
  ): Promise<void> {
    if (!this.options.openCommitComparison) throw new Error('Commit comparison is not available.');
    this.requireSelectedRepository(message.repositoryId);
    const repository = this.requireRepository(message.repositoryId);
    const cwd = fileURLToPath(repository.rootUri);
    let leftHash: string | undefined;
    let rightHash: string;
    if (message.mode === 'current') {
      leftHash = message.hash;
      rightHash = repository.head ?? '';
      if (!rightHash) throw new Error('The current repository has no HEAD commit.');
    } else {
      rightHash = message.hash;
      leftHash =
        message.parent ??
        (await this.options.gitService.getCommitDetails(
          cwd,
          message.hash,
          this.refs.get(message.repositoryId) ?? [],
        )).parents[0];
      if (!leftHash) throw new Error('Root commits do not have a parent to compare.');
    }
    const files = await this.options.gitService.getChangedFiles(cwd, rightHash, leftHash);
    await this.options.openCommitComparison(repository, { hash: rightHash, parent: leftHash }, files);
  }

  private requireRepository(repositoryId: string): RepositorySummary {
    const repository = this.repositories.get(repositoryId);
    if (!repository) throw new Error(`Unknown repository: ${repositoryId}`);
    return repository;
  }

  private getOperationGroup(repository: RepositorySummary): string {
    const uri = repository.commonGitDirUri ?? repository.gitDirUri;
    return process.platform === 'win32' ? uri.toLowerCase() : uri;
  }

  private async refreshDirtyOperationGroup(repositoryId: string): Promise<void> {
    const repository = this.requireRepository(repositoryId);
    const operationGroup = this.getOperationGroup(repository);
    if (!this.dirtyOperationGroups.has(operationGroup)) return;

    const repositoriesInGroup = [...this.repositories.values()].filter(
      (candidate) => this.getOperationGroup(candidate) === operationGroup,
    );
    for (const candidate of repositoriesInGroup) {
      const inspected = await inspectRepository(
        fileURLToPath(candidate.rootUri),
        this.options.gitRunner,
      );
      if (!inspected) continue;
      if (inspected.id !== candidate.id) this.repositories.delete(candidate.id);
      this.repositories.set(inspected.id, inspected);
    }
    this.dirtyOperationGroups.delete(operationGroup);
    this.options.onRepositoriesChanged?.([...this.repositories.values()]);
  }

  private requireSelectedRepository(repositoryId: string): void {
    if (repositoryId !== this.selectedRepositoryId) {
      throw new Error(`Repository is no longer selected: ${repositoryId}`);
    }
  }

  private async persistWorkbenchState(): Promise<void> {
    if (!this.options.persistState) return;
    const repositories: PersistedWorkbenchState['repositories'] = {};
    for (const repositoryId of [...this.repositories.keys()].slice(0, 50)) {
      const selectedHash = this.selectedCommits.get(repositoryId);
      const scrollTop = this.scrollTops.get(repositoryId);
      const logOffset = this.logOffsets.get(repositoryId);
      const graphContinuation = this.graphContinuations.get(repositoryId);
      repositories[repositoryId] = {
        filters: this.filters.get(repositoryId) ?? EMPTY_LOG_FILTERS,
        ...(selectedHash ? { selectedHash } : {}),
        ...(scrollTop !== undefined ? { scrollTop } : {}),
        ...(logOffset !== undefined ? { logOffset } : {}),
        ...(graphContinuation ? { graphContinuation } : {}),
      };
    }
    await this.options.persistState({
      ...(this.selectedRepositoryId ? { selectedRepositoryId: this.selectedRepositoryId } : {}),
      repositories,
    });
  }

  private async postError(
    requestId: string,
    message: string,
    detail?: string,
    repositoryId?: string,
    recovery?: ErrorRecoveryAction,
  ): Promise<void> {
    await this.options.postMessage({
      type: 'error',
      requestId,
      ...(repositoryId ? { repositoryId } : {}),
      message,
      ...(detail ? { detail } : {}),
      ...(recovery ? { recovery } : {}),
    });
  }
}
