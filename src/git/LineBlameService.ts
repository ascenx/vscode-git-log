import { GitCommandError, type GitRunner } from './GitRunner';

const BLAME_HASH_PATTERN = /^[0-9a-f]{40,64}$/u;
const UNCOMMITTED_HASH = '0'.repeat(40);

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

function findRenamedHeadPath(output: Buffer, currentPath: string): string | undefined {
  const fields = output.toString('utf8').split('\0');
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) continue;
    const firstPath = fields[index++];
    if (!firstPath) continue;
    if (!status.startsWith('R') && !status.startsWith('C')) continue;
    const secondPath = fields[index++];
    if (secondPath === currentPath) return firstPath;
  }
  return undefined;
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
  constructor(private readonly runner: GitRunner) {}

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
      const previousPath = findRenamedHeadPath(changes.stdout, path);
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
