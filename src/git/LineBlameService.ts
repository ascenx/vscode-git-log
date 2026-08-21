import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { GitCommandError, type GitRunner } from './GitRunner';

const BLAME_HASH_PATTERN = /^[0-9a-f]{40,64}$/u;
const UNCOMMITTED_HASH = '0'.repeat(40);
const MAX_RENAME_CANDIDATES = 512;
const MAX_SIMILAR_RENAME_CANDIDATES = 32;
const MAX_RENAME_CONTENT_BYTES = 2 * 1024 * 1024;
const MINIMUM_RENAME_SIMILARITY = 0.6;
const MINIMUM_RENAME_MATCHING_LINES = 3;
const MINIMUM_RENAME_SIMILARITY_MARGIN = 0.1;

export interface LineBlame {
  hash: string;
  authorName: string;
  authorEmail: string;
  authorTime: number;
  subject: string;
  committed: boolean;
}

export interface LineBlameOptions {
  content?: string;
  signal?: AbortSignal;
}

function parseLineBlame(output: Buffer): LineBlame | undefined {
  const lines = output.toString('utf8').split(/\r?\n/u);
  const header = lines[0]?.split(' ')[0]?.replace(/^\^/u, '');
  if (!header || !BLAME_HASH_PATTERN.test(header)) return undefined;

  const fields = new Map<string, string>();
  for (const line of lines.slice(1)) {
    if (!line || line.startsWith('\t')) continue;
    const separator = line.indexOf(' ');
    if (separator <= 0) continue;
    fields.set(line.slice(0, separator), line.slice(separator + 1));
  }

  const authorTime = Number.parseInt(fields.get('author-time') ?? '', 10);
  if (!Number.isFinite(authorTime)) return undefined;
  const authorEmail = fields.get('author-mail') ?? '';

  return {
    hash: header,
    authorName: fields.get('author') ?? 'Unknown author',
    authorEmail: authorEmail.replace(/^</u, '').replace(/>$/u, ''),
    authorTime,
    subject: fields.get('summary') ?? '',
    committed: !/^0+$/u.test(header),
  };
}

interface HeadPathChanges {
  renamedPath?: string;
  deletedPaths: string[];
}

function parseHeadPathChanges(output: Buffer, currentPath: string): HeadPathChanges {
  const result: HeadPathChanges = { deletedPaths: [] };
  const fields = output.toString('utf8').split('\0');
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) continue;
    const firstPath = fields[index++];
    if (!firstPath) continue;
    if (status.startsWith('R') || status.startsWith('C')) {
      const secondPath = fields[index++];
      if (secondPath === currentPath) result.renamedPath = firstPath;
      continue;
    }
    if (status.startsWith('D')) result.deletedPaths.push(firstPath);
  }
  return result;
}

interface TreeEntry {
  hash: string;
  path: string;
  type: string;
}

function parseTreeEntries(output: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const field of output.toString('utf8').split('\0')) {
    if (!field) continue;
    const tab = field.indexOf('\t');
    if (tab < 0) continue;
    const metadata = field.slice(0, tab).split(' ');
    const type = metadata[1];
    const hash = metadata[2];
    if (!type || !hash || !BLAME_HASH_PATTERN.test(hash)) continue;
    entries.push({ hash, path: field.slice(tab + 1), type });
  }
  return entries;
}

async function findCaseInsensitiveHeadPath(
  runner: GitRunner,
  cwd: string,
  path: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  const expectedSegments = path.split('/');
  const actualSegments: string[] = [];
  let treeish = 'HEAD';
  for (let index = 0; index < expectedSegments.length; index += 1) {
    const expectedSegment = expectedSegments[index];
    if (!expectedSegment) return undefined;
    const tree = await runner.run(['ls-tree', '-z', treeish], {
      cwd,
      ...(signal ? { signal } : {}),
      timeoutMs: 30_000,
      maxStdoutBytes: 4 * 1024 * 1024,
    });
    const matches = parseTreeEntries(tree.stdout).filter(
      (entry) => entry.path.toLowerCase() === expectedSegment.toLowerCase(),
    );
    if (matches.length !== 1) return undefined;
    const match = matches[0]!;
    const finalSegment = index === expectedSegments.length - 1;
    if (!finalSegment && match.type !== 'tree') return undefined;
    actualSegments.push(match.path);
    treeish = match.hash;
  }
  const actualPath = actualSegments.join('/');
  return actualPath !== path ? actualPath : undefined;
}

function prioritizeRenameCandidates(paths: readonly string[], currentPath: string): string[] {
  const currentExtension = extname(currentPath).toLowerCase();
  const currentDirectory = currentPath.includes('/')
    ? currentPath.slice(0, currentPath.lastIndexOf('/'))
    : '';
  return [...paths].sort((left, right) => {
    const score = (candidate: string): number => {
      const candidateDirectory = candidate.includes('/')
        ? candidate.slice(0, candidate.lastIndexOf('/'))
        : '';
      return (
        (extname(candidate).toLowerCase() === currentExtension ? 2 : 0) +
        (candidateDirectory === currentDirectory ? 1 : 0)
      );
    };
    return score(right) - score(left);
  });
}

function createComparableLines(content: Buffer): string[] | undefined {
  if (content.includes(0)) return undefined;
  return content
    .toString('utf8')
    .split(/\r\n|\r|\n/u)
    .filter((line) => line.length > 0);
}

function orderedLineSimilarity(
  expected: readonly string[],
  current: readonly string[],
): { similarity: number; matchingLines: number } {
  const positions = new Map<string, number[]>();
  for (let index = 0; index < expected.length; index += 1) {
    const line = expected[index]!;
    const linePositions = positions.get(line) ?? [];
    linePositions.push(index);
    positions.set(line, linePositions);
  }
  for (const [line, linePositions] of positions) {
    if (linePositions.length > 8) positions.delete(line);
  }

  const sequenceTails: number[] = [];
  for (const line of current) {
    const linePositions = positions.get(line);
    if (!linePositions) continue;
    for (let index = linePositions.length - 1; index >= 0; index -= 1) {
      const position = linePositions[index]!;
      let low = 0;
      let high = sequenceTails.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (sequenceTails[middle]! < position) low = middle + 1;
        else high = middle;
      }
      sequenceTails[low] = position;
    }
  }
  const matchingLines = sequenceTails.length;
  const maximumLines = Math.max(expected.length, current.length);
  return {
    similarity: maximumLines === 0 ? 1 : matchingLines / maximumLines,
    matchingLines,
  };
}

async function pathExistsWithExactCase(cwd: string, path: string): Promise<boolean> {
  try {
    let directory = resolve(cwd);
    for (const segment of path.split('/')) {
      if (!segment || segment === '.' || segment === '..') return false;
      const entries = await readdir(directory);
      if (!entries.includes(segment)) return false;
      directory = resolve(directory, segment);
    }
    return true;
  } catch {
    return false;
  }
}

async function loadCurrentContent(
  cwd: string,
  path: string,
  suppliedContent: string | undefined,
): Promise<Buffer | undefined> {
  if (suppliedContent !== undefined) {
    const content = Buffer.from(suppliedContent);
    return content.length <= MAX_RENAME_CONTENT_BYTES ? content : undefined;
  }
  const absolutePath = resolve(cwd, path);
  const relativePath = relative(cwd, absolutePath);
  if (
    !relativePath ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return undefined;
  }
  const fileStat = await stat(absolutePath);
  if (!fileStat.isFile() || fileStat.size > MAX_RENAME_CONTENT_BYTES) return undefined;
  return readFile(absolutePath);
}

function uncommittedLine(): LineBlame {
  return {
    hash: UNCOMMITTED_HASH,
    authorName: '',
    authorEmail: '',
    authorTime: 0,
    subject: '',
    committed: false,
  };
}

export class LineBlameService {
  private readonly ignoreCaseRepositories = new Map<string, boolean>();
  private readonly caseInsensitivePaths = new Map<string, string | undefined>();

  constructor(private readonly runner: GitRunner) {}

  invalidate(cwd?: string): void {
    if (cwd === undefined) {
      this.ignoreCaseRepositories.clear();
      this.caseInsensitivePaths.clear();
      return;
    }
    this.ignoreCaseRepositories.delete(cwd);
    for (const key of this.caseInsensitivePaths.keys()) {
      if (key.startsWith(`${cwd}\0`)) this.caseInsensitivePaths.delete(key);
    }
  }

  private async repositoryIgnoresCase(
    cwd: string,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    const cached = this.ignoreCaseRepositories.get(cwd);
    if (cached !== undefined) return cached;
    try {
      const result = await this.runner.run(['config', '--bool', '--get', 'core.ignorecase'], {
        cwd,
        ...(signal ? { signal } : {}),
        timeoutMs: 30_000,
        maxStdoutBytes: 1024,
      });
      const ignoresCase = result.stdout.toString('utf8').trim() === 'true';
      this.ignoreCaseRepositories.set(cwd, ignoresCase);
      return ignoresCase;
    } catch (error) {
      if (error instanceof GitCommandError && !error.cancelled) {
        this.ignoreCaseRepositories.set(cwd, false);
        return false;
      }
      throw error;
    }
  }

  private async resolveCaseInsensitivePath(
    cwd: string,
    path: string,
    signal: AbortSignal | undefined,
  ): Promise<string | undefined> {
    const key = `${cwd}\0${path.toLowerCase()}`;
    if (this.caseInsensitivePaths.has(key)) return this.caseInsensitivePaths.get(key);
    const resolvedPath = await findCaseInsensitiveHeadPath(this.runner, cwd, path, signal);
    this.caseInsensitivePaths.set(key, resolvedPath);
    while (this.caseInsensitivePaths.size > MAX_RENAME_CANDIDATES) {
      const oldestKey = this.caseInsensitivePaths.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.caseInsensitivePaths.delete(oldestKey);
    }
    return resolvedPath;
  }

  async getLineBlame(
    cwd: string,
    path: string,
    line: number,
    options: LineBlameOptions = {},
  ): Promise<LineBlame | undefined> {
    if (!path || path.includes('\0')) throw new Error('Invalid repository path.');
    if (!Number.isSafeInteger(line) || line < 1)
      throw new Error(`Invalid blame line: ${String(line)}`);

    const args = ['blame', '--line-porcelain'];
    if (options.content !== undefined) args.push('--contents', '-');
    args.push('-L', `${String(line)},${String(line)}`, '--', path);
    try {
      const result = await this.runner.run(args, {
        cwd,
        ...(options.content !== undefined ? { input: options.content } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        timeoutMs: 30_000,
        maxStdoutBytes: 256 * 1024,
      });
      return parseLineBlame(result.stdout);
    } catch (error) {
      if (!(error instanceof GitCommandError) || error.cancelled) throw error;
      const stderr = error.stderr.toString('utf8');
      if (/no such ref: head/iu.test(stderr)) return uncommittedLine();
      if (!/no such path .+ in head/iu.test(stderr)) throw error;

      const changes = await this.runner.run(
        ['diff', '--name-status', '-z', '--find-renames', 'HEAD', '--'],
        {
          cwd,
          ...(options.signal ? { signal: options.signal } : {}),
          timeoutMs: 30_000,
          maxStdoutBytes: 4 * 1024 * 1024,
        },
      );
      const pathChanges = parseHeadPathChanges(changes.stdout, path);
      let previousPath = pathChanges.renamedPath;
      if (!previousPath && (await this.repositoryIgnoresCase(cwd, options.signal))) {
        const casePath = await this.resolveCaseInsensitivePath(cwd, path, options.signal);
        if (
          casePath &&
          (await pathExistsWithExactCase(cwd, path)) &&
          !(await pathExistsWithExactCase(cwd, casePath))
        ) {
          previousPath = casePath;
        }
      }
      if (!previousPath && pathChanges.deletedPaths.length > 0) {
        const hashResult = await this.runner.run(
          options.content !== undefined ? ['hash-object', '--stdin'] : ['hash-object', '--', path],
          {
            cwd,
            ...(options.content !== undefined ? { input: options.content } : {}),
            ...(options.signal ? { signal: options.signal } : {}),
            timeoutMs: 30_000,
            maxStdoutBytes: 1024,
          },
        );
        const currentHash = hashResult.stdout.toString('utf8').trim();
        const completeCandidateSet =
          pathChanges.deletedPaths.length <= MAX_RENAME_CANDIDATES;
        const candidates = prioritizeRenameCandidates(pathChanges.deletedPaths, path).slice(
          0,
          MAX_RENAME_CANDIDATES,
        );
        const tree = await this.runner.run(['ls-tree', '-r', '-z', 'HEAD', '--', ...candidates], {
          cwd,
          env: { GIT_LITERAL_PATHSPECS: '1' },
          ...(options.signal ? { signal: options.signal } : {}),
          timeoutMs: 30_000,
          maxStdoutBytes: 4 * 1024 * 1024,
        });
        const matchingPaths = parseTreeEntries(tree.stdout)
          .filter((entry) => entry.hash === currentHash)
          .map((entry) => entry.path);
        if (completeCandidateSet && matchingPaths.length === 1) previousPath = matchingPaths[0];
        if (
          !previousPath &&
          completeCandidateSet &&
          candidates.length <= MAX_SIMILAR_RENAME_CANDIDATES
        ) {
          const currentContent = await loadCurrentContent(cwd, path, options.content);
          const currentLines = currentContent ? createComparableLines(currentContent) : undefined;
          if (currentLines) {
            let bestPath: string | undefined;
            let bestSimilarity = 0;
            let bestMatchingLines = 0;
            let secondBestSimilarity = 0;
            let evaluationIncomplete = false;
            const similarityPaths = new Set(candidates.slice(0, MAX_SIMILAR_RENAME_CANDIDATES));
            const entries = parseTreeEntries(tree.stdout).filter((entry) =>
              similarityPaths.has(entry.path),
            );
            for (const entry of entries) {
              try {
                const blob = await this.runner.run(['cat-file', 'blob', entry.hash], {
                  cwd,
                  ...(options.signal ? { signal: options.signal } : {}),
                  timeoutMs: 30_000,
                  maxStdoutBytes: MAX_RENAME_CONTENT_BYTES,
                });
                const candidateLines = createComparableLines(blob.stdout);
                if (!candidateLines) {
                  evaluationIncomplete = true;
                  break;
                }
                const { similarity, matchingLines } = orderedLineSimilarity(
                  candidateLines,
                  currentLines,
                );
                if (similarity > bestSimilarity) {
                  secondBestSimilarity = bestSimilarity;
                  bestPath = entry.path;
                  bestSimilarity = similarity;
                  bestMatchingLines = matchingLines;
                } else if (similarity > secondBestSimilarity) {
                  secondBestSimilarity = similarity;
                }
              } catch (error) {
                if (error instanceof GitCommandError && !error.cancelled) {
                  evaluationIncomplete = true;
                  break;
                }
                throw error;
              }
            }
            if (
              !evaluationIncomplete &&
              bestSimilarity >= MINIMUM_RENAME_SIMILARITY &&
              bestMatchingLines >= MINIMUM_RENAME_MATCHING_LINES &&
              bestSimilarity - secondBestSimilarity >= MINIMUM_RENAME_SIMILARITY_MARGIN
            ) {
              previousPath = bestPath;
            }
          }
        }
      }
      if (!previousPath) return uncommittedLine();

      const renamedArgs = [
        'blame',
        '--line-porcelain',
        '--contents',
        options.content !== undefined ? '-' : path,
        '-L',
        `${String(line)},${String(line)}`,
        '--',
        previousPath,
      ];
      const renamed = await this.runner.run(renamedArgs, {
        cwd,
        ...(options.content !== undefined ? { input: options.content } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        timeoutMs: 30_000,
        maxStdoutBytes: 256 * 1024,
      });
      return parseLineBlame(renamed.stdout);
    }
  }
}
