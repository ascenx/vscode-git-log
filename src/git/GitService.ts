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
const FULL_FILE_DIFF_CONTEXT_LINES = 2_147_483_647;
const WEBVIEW_FILE_PATCH_MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const WEBVIEW_FILE_PATCH_MAX_LINES = 50_000;

export interface LogQuery {
  limit: number;
  skip: number;
  refs: readonly RefLabel[];
  signal?: AbortSignal;
  filters?: LogFilters;
}

function attachRefs<T extends CommitSummary>(commit: T, refs: readonly RefLabel[]): T {
  const matchingRefs = refs.filter((ref) => ref.target === commit.hash);
  return { ...commit, refs: matchingRefs };
}

function validatePage(query: LogQuery): void {
  if (!Number.isInteger(query.limit) || query.limit <= 0 || query.limit > 5000) {
    throw new Error(`Invalid log page limit: ${String(query.limit)}`);
  }
  if (!Number.isSafeInteger(query.skip) || query.skip < 0) {
    throw new Error(`Invalid log page offset: ${String(query.skip)}`);
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
  exhausted: boolean;
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
        return parseLog(result.stdout).map((commit) => attachRefs(commit, query.refs));
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
          return parseLog(result.stdout).map((commit) => attachRefs(commit, query.refs));
        }
      }

      const cache = this.getTextSearchCache(cwd, filters);
      if (query.skip < cache.baseMatchIndex) {
        cache.scannedCommits = 0;
        cache.baseMatchIndex = 0;
        cache.matches = [];
        cache.exhausted = false;
      }
      const wantedMatches = query.skip + query.limit;
      const normalizedText = text.toLowerCase();
      const scanFilters: LogFilters = { ...filters, text: '' };
      while (cache.baseMatchIndex + cache.matches.length < wantedMatches && !cache.exhausted) {
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
          if (searchableText.includes(normalizedText)) cache.matches.push(commit);
        }
        const excess = cache.matches.length - MAX_RETAINED_TEXT_MATCHES;
        const discardable = query.skip - cache.baseMatchIndex;
        const trim = Math.min(Math.max(0, excess), Math.max(0, discardable));
        if (trim > 0) {
          cache.matches.splice(0, trim);
          cache.baseMatchIndex += trim;
        }
        cache.exhausted = scanned.length < TEXT_SCAN_PAGE_SIZE;
      }
      return cache.matches
        .slice(
          query.skip - cache.baseMatchIndex,
          query.skip - cache.baseMatchIndex + query.limit,
        )
        .map((commit) => attachRefs(commit, query.refs));
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
    return attachRefs(parseCommitDetails(result.stdout), refs);
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
      ? ['diff', '--name-status', '-z', '-M', '-C', '--find-copies-harder', selectedParent, hash, '--']
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
          hash,
        ];
    const numstatArgs = selectedParent
      ? ['diff', '--numstat', '-z', '-M', '-C', '--find-copies-harder', selectedParent, hash, '--']
      : [
          'diff-tree',
          '--root',
          '--no-commit-id',
          '--numstat',
          '-r',
          '-z',
          '-M',
          '-C',
          '--find-copies-harder',
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
  ): Promise<string> {
    if (!COMMIT_HASH_PATTERN.test(hash)) throw new Error(`Invalid commit hash: ${hash}`);
    if (parent && !COMMIT_HASH_PATTERN.test(parent)) throw new Error(`Invalid parent hash: ${parent}`);
    validateRepositoryPath(path);
    if (oldPath !== undefined) validateRepositoryPath(oldPath);
    const paths = oldPath && oldPath !== path ? [oldPath, path] : [path];
    const args = parent
      ? [
          '--literal-pathspecs',
          'diff',
          '--no-color',
          '--no-ext-diff',
          '--no-textconv',
          `--unified=${String(FULL_FILE_DIFF_CONTEXT_LINES)}`,
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
          `--unified=${String(FULL_FILE_DIFF_CONTEXT_LINES)}`,
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
