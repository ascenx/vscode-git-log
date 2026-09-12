import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitCommandError, type GitRunner } from './GitRunner';
import { buildLogArguments, EMPTY_LOG_FILTERS } from './logQuery';
import { parseCommitDetails } from './parsers/parseCommitDetails';
import { applyNumstat, parseNameStatus } from './parsers/parseChangedFiles';
import { parseLog, parseSearchableLog } from './parsers/parseLog';
import { parseRefs } from './parsers/parseRefs';
import type { LogFilters } from '../protocol/messages';
import type {
  ChangedFile,
  CommitDetails,
  CommitSummary,
  RefLabel,
  StashEntry,
} from '../shared/models';

const REF_FORMAT = '%(refname)%00%(objectname)%00%(*objectname)%00%(upstream)%00%(upstream:track)%00';
const LOG_FORMAT = '%x1e%H%x00%P%x00%an%x00%ae%x00%at%x00%ct%x00%s%x00';
const SEARCH_LOG_FORMAT = `${LOG_FORMAT}%B%x00`;
const DETAILS_FORMAT = '%H%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct%x00%B%x00%G?';
const COMMIT_HASH_PATTERN = /^[0-9a-f]{4,64}$/iu;
const TEXT_SCAN_PAGE_SIZE = 5000;
const TEXT_SCAN_MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const MAX_RETAINED_TEXT_MATCHES = 10_000;
const MAX_TEXT_SEARCH_CACHES = 2;
// Retain a small internal topology sample for projection, but never return these rows.
const MAX_GRAPH_CONTEXT_ROWS_PER_MATCH = 3;
const MAX_PROJECTED_GRAPH_PARENTS = 4;
const FULL_FILE_DIFF_CONTEXT_LINES = 2_147_483_647;
const WEBVIEW_FILE_PATCH_MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const WEBVIEW_FILE_PATCH_MAX_LINES = 50_000;

export interface LogQuery {
  limit: number;
  skip: number;
  refs: readonly RefLabel[];
  /** Maximum matching and structural rows returned for a filtered graph page. */
  maxGraphRows?: number;
  signal?: AbortSignal;
  filters?: LogFilters;
}

function indexRefsByTarget(refs: readonly RefLabel[]): ReadonlyMap<string, readonly RefLabel[]> {
  const indexed = new Map<string, RefLabel[]>();
  for (const ref of refs) {
    const target = ref.target;
    const matching = indexed.get(target) ?? [];
    matching.push(ref);
    indexed.set(target, matching);
  }
  return indexed;
}

function attachRefs<T extends CommitSummary>(
  commit: T,
  refsByTarget: ReadonlyMap<string, readonly RefLabel[]>,
): T {
  return { ...commit, refs: refsByTarget.get(commit.hash) ?? [] };
}

function limitGraphParentsToVisibleCommits(commits: readonly CommitSummary[]): CommitSummary[] {
  const visibleHashes = new Set(commits.map((commit) => commit.hash));
  return commits.map((commit) => ({
    ...commit,
    graphParents: commit.parents.filter((parent) => visibleHashes.has(parent)),
  }));
}

function filtersMayHideAncestors(filters: LogFilters): boolean {
  return Boolean(
    filters.authors.length ||
      filters.paths.length ||
      filters.dateFrom !== undefined ||
      filters.dateTo !== undefined
  );
}

function validatePage(query: LogQuery): void {
  if (!Number.isInteger(query.limit) || query.limit <= 0 || query.limit > 5000) {
    throw new Error(`Invalid log page limit: ${String(query.limit)}`);
  }
  if (!Number.isSafeInteger(query.skip) || query.skip < 0) {
    throw new Error(`Invalid log page offset: ${String(query.skip)}`);
  }
  if (
    query.maxGraphRows !== undefined &&
    (!Number.isInteger(query.maxGraphRows) ||
      query.maxGraphRows <= 0 ||
      query.maxGraphRows > 50_000)
  ) {
    throw new Error(`Invalid graph row limit: ${String(query.maxGraphRows)}`);
  }
}

function validateRepositoryPath(path: string): void {
  if (!path || path.includes('\0')) throw new Error('Invalid repository path.');
}

function webviewFilePatchText(patch: Buffer): string {
  let lines = 0;
  for (const byte of patch) {
    if (byte === 10 && ++lines > WEBVIEW_FILE_PATCH_MAX_LINES) {
      throw new Error(`The file comparison contains more than ${String(WEBVIEW_FILE_PATCH_MAX_LINES)} lines.`);
    }
  }
  return patch.toString('utf8');
}

interface TextSearchCacheEntry {
  cwd: string;
  scannedCommits: number;
  baseMatchIndex: number;
  matches: CommitSummary[];
  matchesByHash: Map<string, CommitSummary>;
  graphParentSlots: Map<string, Map<string, ResolvedGraphParent>>;
  pendingGraphRoutes: Map<string, Map<string, PendingGraphRoute>>;
  contextsByMatchIndex: Map<number, CommitSummary[]>;
  maxContextsPerMatch: number;
  exhausted: boolean;
}

interface PendingGraphRoute {
  sourceHash: string;
  parentPath: GraphParentPath;
  converged: boolean;
  branched: boolean;
  branchAnchor?: GraphAnchorCandidate;
}

interface GraphAnchorCandidate {
  commit: CommitSummary;
  ownerIndex: number;
  contextPosition: number;
}

interface ResolvedGraphParent {
  hash: string;
  parentPath: GraphParentPath;
}

interface GraphParentPath {
  previous?: GraphParentPath;
  index: number;
  length: number;
  children?: Map<number, GraphParentPath>;
  values?: readonly number[];
}

function appendParentPath(previous: GraphParentPath | undefined, index: number): GraphParentPath {
  const existing = previous?.children?.get(index);
  if (existing) return existing;
  const appended: GraphParentPath = {
    ...(previous ? { previous } : {}),
    index,
    length: (previous?.length ?? 0) + 1,
  };
  if (previous) {
    previous.children ??= new Map();
    previous.children.set(index, appended);
  }
  return appended;
}

function parentPathValues(path: GraphParentPath): readonly number[] {
  if (path.values) return path.values;
  const values = new Array<number>(path.length);
  let current: GraphParentPath | undefined = path;
  for (let index = values.length - 1; index >= 0 && current; index -= 1) {
    values[index] = current.index;
    current = current.previous;
  }
  path.values = values;
  return values;
}

function compareParentPaths(leftPath: GraphParentPath, rightPath: GraphParentPath): number {
  if (leftPath === rightPath) return 0;

  let left: GraphParentPath | undefined = leftPath;
  let right: GraphParentPath | undefined = rightPath;
  let leftBranch: GraphParentPath | undefined;
  let rightBranch: GraphParentPath | undefined;
  while (left && right && left.length > right.length) {
    leftBranch = left;
    left = left.previous;
  }
  while (left && right && right.length > left.length) {
    rightBranch = right;
    right = right.previous;
  }
  while (left && right && left !== right) {
    leftBranch = left;
    rightBranch = right;
    left = left.previous;
    right = right.previous;
  }
  if (left && left === right) {
    if (!leftBranch) return -1;
    if (!rightBranch) return 1;
    return leftBranch.index - rightBranch.index;
  }

  // Routes for one source normally share their interned root. Keep a value fallback for malformed
  // or independently reconstructed paths so ordering remains deterministic.
  const leftValues = parentPathValues(leftPath);
  const rightValues = parentPathValues(rightPath);
  const length = Math.min(leftValues.length, rightValues.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftValues[index] ?? 0) - (rightValues[index] ?? 0);
    if (difference) return difference;
  }
  return leftValues.length - rightValues.length;
}

function queueGraphRoute(
  cache: TextSearchCacheEntry,
  target: string,
  route: PendingGraphRoute,
): void {
  const routes = cache.pendingGraphRoutes.get(target) ?? new Map<string, PendingGraphRoute>();
  const existing = routes.get(route.sourceHash);
  if (!existing) {
    routes.set(route.sourceHash, route);
  } else {
    const pathComparison = compareParentPaths(route.parentPath, existing.parentPath);
    if (pathComparison === 0) {
      cache.pendingGraphRoutes.set(target, routes);
      return;
    }
    const routeIsPreferred = pathComparison < 0;
    const preferred = routeIsPreferred ? route : existing;
    const alternate = routeIsPreferred ? existing : route;
    const anchorRoute = alternate.branchAnchor
      ? alternate
      : preferred.branchAnchor
        ? preferred
        : undefined;
    const retainedRoute = anchorRoute === preferred ? alternate : preferred;
    const anchor = anchorRoute?.branchAnchor;
    const anchorContexts = anchor
      ? (cache.contextsByMatchIndex.get(anchor.ownerIndex) ?? [])
      : [];
    if (
      anchor &&
      anchorContexts.length < cache.maxContextsPerMatch &&
      !cache.matchesByHash.has(anchor.commit.hash)
    ) {
      const visibleAnchor: CommitSummary = {
        ...anchor.commit,
        graphParents: [],
        filterMatch: false,
      };
      anchorContexts.splice(
        Math.min(anchor.contextPosition, anchorContexts.length),
        0,
        visibleAnchor,
      );
      cache.contextsByMatchIndex.set(anchor.ownerIndex, anchorContexts);
      cache.matchesByHash.set(visibleAnchor.hash, visibleAnchor);
      cache.graphParentSlots.set(visibleAnchor.hash, new Map());

      const sourceSlots = cache.graphParentSlots.get(route.sourceHash);
      if (sourceSlots) {
        sourceSlots.set(visibleAnchor.hash, {
          hash: visibleAnchor.hash,
          parentPath: anchorRoute.parentPath,
        });
        refreshGraphParents(cache, route.sourceHash);
      }
      routes.set(visibleAnchor.hash, {
        sourceHash: visibleAnchor.hash,
        parentPath: appendParentPath(undefined, 0),
        converged: false,
        branched: false,
      });
    }
    routes.set(route.sourceHash, { ...retainedRoute, converged: true });
  }
  cache.pendingGraphRoutes.set(target, routes);
}

function refreshGraphParents(cache: TextSearchCacheEntry, sourceHash: string): void {
  const source = cache.matchesByHash.get(sourceHash);
  const slots = cache.graphParentSlots.get(sourceHash);
  if (!source || !slots) return;
  const ordered = [...slots.values()].sort((left, right) =>
    compareParentPaths(left.parentPath, right.parentPath),
  );
  source.graphParents = ordered.map(({ hash }) => hash);
}

function projectGraphParentsToTextMatches(
  cache: TextSearchCacheEntry,
  commit: CommitSummary,
  projectionCache: Map<string, readonly string[]>,
): string[] {
  const projected: string[] = [];
  const projectedSet = new Set<string>();

  const resolve = (startHash: string): readonly string[] => {
    const cached = projectionCache.get(startHash);
    if (cached) return cached;

    const resolving = new Set<string>();
    const stack: { hash: string; expanded: boolean }[] = [
      { hash: startHash, expanded: false },
    ];
    while (stack.length) {
      const frame = stack.pop();
      if (!frame || projectionCache.has(frame.hash)) continue;
      const candidate = cache.matchesByHash.get(frame.hash);
      if (!candidate) {
        projectionCache.set(frame.hash, []);
        continue;
      }
      if (candidate.filterMatch !== false) {
        projectionCache.set(frame.hash, [frame.hash]);
        continue;
      }
      const parents = candidate.graphParents ?? [];
      if (!frame.expanded) {
        resolving.add(frame.hash);
        stack.push({ hash: frame.hash, expanded: true });
        for (let index = parents.length - 1; index >= 0; index -= 1) {
          const parent = parents[index];
          if (parent && !projectionCache.has(parent) && !resolving.has(parent)) {
            stack.push({ hash: parent, expanded: false });
          }
        }
        continue;
      }

      const resolved: string[] = [];
      const resolvedSet = new Set<string>();
      for (const parent of parents) {
        for (const hash of projectionCache.get(parent) ?? []) {
          if (resolvedSet.has(hash)) continue;
          resolvedSet.add(hash);
          resolved.push(hash);
          if (resolved.length >= MAX_PROJECTED_GRAPH_PARENTS) break;
        }
        if (resolved.length >= MAX_PROJECTED_GRAPH_PARENTS) break;
      }
      resolving.delete(frame.hash);
      projectionCache.set(frame.hash, resolved);
    }
    return projectionCache.get(startHash) ?? [];
  };

  for (const parent of commit.graphParents ?? []) {
    for (const hash of resolve(parent)) {
      if (projectedSet.has(hash)) continue;
      projectedSet.add(hash);
      projected.push(hash);
      if (projected.length >= MAX_PROJECTED_GRAPH_PARENTS) return projected;
    }
  }
  return projected;
}

function recordTextSearchCommit(
  cache: TextSearchCacheEntry,
  commit: CommitSummary,
  matchesText: boolean,
): void {
  const incomingRoutes = cache.pendingGraphRoutes.get(commit.hash) ?? new Map();
  cache.pendingGraphRoutes.delete(commit.hash);
  const isGraphContext =
    !matchesText &&
    incomingRoutes.size > 0 &&
    (commit.parents.length > 1 ||
      incomingRoutes.size > 1 ||
      [...incomingRoutes.values()].some((route) => route.converged));
  const ownerIndex = cache.baseMatchIndex + cache.matches.length - 1;
  const contexts = cache.contextsByMatchIndex.get(ownerIndex) ?? [];
  const retainAsGraphContext = isGraphContext && contexts.length < cache.maxContextsPerMatch;

  if (matchesText || retainAsGraphContext) {
    for (const route of incomingRoutes.values()) {
      const slots = cache.graphParentSlots.get(route.sourceHash);
      if (!slots) continue;
      const existing = slots.get(commit.hash);
      if (existing && compareParentPaths(existing.parentPath, route.parentPath) <= 0) continue;
      slots.set(commit.hash, { hash: commit.hash, parentPath: route.parentPath });
      refreshGraphParents(cache, route.sourceHash);
    }

    const visibleCommit: CommitSummary = {
      ...commit,
      graphParents: [],
      ...(isGraphContext ? { filterMatch: false } : {}),
    };
    if (matchesText) {
      cache.matches.push(visibleCommit);
    } else {
      contexts.push(visibleCommit);
      cache.contextsByMatchIndex.set(ownerIndex, contexts);
    }
    cache.matchesByHash.set(visibleCommit.hash, visibleCommit);
    cache.graphParentSlots.set(visibleCommit.hash, new Map());
    for (const [parentIndex, parent] of commit.parents.entries()) {
      queueGraphRoute(cache, parent, {
        sourceHash: visibleCommit.hash,
        parentPath: appendParentPath(undefined, parentIndex),
        converged: false,
        branched: commit.parents.length > 1,
      });
    }
    return;
  }

  const branches = commit.parents.length > 1;
  for (const route of incomingRoutes.values()) {
    const ownerIndex = cache.baseMatchIndex + cache.matches.length - 1;
    const contexts = cache.contextsByMatchIndex.get(ownerIndex) ?? [];
    const branchAnchor =
      route.branchAnchor ??
      (route.branched
        ? { commit, ownerIndex, contextPosition: contexts.length }
        : undefined);
    for (const [parentIndex, parent] of commit.parents.entries()) {
      queueGraphRoute(cache, parent, {
        sourceHash: route.sourceHash,
        // Linear hidden commits do not affect route ordering. Only record actual branch choices,
        // keeping long filtered first-parent chains O(history length) instead of O(length²).
        parentPath: branches
          ? appendParentPath(route.parentPath, parentIndex)
          : route.parentPath,
        converged: route.converged,
        branched: route.branched,
        ...(branchAnchor ? { branchAnchor } : {}),
      });
    }
  }
}

function trimTextSearchGraph(cache: TextSearchCacheEntry, count: number): void {
  if (count <= 0) return;
  const discardedHashes = new Set<string>();
  for (let offset = 0; offset < count; offset += 1) {
    const matchIndex = cache.baseMatchIndex + offset;
    const match = cache.matches[offset];
    if (match) discardedHashes.add(match.hash);
    for (const context of cache.contextsByMatchIndex.get(matchIndex) ?? []) {
      discardedHashes.add(context.hash);
    }
    cache.contextsByMatchIndex.delete(matchIndex);
  }
  cache.matches.splice(0, count);
  for (const hash of discardedHashes) {
    cache.matchesByHash.delete(hash);
    cache.graphParentSlots.delete(hash);
  }
  for (const [target, routes] of cache.pendingGraphRoutes) {
    for (const [key, route] of routes) {
      if (discardedHashes.has(route.sourceHash)) routes.delete(key);
    }
    if (!routes.size) cache.pendingGraphRoutes.delete(target);
  }
}

function graphSourceHashesForRange(
  cache: TextSearchCacheEntry,
  absoluteStart: number,
  count: number,
): Set<string> {
  const localStart = absoluteStart - cache.baseMatchIndex;
  const hashes = new Set<string>();
  for (let offset = 0; offset < count; offset += 1) {
    const match = cache.matches[localStart + offset];
    if (!match) break;
    hashes.add(match.hash);
    for (const context of cache.contextsByMatchIndex.get(absoluteStart + offset) ?? []) {
      hashes.add(context.hash);
    }
  }
  return hashes;
}

function sealTextSearchGraphRange(
  cache: TextSearchCacheEntry,
  absoluteStart: number,
  count: number,
): void {
  const returnedHashes = graphSourceHashesForRange(cache, absoluteStart, count);
  if (!returnedHashes.size) return;
  for (const [target, routes] of cache.pendingGraphRoutes) {
    for (const [key, route] of routes) {
      if (returnedHashes.has(route.sourceHash)) routes.delete(key);
    }
    if (!routes.size) cache.pendingGraphRoutes.delete(target);
  }
}

function hasPendingGraphRoutesForRange(
  cache: TextSearchCacheEntry,
  absoluteStart: number,
  count: number,
): boolean {
  const returnedHashes = graphSourceHashesForRange(cache, absoluteStart, count);
  if (!returnedHashes.size) return false;
  for (const routes of cache.pendingGraphRoutes.values()) {
    for (const route of routes.values()) {
      if (returnedHashes.has(route.sourceHash)) return true;
    }
  }
  return false;
}

export class GitService {
  private readonly textSearchCaches = new Map<string, TextSearchCacheEntry>();

  constructor(private readonly runner: GitRunner) {}

  async getStashes(cwd: string, signal?: AbortSignal): Promise<StashEntry[]> {
    const result = await this.runner.run(
      ['stash', 'list', '--format=%gd%x00%H%x00%ct%x00%s%x00'],
      { cwd, ...(signal ? { signal } : {}), timeoutMs: 30_000 },
    );
    const fields = result.stdout.toString('utf8').replace(/\r?\n/gu, '').split('\0');
    const entries: StashEntry[] = [];
    for (let index = 0; index + 3 < fields.length; index += 4) {
      const ref = fields[index];
      const hash = fields[index + 1];
      const timestamp = Number.parseInt(fields[index + 2] ?? '', 10);
      const subject = fields[index + 3];
      if (!ref || !hash || !subject || !Number.isFinite(timestamp)) continue;
      entries.push({ ref, hash, timestamp, subject });
    }
    return entries;
  }

  private getTextSearchCache(cwd: string, filters: LogFilters): TextSearchCacheEntry {
    const key = JSON.stringify([
      cwd,
      filters.text.trim().toLowerCase(),
      filters.branches,
      filters.authors,
      filters.paths,
      filters.dateFrom ?? null,
      filters.dateTo ?? null,
    ]);
    const existing = this.textSearchCaches.get(key);
    if (existing) {
      this.textSearchCaches.delete(key);
      this.textSearchCaches.set(key, existing);
      return existing;
    }
    const created: TextSearchCacheEntry = {
      cwd,
      scannedCommits: 0,
      baseMatchIndex: 0,
      matches: [],
      matchesByHash: new Map(),
      graphParentSlots: new Map(),
      pendingGraphRoutes: new Map(),
      contextsByMatchIndex: new Map(),
      maxContextsPerMatch: MAX_GRAPH_CONTEXT_ROWS_PER_MATCH,
      exhausted: false,
    };
    this.textSearchCaches.set(key, created);
    while (this.textSearchCaches.size > MAX_TEXT_SEARCH_CACHES) {
      const oldestKey = this.textSearchCaches.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.textSearchCaches.delete(oldestKey);
    }
    return created;
  }

  invalidateLogCache(cwd?: string): void {
    if (cwd === undefined) {
      this.textSearchCaches.clear();
      return;
    }
    for (const [key, entry] of this.textSearchCaches) {
      if (entry.cwd === cwd) this.textSearchCaches.delete(key);
    }
  }

  async getVersion(cwd: string): Promise<string> {
    const result = await this.runner.run(['--version'], { cwd, timeoutMs: 10_000 });
    return result.stdout.toString('utf8').trim();
  }

  async getRefs(cwd: string, currentBranch?: string, signal?: AbortSignal): Promise<RefLabel[]> {
    const options = { cwd, ...(signal ? { signal } : {}), timeoutMs: 30_000 };
    const [result, remotes] = await Promise.all([
      this.runner.run(
        [
          'for-each-ref',
          `--format=${REF_FORMAT}`,
          'refs/heads',
          'refs/remotes',
          'refs/tags',
        ],
        options,
      ),
      this.runner.run(['remote'], options),
    ]);
    const remoteNames = remotes.stdout
      .toString('utf8')
      .split(/\r?\n/u)
      .filter(Boolean);
    return parseRefs(result.stdout, currentBranch, remoteNames);
  }

  async getLog(cwd: string, query: LogQuery): Promise<CommitSummary[]> {
    validatePage(query);
    const filters = query.filters ?? EMPTY_LOG_FILTERS;
    const refsByTarget = indexRefsByTarget(query.refs);
    if (filters.branches.length) {
      const knownRefs = new Set(query.refs.map((ref) => ref.fullName));
      const unknownBranch = filters.branches.find((branch) => !knownRefs.has(branch));
      if (unknownBranch) throw new Error(`Unknown branch filter: ${unknownBranch}`);
    }

    try {
      if (!filters.text.trim()) {
        const result = await this.runner.run(
          buildLogArguments({
            limit: query.limit,
            skip: query.skip,
            format: LOG_FORMAT,
            filters,
          }),
          { cwd, ...(query.signal ? { signal: query.signal } : {}), timeoutMs: 60_000 },
        );
        const parsed = parseLog(result.stdout);
        const commits = filtersMayHideAncestors(filters)
          ? limitGraphParentsToVisibleCommits(parsed)
          : parsed;
        return commits.map((commit) => attachRefs(commit, refsByTarget));
      }

      const text = filters.text.trim();
      if (/^[0-9a-f]{4,64}$/iu.test(text)) {
        let resolvedHash: string | undefined;
        try {
          // The hexadecimal-only input is option-safe; rev-parse gained --end-of-options in Git 2.30.
          const resolution = await this.runner.run(
            ['rev-parse', '--verify', `${text}^{commit}`],
            { cwd, ...(query.signal ? { signal: query.signal } : {}), timeoutMs: 30_000 },
          );
          resolvedHash = resolution.stdout.toString('utf8').trim();
        } catch (error) {
          if (!(error instanceof GitCommandError) || error.cancelled) throw error;
        }

        if (resolvedHash) {
          if (filters.branches.length) {
            const containment = await Promise.all(
              filters.branches.map(async (branch) => {
                try {
                  await this.runner.run(['merge-base', '--is-ancestor', resolvedHash, branch], {
                    cwd,
                    ...(query.signal ? { signal: query.signal } : {}),
                    timeoutMs: 30_000,
                  });
                  return true;
                } catch (error) {
                  if (error instanceof GitCommandError && !error.cancelled) return false;
                  throw error;
                }
              }),
            );
            if (!containment.some(Boolean)) return [];
          }

          const hashFilters: LogFilters = { ...filters, text: '', branches: [] };
          const args = buildLogArguments({
            limit: 1,
            skip: 0,
            format: LOG_FORMAT,
            filters: hashFilters,
          });
          const headIndex = args.lastIndexOf('HEAD');
          if (headIndex > 0 && args[headIndex - 1] === '--end-of-options') {
            args.splice(headIndex - 1, 2, '--no-walk', resolvedHash);
          }
          const result = await this.runner.run(args, {
            cwd,
            ...(query.signal ? { signal: query.signal } : {}),
            timeoutMs: 30_000,
          });
          return parseLog(result.stdout).map((commit) =>
            attachRefs({ ...commit, graphParents: [] }, refsByTarget),
          );
        }
      }

      const cache = this.getTextSearchCache(cwd, filters);
      cache.maxContextsPerMatch = MAX_GRAPH_CONTEXT_ROWS_PER_MATCH;
      if (query.skip < cache.baseMatchIndex) {
        cache.scannedCommits = 0;
        cache.baseMatchIndex = 0;
        cache.matches = [];
        cache.matchesByHash.clear();
        cache.graphParentSlots.clear();
        cache.pendingGraphRoutes.clear();
        cache.contextsByMatchIndex.clear();
        cache.exhausted = false;
      }
      const requiredMatches = query.skip + query.limit;
      let graphLookaheadBatches = 0;
      const normalizedText = text.toLowerCase();
      const scanFilters: LogFilters = { ...filters, text: '' };
      while (!cache.exhausted) {
        const hasRequestedPage =
          cache.baseMatchIndex + cache.matches.length >= requiredMatches;
        if (hasRequestedPage) {
          const hasPendingGraphRoutes = hasPendingGraphRoutesForRange(
            cache,
            query.skip,
            query.limit,
          );
          if (!hasPendingGraphRoutes || graphLookaheadBatches >= 1) break;
          graphLookaheadBatches += 1;
        }
        const result = await this.runner.run(
          buildLogArguments({
            limit: TEXT_SCAN_PAGE_SIZE,
            skip: cache.scannedCommits,
            format: SEARCH_LOG_FORMAT,
            filters: scanFilters,
          }),
          {
            cwd,
            ...(query.signal ? { signal: query.signal } : {}),
            timeoutMs: 60_000,
            maxStdoutBytes: TEXT_SCAN_MAX_STDOUT_BYTES,
          },
        );
        const scanned = parseSearchableLog(result.stdout);
        cache.scannedCommits += scanned.length;
        for (const { commit, body } of scanned) {
          const searchableText = `${commit.authorName}\n${commit.authorEmail}\n${body}`.toLowerCase();
          recordTextSearchCommit(cache, commit, searchableText.includes(normalizedText));
        }
        const excess = cache.matches.length - MAX_RETAINED_TEXT_MATCHES;
        const discardable = query.skip - cache.baseMatchIndex;
        const trim = Math.min(Math.max(0, excess), Math.max(0, discardable));
        if (trim > 0) {
          trimTextSearchGraph(cache, trim);
          cache.baseMatchIndex += trim;
        }
        cache.exhausted = scanned.length < TEXT_SCAN_PAGE_SIZE;
      }
      const localStart = query.skip - cache.baseMatchIndex;
      const pageMatches: CommitSummary[] = [];
      for (let offset = 0; offset < query.limit; offset += 1) {
        const match = cache.matches[localStart + offset];
        if (!match) break;
        pageMatches.push(match);
      }
      // A route still unresolved after the scan lookahead may belong to an unrelated branch.
      // Seal returned rows so later pages cannot silently revise graph data already sent to the UI.
      sealTextSearchGraphRange(cache, query.skip, query.limit);
      const graphProjectionCache = new Map<string, readonly string[]>();
      return pageMatches.map((commit) =>
        attachRefs(
          {
            ...commit,
            graphParents: projectGraphParentsToTextMatches(
              cache,
              commit,
              graphProjectionCache,
            ),
          },
          refsByTarget,
        ),
      );
    } catch (error) {
      if (
        error instanceof GitCommandError &&
        !error.cancelled &&
        /does not have any commits|your current branch .* does not have any commits|ambiguous argument 'head'/u.test(
          error.stderr.toString('utf8').toLowerCase(),
        )
      ) {
        return [];
      }
      throw error;
    }
  }

  async getCommitDetails(
    cwd: string,
    hash: string,
    refs: readonly RefLabel[],
    signal?: AbortSignal,
  ): Promise<CommitDetails> {
    if (!COMMIT_HASH_PATTERN.test(hash)) {
      throw new Error(`Invalid commit hash: ${hash}`);
    }

    const result = await this.runner.run(
      ['show', '--no-patch', `--format=${DETAILS_FORMAT}`, hash, '--'],
      { cwd, ...(signal ? { signal } : {}), timeoutMs: 30_000 },
    );
    return attachRefs(parseCommitDetails(result.stdout), indexRefsByTarget(refs));
  }

  async getCommitMessage(cwd: string, hash: string, signal?: AbortSignal): Promise<string> {
    if (!COMMIT_HASH_PATTERN.test(hash)) {
      throw new Error(`Invalid commit hash: ${hash}`);
    }
    const result = await this.runner.run(
      ['show', '--no-patch', '--format=%B', hash, '--'],
      {
        cwd,
        ...(signal ? { signal } : {}),
        timeoutMs: 30_000,
        maxStdoutBytes: 400_004,
      },
    );
    const message = result.stdout.toString('utf8').replace(/\r?\n$/u, '');
    if (message.length > 100_000) {
      throw new Error('A selected commit message exceeds the 100,000 character limit.');
    }
    return message;
  }

  async getChangedFiles(
    cwd: string,
    hash: string,
    parent?: string,
    signal?: AbortSignal,
  ): Promise<ChangedFile[]> {
    if (!COMMIT_HASH_PATTERN.test(hash)) throw new Error(`Invalid commit hash: ${hash}`);
    if (parent && !COMMIT_HASH_PATTERN.test(parent)) throw new Error(`Invalid parent hash: ${parent}`);

    const selectedParent =
      parent ?? (await this.getCommitDetails(cwd, hash, [], signal)).parents[0];
    const signalOption = signal ? { signal } : {};
    const statusArgs = selectedParent
      ? ['diff', '--name-status', '-z', '-M', '-C', '--find-copies-harder', '-l1000', selectedParent, hash, '--']
      : [
          'diff-tree',
          '--root',
          '--no-commit-id',
          '--name-status',
          '-r',
          '-z',
          '-M',
          '-C',
          '--find-copies-harder',
          '-l1000',
          hash,
        ];
    const numstatArgs = selectedParent
      ? ['diff', '--numstat', '-z', '-M', selectedParent, hash, '--']
      : [
          'diff-tree',
          '--root',
          '--no-commit-id',
          '--numstat',
          '-r',
          '-z',
          '-M',
          hash,
        ];

    const [statusResult, numstatResult] = await Promise.all([
      this.runner.run(statusArgs, { cwd, ...signalOption, timeoutMs: 60_000 }),
      this.runner.run(numstatArgs, { cwd, ...signalOption, timeoutMs: 60_000 }),
    ]);
    return applyNumstat(parseNameStatus(statusResult.stdout), numstatResult.stdout);
  }

  async getFilePatch(
    cwd: string,
    hash: string,
    parent: string | undefined,
    path: string,
    oldPath?: string,
    signal?: AbortSignal,
    contextLines = FULL_FILE_DIFF_CONTEXT_LINES,
  ): Promise<string> {
    if (!COMMIT_HASH_PATTERN.test(hash)) throw new Error(`Invalid commit hash: ${hash}`);
    if (parent && !COMMIT_HASH_PATTERN.test(parent)) throw new Error(`Invalid parent hash: ${parent}`);
    validateRepositoryPath(path);
    if (oldPath !== undefined) validateRepositoryPath(oldPath);
    if (!Number.isSafeInteger(contextLines) || contextLines < 0) {
      throw new Error('Invalid file patch context.');
    }
    const paths = oldPath && oldPath !== path ? [oldPath, path] : [path];
    const args = parent
      ? [
          '--literal-pathspecs',
          'diff',
          '--no-color',
          '--no-ext-diff',
          '--no-textconv',
          `--unified=${String(contextLines)}`,
          '-M',
          parent,
          hash,
          '--',
          ...paths,
        ]
      : [
          '--literal-pathspecs',
          'show',
          '--format=',
          '--no-color',
          '--no-ext-diff',
          '--no-textconv',
          `--unified=${String(contextLines)}`,
          '-M',
          hash,
          '--',
          ...paths,
        ];
    const result = await this.runner.run(args, {
      cwd,
      ...(signal ? { signal } : {}),
      timeoutMs: 60_000,
      maxStdoutBytes: WEBVIEW_FILE_PATCH_MAX_STDOUT_BYTES,
    });
    return webviewFilePatchText(result.stdout);
  }

  async getWorkingFilePatch(
    cwd: string,
    revision: string,
    path: string,
    workingContent?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (!COMMIT_HASH_PATTERN.test(revision)) throw new Error(`Invalid commit hash: ${revision}`);
    validateRepositoryPath(path);
    let workingFileContent: Buffer;
    if (workingContent === undefined) {
      try {
        workingFileContent = await readFile(join(cwd, path));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        workingFileContent = Buffer.alloc(0);
      }
    } else {
      workingFileContent = Buffer.from(workingContent, 'utf8');
    }
    if (workingFileContent.byteLength > WEBVIEW_FILE_PATCH_MAX_STDOUT_BYTES) {
      throw new Error('The editor content is too large to compare.');
    }
    let revisionContent: Buffer = Buffer.alloc(0);
    const revisionTreeEntry = await this.runner.run(
      ['--literal-pathspecs', 'ls-tree', '-z', '--full-tree', revision, '--', path],
      {
        cwd,
        ...(signal ? { signal } : {}),
        timeoutMs: 30_000,
        maxStdoutBytes: 4096,
      },
    );
    if (/^[0-7]{6} blob [0-9a-f]+\t/u.test(revisionTreeEntry.stdout.toString('utf8'))) {
      revisionContent = (
        await this.runner.run(
          ['cat-file', '--filters', `--path=${path}`, `${revision}:${path}`],
          {
            cwd,
            ...(signal ? { signal } : {}),
            timeoutMs: 60_000,
            maxStdoutBytes: WEBVIEW_FILE_PATCH_MAX_STDOUT_BYTES,
          },
        )
      ).stdout;
    }
    const diffAttribute = await this.runner.run(['check-attr', '-z', 'diff', '--', path], {
      cwd,
      ...(signal ? { signal } : {}),
      timeoutMs: 30_000,
      maxStdoutBytes: 16 * 1024,
    });
    const diffAttributeValue = diffAttribute.stdout.toString('utf8').split('\0')[2];
    if (diffAttributeValue === 'unset') {
      return revisionContent.equals(workingFileContent)
        ? ''
        : `Binary files ${path} differ\n`;
    }
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'git-log-file-compare-'));
    const revisionPath = join(temporaryDirectory, 'revision');
    const workingPath = join(temporaryDirectory, 'working');
    try {
      await Promise.all([
        writeFile(revisionPath, revisionContent),
        writeFile(workingPath, workingFileContent),
      ]);
      try {
        const result = await this.runner.run(
          [
            'diff',
            '--no-index',
            '--no-color',
            '--no-ext-diff',
            '--no-textconv',
            `--unified=${String(FULL_FILE_DIFF_CONTEXT_LINES)}`,
            '--',
            revisionPath,
            workingPath,
          ],
          {
            cwd,
            ...(signal ? { signal } : {}),
            timeoutMs: 60_000,
            maxStdoutBytes: WEBVIEW_FILE_PATCH_MAX_STDOUT_BYTES,
          },
        );
        return webviewFilePatchText(result.stdout);
      } catch (error) {
        if (
          error instanceof GitCommandError &&
          error.exitCode === 1 &&
          !error.cancelled &&
          !error.timedOut
        ) {
          return webviewFilePatchText(error.stdout);
        }
        throw error;
      }
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  async getFileContent(
    cwd: string,
    revision: string,
    path: string,
    signal?: AbortSignal,
    maximumBytes?: number,
  ): Promise<Buffer> {
    if (!COMMIT_HASH_PATTERN.test(revision)) throw new Error(`Invalid commit hash: ${revision}`);
    if (!path || path.includes('\0')) throw new Error('Invalid repository path.');

    const result = await this.runner.run(['cat-file', 'blob', `${revision}:${path}`], {
      cwd,
      ...(signal ? { signal } : {}),
      timeoutMs: 60_000,
      ...(maximumBytes !== undefined ? { maxStdoutBytes: maximumBytes } : {}),
    });
    return result.stdout;
  }

  async hasFileAtRevision(
    cwd: string,
    revision: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!COMMIT_HASH_PATTERN.test(revision)) throw new Error(`Invalid commit hash: ${revision}`);
    if (!path || path.includes('\0')) throw new Error('Invalid repository path.');
    try {
      await this.runner.run(['cat-file', '-e', `${revision}:${path}`], {
        cwd,
        ...(signal ? { signal } : {}),
        timeoutMs: 30_000,
        maxStdoutBytes: 64,
      });
      return true;
    } catch (error) {
      if (error instanceof GitCommandError && !error.cancelled && !error.timedOut) return false;
      throw error;
    }
  }

  async getFileSize(cwd: string, revision: string, path: string, signal?: AbortSignal): Promise<number> {
    if (!COMMIT_HASH_PATTERN.test(revision)) throw new Error(`Invalid commit hash: ${revision}`);
    if (!path || path.includes('\0')) throw new Error('Invalid repository path.');
    const result = await this.runner.run(['cat-file', '-s', `${revision}:${path}`], {
      cwd,
      ...(signal ? { signal } : {}),
      timeoutMs: 30_000,
      maxStdoutBytes: 64,
    });
    const size = Number.parseInt(result.stdout.toString('utf8').trim(), 10);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Git returned an invalid blob size.');
    return size;
  }
}
