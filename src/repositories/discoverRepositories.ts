import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GitCommandError, type GitRunner } from '../git/GitRunner';
import type { GitOperationState, RepositorySummary } from '../shared/models';

export interface RepositoryDiscoveryOptions {
  scanDepth: number;
  excludedDirectoryNames?: readonly string[];
  excludePatterns?: readonly string[];
}

function globToRegExp(glob: string): RegExp {
  const normalized = glob.replaceAll('\\', '/').replace(/^\.\//u, '');
  let expression = '^';
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    const next = normalized[index + 1];
    if (character === '*' && next === '*') {
      if (normalized[index + 2] === '/') {
        expression += '(?:.*/)?';
        index += 2;
      } else {
        expression += '.*';
        index += 1;
      }
    } else if (character === '*') {
      expression += '[^/]*';
    } else if (character === '?') {
      expression += '[^/]';
    } else {
      expression += character?.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&') ?? '';
    }
  }
  return new RegExp(`${expression}$`, 'u');
}

function isExcludedPath(
  workspaceRoot: string,
  directory: string,
  patterns: readonly RegExp[],
): boolean {
  if (!patterns.length) return false;
  const relativePath = relative(workspaceRoot, directory).split(sep).join('/');
  if (!relativePath) return false;
  return patterns.some((pattern) => pattern.test(`${relativePath}/`) || pattern.test(relativePath));
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function hasBareRepositoryShape(directory: string): Promise<boolean> {
  const markers = ['HEAD', 'objects', 'refs'];
  const results = await Promise.all(markers.map((marker) => exists(join(directory, marker))));
  return results.every(Boolean);
}

async function collectCandidates(
  workspaceRoot: string,
  directory: string,
  depth: number,
  options: RepositoryDiscoveryOptions,
  candidates: Set<string>,
  excludePatterns: readonly RegExp[],
): Promise<void> {
  if (isExcludedPath(workspaceRoot, directory, excludePatterns)) return;
  const hasDotGit = await exists(join(directory, '.git'));
  const isBareCandidate = !hasDotGit && (await hasBareRepositoryShape(directory));

  if (hasDotGit || isBareCandidate) candidates.add(directory);
  if (isBareCandidate || depth >= options.scanDepth) return;

  const excluded = new Set(['.git', ...(options.excludedDirectoryNames ?? [])]);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !excluded.has(entry.name))
      .map((entry) =>
        collectCandidates(
          workspaceRoot,
          join(directory, entry.name),
          depth + 1,
          options,
          candidates,
          excludePatterns,
        ),
      ),
  );
}

export async function ensureSupportedGit(runner: GitRunner, cwd: string): Promise<string> {
  const result = await runner.run(['--version'], { cwd, timeoutMs: 10_000, maxStdoutBytes: 256 });
  const match = /git version (\d+)\.(\d+)(?:\.(\d+))?/u.exec(result.stdout.toString('utf8'));
  if (!match) throw new Error('Unable to determine the installed Git version.');
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3] ?? 0);
  if (major < 2 || (major === 2 && minor < 27)) {
    throw new Error(`Git 2.27 or newer is required; found ${major}.${minor}.${patch}.`);
  }
  return `${major}.${minor}.${patch}`;
}

async function runOptional(
  runner: GitRunner,
  args: readonly string[],
  cwd: string,
): Promise<string | undefined> {
  try {
    const result = await runner.run(args, { cwd, timeoutMs: 10_000 });
    return result.stdout.toString('utf8').trim();
  } catch (error) {
    if (error instanceof GitCommandError) return undefined;
    throw error;
  }
}

async function detectOperationState(gitDir: string): Promise<GitOperationState | undefined> {
  const [rebaseMerge, rebaseApply, merge, cherryPick, revert] = await Promise.all([
    exists(join(gitDir, 'rebase-merge')),
    exists(join(gitDir, 'rebase-apply')),
    exists(join(gitDir, 'MERGE_HEAD')),
    exists(join(gitDir, 'CHERRY_PICK_HEAD')),
    exists(join(gitDir, 'REVERT_HEAD')),
  ]);
  if (rebaseMerge || rebaseApply) return 'rebase';
  if (merge) return 'merge';
  if (cherryPick) return 'cherry-pick';
  if (revert) return 'revert';
  return undefined;
}

export async function inspectRepository(
  candidate: string,
  runner: GitRunner,
): Promise<RepositorySummary | undefined> {
  const repositoryInfo = await runOptional(
    runner,
    ['rev-parse', '--absolute-git-dir', '--is-bare-repository'],
    candidate,
  );
  if (!repositoryInfo) return undefined;

  const lines = repositoryInfo.split(/\r?\n/u);
  const gitDir = lines[0];
  const isBare = lines[1] === 'true';
  if (!gitDir) return undefined;

  const root = isBare
    ? resolve(candidate)
    : await runOptional(runner, ['rev-parse', '--show-toplevel'], candidate);
  if (!root) return undefined;

  const [currentBranch, head, commonGitDir, userName, userEmail] = await Promise.all([
    isBare
      ? Promise.resolve(undefined)
      : runOptional(runner, ['symbolic-ref', '--quiet', '--short', 'HEAD'], root),
    runOptional(runner, ['rev-parse', '--verify', 'HEAD'], root),
    runOptional(runner, ['rev-parse', '--git-common-dir'], root),
    runOptional(runner, ['config', '--get', 'user.name'], root),
    runOptional(runner, ['config', '--get', 'user.email'], root),
  ]);
  const operationState = isBare ? undefined : await detectOperationState(gitDir);
  const identity = `${resolve(root)}\0${resolve(gitDir)}`;

  return {
    id: createHash('sha256').update(identity).digest('hex').slice(0, 16),
    rootUri: pathToFileURL(root).toString(),
    gitDirUri: pathToFileURL(gitDir).toString(),
    ...(commonGitDir
      ? { commonGitDirUri: pathToFileURL(resolve(root, commonGitDir)).toString() }
      : {}),
    displayName: basename(root),
    isBare,
    ...(currentBranch ? { currentBranch } : {}),
    ...(head ? { head } : {}),
    ...(userName ? { userName } : {}),
    ...(userEmail ? { userEmail } : {}),
    ...(operationState ? { operationState } : {}),
  };
}

export async function discoverRepositories(
  workspaceRoots: readonly string[],
  runner: GitRunner,
  options: RepositoryDiscoveryOptions,
): Promise<RepositorySummary[]> {
  const candidates = new Set<string>();
  const excludePatterns = (options.excludePatterns ?? []).map(globToRegExp);
  await Promise.all(
    workspaceRoots.map((root) => {
      const resolvedRoot = resolve(root);
      return collectCandidates(resolvedRoot, resolvedRoot, 0, options, candidates, excludePatterns);
    }),
  );

  const inspected = await Promise.all(
    [...candidates].map((candidate) => inspectRepository(candidate, runner)),
  );
  const unique = new Map<string, RepositorySummary>();
  for (const repository of inspected) {
    if (repository) unique.set(repository.id, repository);
  }

  return [...unique.values()].sort((left, right) => left.rootUri.localeCompare(right.rootUri));
}
