import { fileURLToPath } from 'node:url';
import { normalize } from 'node:path';
import type { GitOperationRequest } from '../protocol/messages';
import type { RepositorySummary } from '../shared/models';
import { inspectRepository } from '../repositories/discoverRepositories';
import { GitCommandError, type GitRunner } from './GitRunner';

export interface GitOperationResult {
  message: string;
  cancelled?: boolean;
}

export interface GitOperationRunOptions {
  confirm?(confirmation: OperationConfirmation): Promise<boolean>;
}

export interface GitOperationServiceOptions {
  inspectRepository?(repository: RepositorySummary): Promise<RepositorySummary | undefined>;
}

export interface OperationConfirmation {
  title: string;
  detail: string;
  confirmLabel: string;
  destructive: true;
}

function validateToken(value: string, label: string): string {
  if (!value || value.startsWith('-') || /[\0\r\n]/u.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return value;
}

function validateHash(value: string): string {
  if (!/^[0-9a-f]{4,64}$/iu.test(value)) throw new Error(`Invalid commit hash: ${value}`);
  return value;
}

export function buildOperationArguments(
  operation: GitOperationRequest,
  forceSourceHash?: string,
): string[] {
  switch (operation.kind) {
    case 'checkout':
      return ['checkout', validateToken(operation.ref, 'revision'), '--'];
    case 'createBranch':
      return [
        'branch',
        '--',
        validateToken(operation.name, 'branch name'),
        validateToken(operation.startPoint, 'start point'),
      ];
    case 'createTag':
      return [
        'tag',
        '--',
        validateToken(operation.name, 'tag name'),
        validateToken(operation.target, 'tag target'),
      ];
    case 'deleteTag':
      return ['tag', '-d', '--', validateToken(operation.name, 'tag name')];
    case 'checkoutRemote':
      return [
        'checkout',
        '-b',
        validateToken(operation.name, 'branch name'),
        '--track',
        validateToken(operation.startPoint, 'remote branch'),
      ];
    case 'deleteRemoteBranch':
      return [
        'push',
        validateToken(operation.remote, 'remote'),
        '--delete',
        `refs/heads/${validateToken(operation.branch, 'remote branch')}`,
      ];
    case 'fetch':
      return operation.remote
        ? ['fetch', validateToken(operation.remote, 'remote')]
        : ['fetch', '--all', '--prune'];
    case 'pull':
      return ['pull'];
    case 'push':
      if (operation.forceWithLease) {
        if (!operation.remote || !operation.targetRef || !forceSourceHash) {
          throw new Error('Force push target must be resolved before execution.');
        }
        return [
          'push',
          `--force-with-lease=${validateToken(operation.targetRef, 'push target')}`,
          validateToken(operation.remote, 'push remote'),
          `${validateHash(forceSourceHash)}:${validateToken(operation.targetRef, 'push target')}`,
        ];
      }
      return ['push'];
    case 'cherryPick':
      return ['cherry-pick', validateHash(operation.hash)];
    case 'revert':
      return ['revert', '--no-edit', validateHash(operation.hash)];
    case 'merge':
      return ['merge', '--no-edit', validateToken(operation.ref, 'merge ref')];
    case 'rebase':
      return ['rebase', validateToken(operation.ref, 'rebase ref')];
    case 'reset':
      return ['reset', `--${operation.mode}`, validateHash(operation.hash), '--'];
    case 'renameBranch':
      return [
        'branch',
        '-m',
        '--',
        validateToken(operation.oldName, 'branch name'),
        validateToken(operation.newName, 'branch name'),
      ];
    case 'deleteBranch':
      return [
        'branch',
        operation.force ? '-D' : '-d',
        '--',
        validateToken(operation.name, 'branch name'),
      ];
    case 'dropCommits':
    case 'squashCommits':
      throw new Error(`${operation.kind} requires a validated history rewrite plan.`);
  }
}

export function getOperationConfirmation(
  repository: RepositorySummary,
  operation: GitOperationRequest,
): OperationConfirmation | undefined {
  if (operation.kind === 'reset' && operation.mode === 'hard') {
    return {
      title: 'Hard reset current branch?',
      detail: `Repository “${repository.displayName}” will be hard reset to ${operation.hash}. Uncommitted changes can be lost.`,
      confirmLabel: 'Hard Reset',
      destructive: true,
    };
  }
  if (operation.kind === 'deleteBranch') {
    return {
      title: `Delete branch “${operation.name}”?`,
      detail: `Repository “${repository.displayName}” will delete local branch “${operation.name}”${operation.force ? ' even if it is not merged' : ''}.`,
      confirmLabel: operation.force ? 'Force Delete Branch' : 'Delete Branch',
      destructive: true,
    };
  }
  if (operation.kind === 'deleteRemoteBranch') {
    return {
      title: `Delete remote branch “${operation.remote}/${operation.branch}”?`,
      detail: `Repository “${repository.displayName}” will delete remote branch “${operation.remote}/${operation.branch}”. Other users may depend on it.`,
      confirmLabel: 'Delete Remote Branch',
      destructive: true,
    };
  }
  if (operation.kind === 'deleteTag') {
    return {
      title: `Delete tag “${operation.name}”?`,
      detail: `Repository “${repository.displayName}” will delete local tag “${operation.name}”.`,
      confirmLabel: 'Delete Tag',
      destructive: true,
    };
  }
  if (operation.kind === 'push' && operation.forceWithLease) {
    const target =
      operation.remote && operation.targetRef
        ? `${operation.remote}/${operation.targetRef}`
        : 'an unresolved remote branch';
    return {
      title: 'Force push with lease?',
      detail: `Repository “${repository.displayName}” will rewrite ${target} if its lease still matches.`,
      confirmLabel: 'Force Push with Lease',
      destructive: true,
    };
  }
  if (operation.kind === 'dropCommits' || operation.kind === 'squashCommits') {
    const count = operation.hashes.length;
    return {
      title: operation.kind === 'dropCommits' ? `Drop ${String(count)} commits?` : `Squash ${String(count)} commits?`,
      detail:
        operation.kind === 'dropCommits'
          ? `Repository “${repository.displayName}” will remove ${String(count)} commits from the current branch and rewrite newer commits.`
          : `Repository “${repository.displayName}” will combine ${String(count)} commits and rewrite newer commits.`,
      confirmLabel: operation.kind === 'dropCommits' ? 'Drop Commits' : 'Squash Commits',
      destructive: true,
    };
  }
  return undefined;
}

interface CommitRangeRewritePlan {
  cwd: string;
  branch: string;
  expectedHead: string;
  newest: string;
  oldest: string;
  baseParent: string;
}

export class GitOperationService {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly inspect: (
    repository: RepositorySummary,
  ) => Promise<RepositorySummary | undefined>;

  constructor(
    private readonly runner: GitRunner,
    options: GitOperationServiceOptions = {},
  ) {
    this.inspect =
      options.inspectRepository ??
      ((repository) => inspectRepository(fileURLToPath(repository.rootUri), this.runner));
  }

  async resolvePushTarget(
    repository: RepositorySummary,
  ): Promise<{ remote: string; targetRef: string }> {
    const plan = await this.resolvePushPlan(repository);
    return { remote: plan.remote, targetRef: plan.targetRef };
  }

  private async resolvePushPlan(
    repository: RepositorySummary,
  ): Promise<{ remote: string; targetRef: string; sourceRef: string }> {
    if (repository.isBare) throw new Error(`Bare repository “${repository.displayName}” is read-only.`);
    const cwd = fileURLToPath(repository.rootUri);
    const branch = repository.currentBranch;
    if (!branch) throw new Error('Force push is unavailable while HEAD is detached.');
    const readConfig = async (key: string): Promise<string | undefined> => {
      try {
        const result = await this.runner.run(['config', '--get', key], { cwd, timeoutMs: 30_000 });
        return result.stdout.toString('utf8').trim() || undefined;
      } catch (error) {
        if (error instanceof GitCommandError && error.exitCode === 1 && !error.cancelled) {
          return undefined;
        }
        throw error;
      }
    };
    const readAllConfig = async (key: string): Promise<string[]> => {
      try {
        const result = await this.runner.run(['config', '--get-all', key], {
          cwd,
          timeoutMs: 30_000,
        });
        return result.stdout.toString('utf8').split(/\r?\n/u).filter(Boolean);
      } catch (error) {
        if (error instanceof GitCommandError && error.exitCode === 1 && !error.cancelled) return [];
        throw error;
      }
    };
    const pushRemote = await readConfig(`branch.${branch}.pushRemote`);
    const defaultRemote = await readConfig('remote.pushDefault');
    const upstreamRemote = await readConfig(`branch.${branch}.remote`);
    let remote = pushRemote ?? defaultRemote ?? upstreamRemote;
    if (!remote) {
      const remotesResult = await this.runner.run(['remote'], { cwd, timeoutMs: 30_000 });
      const remotes = remotesResult.stdout.toString('utf8').split(/\r?\n/u).filter(Boolean);
      remote = remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : undefined;
    }
    if (!remote) throw new Error('Git could not resolve a unique push remote.');
    if (remote === '.') throw new Error('Force push to the local repository is not supported.');
    if ((await readConfig(`remote.${remote}.mirror`)) === 'true') {
      throw new Error(`Force push is unavailable because remote “${remote}” is configured as a mirror.`);
    }

    const configuredRefspecs = await readAllConfig(`remote.${remote}.push`);
    if (configuredRefspecs.length > 1) {
      throw new Error(`Force push is unavailable because remote “${remote}” has multiple push refspecs.`);
    }
    if (configuredRefspecs[0]) {
      return this.parseConfiguredPushRefspec(remote, configuredRefspecs[0]);
    }

    const pushDefault = (await readConfig('push.default')) ?? 'simple';
    const upstreamRef = await readConfig(`branch.${branch}.merge`);
    const autoSetupRemote = (await readConfig('push.autoSetupRemote')) === 'true';
    let targetRef: string;
    switch (pushDefault) {
      case 'nothing':
        throw new Error('push.default is set to nothing.');
      case 'matching':
        throw new Error('Force push target is ambiguous when push.default is matching.');
      case 'current':
        targetRef = `refs/heads/${branch}`;
        break;
      case 'upstream':
      case 'tracking':
        if (!upstreamRemote || !upstreamRef) {
          throw new Error(`Branch “${branch}” has no upstream push target.`);
        }
        if (remote !== upstreamRemote) {
          throw new Error(
            `${pushDefault} push is unavailable because push remote “${remote}” differs from upstream remote “${upstreamRemote}”.`,
          );
        }
        targetRef = upstreamRef;
        break;
      case 'simple':
        if (!upstreamRemote || !upstreamRef) {
          if (!autoSetupRemote) throw new Error(`Branch “${branch}” has no upstream push target.`);
          targetRef = `refs/heads/${branch}`;
          break;
        }
        if (remote !== upstreamRemote) {
          targetRef = `refs/heads/${branch}`;
          break;
        }
        if (upstreamRef !== `refs/heads/${branch}`) {
          throw new Error(
            `Simple push is blocked because local branch “${branch}” differs from upstream “${upstreamRef.replace(/^refs\/heads\//u, '')}”.`,
          );
        }
        targetRef = upstreamRef;
        break;
      default:
        throw new Error(`Unsupported push.default mode: ${pushDefault}`);
    }
    return {
      remote: validateToken(remote, 'push remote'),
      targetRef: validateToken(targetRef, 'push target'),
      sourceRef: 'HEAD',
    };
  }

  run(
    repository: RepositorySummary,
    operation: GitOperationRequest,
    options: GitOperationRunOptions = {},
  ): Promise<GitOperationResult> {
    if (repository.isBare) {
      return Promise.reject(new Error(`Bare repository “${repository.displayName}” is read-only.`));
    }
    const queueKey = this.getQueueKey(repository);
    const previous = this.queues.get(queueKey) ?? Promise.resolve();
    const execution = previous
      .catch(() => undefined)
      .then(async () => {
        const freshRepository = await this.inspect(repository);
        if (!freshRepository) throw new Error(`Repository “${repository.displayName}” is unavailable.`);
        if (freshRepository.operationState && operation.kind !== 'fetch') {
          throw new Error(
            `A Git ${freshRepository.operationState} is in progress; finish or abort it first.`,
          );
        }
        if (operation.kind === 'deleteRemoteBranch') {
          await this.validateRemoteBranchDeletion(freshRepository, operation.remote, operation.branch);
        }
        let rewritePlan: CommitRangeRewritePlan | undefined;
        if (operation.kind === 'dropCommits' || operation.kind === 'squashCommits') {
          rewritePlan = await this.planCommitRangeRewrite(freshRepository, operation.hashes);
        }
        let preparedOperation = operation;
        let forceSourceHash: string | undefined;
        if (operation.kind === 'push' && operation.forceWithLease) {
          const plan = await this.resolvePushPlan(freshRepository);
          preparedOperation = {
            ...operation,
            remote: plan.remote,
            targetRef: plan.targetRef,
          };
          const source = await this.runner.run(
            ['rev-parse', '--verify', '--end-of-options', `${plan.sourceRef}^{commit}`],
            { cwd: fileURLToPath(freshRepository.rootUri), timeoutMs: 30_000 },
          );
          forceSourceHash = source.stdout.toString('utf8').trim();
        }
        const confirmation = getOperationConfirmation(freshRepository, preparedOperation);
        if (confirmation) {
          if (!options.confirm) {
            throw new Error('This destructive Git operation requires confirmation.');
          }
          if (!(await options.confirm(confirmation))) return { message: '', cancelled: true };
        }
        if (rewritePlan) {
          if (operation.kind !== 'dropCommits' && operation.kind !== 'squashCommits') {
            throw new Error('Invalid commit history rewrite operation.');
          }
          await this.assertRewritePlanStillCurrent(rewritePlan);
          const revalidatedPlan = await this.planCommitRangeRewrite(
            freshRepository,
            operation.hashes,
          );
          if (
            revalidatedPlan.branch !== rewritePlan.branch ||
            revalidatedPlan.expectedHead !== rewritePlan.expectedHead ||
            revalidatedPlan.baseParent !== rewritePlan.baseParent
          ) {
            throw new Error(
              'The current branch or HEAD changed during confirmation; select the commits again.',
            );
          }
          rewritePlan = revalidatedPlan;
        }
        if (rewritePlan && preparedOperation.kind === 'dropCommits') {
          await this.rebaseCommitRange(rewritePlan, rewritePlan.baseParent);
        } else if (rewritePlan && preparedOperation.kind === 'squashCommits') {
          const squashedHash = await this.createSquashedCommit(
            rewritePlan,
            preparedOperation.message,
          );
          await this.rebaseCommitRange(rewritePlan, squashedHash);
        } else {
          await this.runner.run(buildOperationArguments(preparedOperation, forceSourceHash), {
            cwd: fileURLToPath(freshRepository.rootUri),
            timeoutMs: 10 * 60_000,
          });
        }
        return { message: `${operation.kind} completed.` };
      });
    const tail = execution.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(queueKey, tail);
    void tail.finally(() => {
      if (this.queues.get(queueKey) === tail) this.queues.delete(queueKey);
    });
    return execution;
  }

  private getQueueKey(repository: RepositorySummary): string {
    const path = normalize(fileURLToPath(repository.commonGitDirUri ?? repository.gitDirUri));
    return process.platform === 'win32' ? path.toLowerCase() : path;
  }

  private async planCommitRangeRewrite(
    repository: RepositorySummary,
    requestedHashes: readonly string[],
  ): Promise<CommitRangeRewritePlan> {
    const cwd = fileURLToPath(repository.rootUri);
    const branchResult = await this.runner.run(['branch', '--show-current'], {
      cwd,
      timeoutMs: 30_000,
    });
    const branch = branchResult.stdout.toString('utf8').trim();
    if (!branch) throw new Error('Commit history rewriting is unavailable while HEAD is detached.');
    const hashes = requestedHashes.map(validateHash);
    if (hashes.length < 2 || hashes.length > 100 || new Set(hashes).size !== hashes.length) {
      throw new Error('Select between 2 and 100 unique commits.');
    }
    const newest = hashes[0];
    const oldest = hashes.at(-1);
    if (!newest || !oldest) throw new Error('Select between 2 and 100 unique commits.');
    const status = await this.runner.run(['status', '--porcelain=v1', '-z'], {
      cwd,
      timeoutMs: 30_000,
    });
    if (status.stdout.length > 0) {
      throw new Error('Drop and squash require a clean worktree. Commit or stash changes first.');
    }
    const historyResult = await this.runner.run(['rev-list', '--first-parent', '--parents', 'HEAD'], {
      cwd,
      timeoutMs: 30_000,
    });
    const historyLines = historyResult.stdout
      .toString('utf8')
      .trim()
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => line.split(/\s+/u));
    const history = historyLines.map(([hash]) => hash).filter((hash): hash is string => Boolean(hash));
    const expectedHead = history[0];
    if (!expectedHead) throw new Error('The current branch has no commits to rewrite.');
    const newestIndex = history.indexOf(newest);
    if (
      newestIndex < 0 ||
      hashes.some((hash, index) => history[newestIndex + index] !== hash)
    ) {
      throw new Error('Selected commits must be contiguous on the current branch first-parent history.');
    }
    const oldestIndex = newestIndex + hashes.length - 1;
    if (oldestIndex >= history.length - 1) {
      throw new Error('The root commit cannot be dropped or squashed.');
    }
    const baseParent = history[oldestIndex + 1];
    if (!baseParent) throw new Error('The root commit cannot be dropped or squashed.');
    if (historyLines.slice(0, oldestIndex + 1).some((line) => line.length !== 2)) {
      throw new Error('Commit history rewriting is unavailable across merge commits.');
    }
    return {
      cwd,
      branch: validateToken(branch, 'branch name'),
      expectedHead,
      newest,
      oldest,
      baseParent,
    };
  }

  private async assertRewritePlanStillCurrent(plan: CommitRangeRewritePlan): Promise<void> {
    const [branchResult, headResult, statusResult] = await Promise.all([
      this.runner.run(['branch', '--show-current'], { cwd: plan.cwd, timeoutMs: 30_000 }),
      this.runner.run(['rev-parse', '--verify', 'HEAD'], { cwd: plan.cwd, timeoutMs: 30_000 }),
      this.runner.run(['status', '--porcelain=v1', '-z'], {
        cwd: plan.cwd,
        timeoutMs: 30_000,
      }),
    ]);
    const branch = branchResult.stdout.toString('utf8').trim();
    const head = headResult.stdout.toString('utf8').trim();
    if (branch !== plan.branch || head !== plan.expectedHead) {
      throw new Error('The current branch or HEAD changed during confirmation; select the commits again.');
    }
    if (statusResult.stdout.length > 0) {
      throw new Error('The worktree changed during confirmation; commit or stash changes first.');
    }
  }

  private async createSquashedCommit(
    plan: CommitRangeRewritePlan,
    message: string,
  ): Promise<string> {
    if (!message.trim() || message.length > 100_000 || message.includes('\0')) {
      throw new Error('The squash commit message is invalid.');
    }
    const treeResult = await this.runner.run(['rev-parse', `${plan.newest}^{tree}`], {
      cwd: plan.cwd,
      timeoutMs: 30_000,
    });
    const authorResult = await this.runner.run(
      ['show', '-s', '--format=%an%x00%ae%x00%aI', plan.oldest, '--'],
      { cwd: plan.cwd, timeoutMs: 30_000 },
    );
    const [authorName, authorEmail, authorDate] = authorResult.stdout
      .toString('utf8')
      .replace(/\r?\n$/u, '')
      .split('\0');
    const commitResult = await this.runner.run(
      ['commit-tree', treeResult.stdout.toString('utf8').trim(), '-p', plan.baseParent],
      {
        cwd: plan.cwd,
        timeoutMs: 30_000,
        input: message.endsWith('\n') ? message : `${message}\n`,
        env: {
          GIT_AUTHOR_NAME: authorName,
          GIT_AUTHOR_EMAIL: authorEmail,
          GIT_AUTHOR_DATE: authorDate,
        },
      },
    );
    return validateHash(commitResult.stdout.toString('utf8').trim());
  }

  private async rebaseCommitRange(
    plan: CommitRangeRewritePlan,
    newBase: string,
  ): Promise<void> {
    await this.assertRewritePlanStillCurrent(plan);
    await this.runner.run(
      [
        '-c',
        'rebase.updateRefs=false',
        '-c',
        'rebase.autoStash=false',
        'rebase',
        '--onto',
        validateHash(newBase),
        plan.newest,
      ],
      { cwd: plan.cwd, timeoutMs: 10 * 60_000 },
    );
  }

  private async validateRemoteBranchDeletion(
    repository: RepositorySummary,
    remote: string,
    branch: string,
  ): Promise<void> {
    const cwd = fileURLToPath(repository.rootUri);
    const validatedRemote = validateToken(remote, 'remote');
    const validatedBranch = validateToken(branch, 'remote branch');
    const remotesResult = await this.runner.run(['remote'], { cwd, timeoutMs: 30_000 });
    const remotes = remotesResult.stdout.toString('utf8').split(/\r?\n/u).filter(Boolean);
    if (!remotes.includes(validatedRemote)) {
      throw new Error(`Remote “${validatedRemote}” is not a configured remote.`);
    }
    await this.runner.run(['check-ref-format', '--branch', validatedBranch], {
      cwd,
      timeoutMs: 30_000,
      maxStdoutBytes: 4096,
    });
    try {
      await this.runner.run(
        ['show-ref', '--verify', '--quiet', `refs/remotes/${validatedRemote}/${validatedBranch}`],
        { cwd, timeoutMs: 30_000, maxStdoutBytes: 4096 },
      );
    } catch (error) {
      if (error instanceof GitCommandError && error.exitCode === 1 && !error.cancelled) {
        throw new Error(
          `Remote branch “${validatedRemote}/${validatedBranch}” is not tracked locally.`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  private parseConfiguredPushRefspec(
    remote: string,
    configuredRefspec: string,
  ): { remote: string; targetRef: string; sourceRef: string } {
    const refspec = configuredRefspec.startsWith('+')
      ? configuredRefspec.slice(1)
      : configuredRefspec;
    if (!refspec || refspec.startsWith('^') || refspec.includes('*')) {
      throw new Error(`Force push does not support push refspec “${configuredRefspec}”.`);
    }
    const separator = refspec.indexOf(':');
    if (separator <= 0 || separator !== refspec.lastIndexOf(':')) {
      throw new Error(
        `Force push requires a fully qualified destination in push refspec “${configuredRefspec}”.`,
      );
    }
    const source = separator >= 0 ? refspec.slice(0, separator) : refspec;
    const destination = separator >= 0 ? refspec.slice(separator + 1) : refspec;
    if (!source || !destination || destination.includes(':')) {
      throw new Error(`Force push does not support push refspec “${configuredRefspec}”.`);
    }
    if (!destination.startsWith('refs/')) {
      throw new Error(
        `Force push requires a fully qualified destination in push refspec “${configuredRefspec}”.`,
      );
    }
    const targetRef = destination;
    if (!targetRef.startsWith('refs/heads/')) {
      throw new Error(`Force push only supports branch destinations, not “${targetRef}”.`);
    }
    return {
      remote: validateToken(remote, 'push remote'),
      targetRef: validateToken(targetRef, 'push target'),
      sourceRef: validateToken(source, 'push source'),
    };
  }
}
