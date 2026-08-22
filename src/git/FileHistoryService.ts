import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitCommandError, type GitRunner } from './GitRunner';
import { parseFileHistory } from './parsers/parseFileHistory';
import { parseLineHistory, type LineHistoryEntry } from './parsers/parseLineHistory';
import {
  mapWorktreeLineRange,
  type WorktreeLineMappingResult,
} from './worktreeLineMapping';
import type { HistoryEntry, RefLabel } from '../shared/models';

const FILE_HISTORY_FORMAT = '%x1e%H%x00%P%x00%an%x00%ae%x00%at%x00%ct%x00%s%x00';
const LINE_HISTORY_LIMIT = 500;
const MAX_FILE_HISTORY_CACHES = 20;
const MAX_HISTORY_OUTPUT_BYTES = 64 * 1024 * 1024;

export interface FileHistoryPage {
  limit: number;
  skip: number;
  signal?: AbortSignal;
}

export type HeadLineRangeResult =
  | WorktreeLineMappingResult
  | { status: 'file-not-in-head'; hasHistory: boolean };

export interface LineHistoryResult {
  entries: LineHistoryEntry[];
  truncated: boolean;
}

interface FileHistoryCacheEntry {
  cwd: string;
  head: string;
  path: string;
  scannedRecords: number;
  complete: boolean;
  entries: HistoryEntry[];
}

function countHistoryRecords(output: Buffer): number {
  let count = 0;
  for (const byte of output) {
    if (byte === 0x1e) count += 1;
  }
  return count;
}

function attachRefs(entries: readonly HistoryEntry[], refs: readonly RefLabel[]): HistoryEntry[] {
  const refsByTarget = new Map<string, RefLabel[]>();
  for (const ref of refs) {
    const target = ref.target;
    const matching = refsByTarget.get(target) ?? [];
    matching.push(ref);
    refsByTarget.set(target, matching);
  }
  return entries.map((entry) => ({
    ...entry,
    refs: refsByTarget.get(entry.hash) ?? [],
  }));
}

function validatePath(path: string): void {
  if (!path || path.includes('\0')) {
    throw new Error('Invalid repository path.');
  }
}

function validateLineHistoryPath(path: string): void {
  validatePath(path);
  if (path.includes('\n') || path.includes('\r')) {
    throw new Error('Line history does not support paths containing line breaks.');
  }
}

function validateLineRange(startLine: number, endLine: number): void {
  if (
    !Number.isSafeInteger(startLine) ||
    !Number.isSafeInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine
  ) {
    throw new Error('Invalid line history range.');
  }
}

function normalizeLogicalLines(value: string): string {
  return value.replace(/\r\n?/gu, '\n');
}

function decodeCanonicalGitText(value: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    throw new Error('Unsaved line history requires the committed file to use UTF-8 text.');
  }
}

export class FileHistoryService {
  private readonly fileHistoryCaches = new Map<string, FileHistoryCacheEntry>();

  constructor(private readonly runner: GitRunner) {}

  invalidate(cwd?: string): void {
    if (cwd === undefined) {
      this.fileHistoryCaches.clear();
      return;
    }
    for (const [key, entry] of this.fileHistoryCaches) {
      if (entry.cwd === cwd) this.fileHistoryCaches.delete(key);
    }
  }

  async getFileHistory(
    cwd: string,
    path: string,
    refs: readonly RefLabel[],
    page: FileHistoryPage,
  ): Promise<HistoryEntry[]> {
    validatePath(path);
    if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 5000) {
      throw new Error(`Invalid file history page limit: ${String(page.limit)}`);
    }
    if (!Number.isSafeInteger(page.skip) || page.skip < 0) {
      throw new Error(`Invalid file history page offset: ${String(page.skip)}`);
    }
    const scanLimit = page.skip + page.limit;
    if (!Number.isSafeInteger(scanLimit)) {
      throw new Error('File history page exceeds the supported offset range.');
    }
    const headResult = await this.runner.run(['rev-parse', '--verify', 'HEAD'], {
      cwd,
      ...(page.signal ? { signal: page.signal } : {}),
      timeoutMs: 30_000,
      maxStdoutBytes: 256,
    });
    const head = headResult.stdout.toString('utf8').trim();
    const cacheKey = JSON.stringify([cwd, head, path]);
    let cached = this.fileHistoryCaches.get(cacheKey);
    if (cached && (cached.complete || cached.entries.length >= scanLimit)) {
      this.fileHistoryCaches.delete(cacheKey);
      this.fileHistoryCaches.set(cacheKey, cached);
      return attachRefs(cached.entries.slice(page.skip, scanLimit), refs);
    }
    if (!cached) {
      cached = {
        cwd,
        head,
        path,
        scannedRecords: 0,
        complete: false,
        entries: [],
      };
      this.fileHistoryCaches.set(cacheKey, cached);
    }
    let rawScanLimit = Math.max(
      scanLimit,
      cached.scannedRecords + Math.max(1, scanLimit - cached.entries.length),
    );
    while (!cached.complete && cached.entries.length < scanLimit) {
      const result = await this.runner.run(
        [
          '--literal-pathspecs',
          'log',
          '--follow',
          '--no-merges',
          '-M',
          '--date-order',
          '--no-color',
          `--format=${FILE_HISTORY_FORMAT}`,
          '--numstat',
          '-z',
          `--max-count=${String(rawScanLimit)}`,
          head,
          '--',
          path,
        ],
        {
          cwd,
          ...(page.signal ? { signal: page.signal } : {}),
          timeoutMs: 60_000,
          maxStdoutBytes: 64 * 1024 * 1024,
        },
      );
      const rawRecordCount = countHistoryRecords(result.stdout);
      cached.entries = parseFileHistory(result.stdout, []);
      cached.scannedRecords = rawRecordCount;
      cached.complete = rawRecordCount < rawScanLimit;
      if (cached.complete || cached.entries.length >= scanLimit) break;
      const nextRawScanLimit = rawScanLimit * 2;
      if (!Number.isSafeInteger(nextRawScanLimit)) {
        throw new Error('File history scan exceeds the supported range.');
      }
      rawScanLimit = nextRawScanLimit;
    }
    this.fileHistoryCaches.delete(cacheKey);
    this.fileHistoryCaches.set(cacheKey, cached);
    while (this.fileHistoryCaches.size > MAX_FILE_HISTORY_CACHES) {
      const oldestKey = this.fileHistoryCaches.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.fileHistoryCaches.delete(oldestKey);
    }
    return attachRefs(cached.entries.slice(page.skip, scanLimit), refs);
  }

  async resolveHeadLineRange(
    cwd: string,
    path: string,
    startLine: number,
    endLine: number,
    signal?: AbortSignal,
    workingContent?: string,
  ): Promise<HeadLineRangeResult> {
    validateLineHistoryPath(path);
    validateLineRange(startLine, endLine);
    try {
      await this.runner.run(['cat-file', '-e', `HEAD:${path}`], {
        cwd,
        ...(signal ? { signal } : {}),
        timeoutMs: 30_000,
      });
    } catch (error) {
      if (error instanceof GitCommandError && !error.cancelled && !error.timedOut) {
        const history = await this.runner.run(
          ['log', '-1', '--format=%H', 'HEAD', '--', path],
          {
            cwd,
            ...(signal ? { signal } : {}),
            timeoutMs: 30_000,
            maxStdoutBytes: 256,
          },
        );
        return {
          status: 'file-not-in-head',
          hasHistory: history.stdout.toString('utf8').trim().length > 0,
        };
      }
      throw error;
    }
    const diff =
      workingContent === undefined
        ? await this.runner.run(
            [
              'diff',
              '--unified=0',
              '--no-color',
              '--no-ext-diff',
              '--no-textconv',
              'HEAD',
              '--',
              path,
            ],
            {
              cwd,
              ...(signal ? { signal } : {}),
              timeoutMs: 60_000,
              maxStdoutBytes: MAX_HISTORY_OUTPUT_BYTES,
            },
          )
        : { stdout: await this.diffHeadAgainstEditorContent(cwd, path, workingContent, signal) };
    return mapWorktreeLineRange(diff.stdout, startLine, endLine);
  }

  private async diffHeadAgainstEditorContent(
    cwd: string,
    path: string,
    workingContent: string,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    if (Buffer.byteLength(workingContent, 'utf8') > MAX_HISTORY_OUTPUT_BYTES) {
      throw new Error('The editor content is too large for line history.');
    }
    const headContent = await this.runner.run(['cat-file', 'blob', `HEAD:${path}`], {
      cwd,
      ...(signal ? { signal } : {}),
      timeoutMs: 60_000,
      maxStdoutBytes: MAX_HISTORY_OUTPUT_BYTES,
    });
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'git-log-line-history-'));
    const headPath = join(temporaryDirectory, 'head');
    const editorPath = join(temporaryDirectory, 'editor');
    try {
      await Promise.all([
        writeFile(headPath, normalizeLogicalLines(decodeCanonicalGitText(headContent.stdout)), 'utf8'),
        writeFile(editorPath, normalizeLogicalLines(workingContent), 'utf8'),
      ]);
      try {
        const result = await this.runner.run(
          [
            'diff',
            '--no-index',
            '--unified=0',
            '--no-color',
            '--no-ext-diff',
            '--no-textconv',
            '--',
            headPath,
            editorPath,
          ],
          {
            cwd,
            ...(signal ? { signal } : {}),
            timeoutMs: 60_000,
            maxStdoutBytes: MAX_HISTORY_OUTPUT_BYTES,
          },
        );
        return result.stdout;
      } catch (error) {
        if (
          error instanceof GitCommandError &&
          error.exitCode === 1 &&
          !error.cancelled &&
          !error.timedOut
        ) {
          return error.stdout;
        }
        throw error;
      }
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  async getLineHistory(
    cwd: string,
    path: string,
    startLine: number,
    endLine: number,
    refs: readonly RefLabel[],
    signal?: AbortSignal,
  ): Promise<LineHistoryResult> {
    validateLineHistoryPath(path);
    validateLineRange(startLine, endLine);
    const targetEntryCount = LINE_HISTORY_LIMIT + 1;
    let rawScanLimit = targetEntryCount;
    let entries: LineHistoryEntry[];
    while (true) {
      const result = await this.runner.run(
        [
          'log',
          'HEAD',
          '-L',
          `${String(startLine)},${String(endLine)}:${path}`,
          `--format=${FILE_HISTORY_FORMAT}`,
          '--no-color',
          '--no-ext-diff',
          '--no-textconv',
          `--unified=${String(endLine - startLine)}`,
          `--max-count=${String(rawScanLimit)}`,
        ],
        {
          cwd,
          ...(signal ? { signal } : {}),
          timeoutMs: 60_000,
          maxStdoutBytes: 64 * 1024 * 1024,
        },
      );
      entries = parseLineHistory(result.stdout, refs, path);
      const rawRecordCount = countHistoryRecords(result.stdout);
      if (rawRecordCount < rawScanLimit || entries.length >= targetEntryCount) break;
      const nextRawScanLimit = rawScanLimit * 2;
      if (!Number.isSafeInteger(nextRawScanLimit)) {
        throw new Error('Line history scan exceeds the supported range.');
      }
      rawScanLimit = nextRawScanLimit;
    }
    return {
      entries: entries.slice(0, LINE_HISTORY_LIMIT),
      truncated: entries.length > LINE_HISTORY_LIMIT,
    };
  }
}
