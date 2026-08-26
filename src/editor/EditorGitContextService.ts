import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { GitRunner } from '../git/GitRunner';
import { inspectRepository } from '../repositories/discoverRepositories';
import type { RepositorySummary } from '../shared/models';

export interface EditorGitContext {
  repository: RepositorySummary;
  repositoryRoot: string;
  repositoryPath: string;
  absolutePath: string;
}

async function canonicalizePathAllowingMissingLeaf(path: string): Promise<string> {
  let candidate = path;
  const missingSegments: string[] = [];
  while (true) {
    try {
      return resolve(await realpath(candidate), ...missingSegments);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      missingSegments.unshift(basename(candidate));
      candidate = parent;
    }
  }
}

export class EditorGitContextService {
  constructor(private readonly runner: GitRunner) {}

  async resolve(filePath: string): Promise<EditorGitContext> {
    return this.resolveResource(filePath, dirname(resolve(filePath)), false);
  }

  async resolveDirectory(directoryPath: string): Promise<EditorGitContext> {
    const absolutePath = resolve(directoryPath);
    return this.resolveResource(absolutePath, absolutePath, true);
  }

  private async resolveResource(
    resourcePath: string,
    repositorySearchPath: string,
    allowRepositoryRoot: boolean,
  ): Promise<EditorGitContext> {
    const absolutePath = resolve(resourcePath);
    const repository = await inspectRepository(repositorySearchPath, this.runner);
    if (!repository || repository.isBare) {
      throw new Error('The selected resource is not inside a Git working tree.');
    }
    const repositoryRoot = await realpath(fileURLToPath(repository.rootUri));
    const canonicalResourcePath = await canonicalizePathAllowingMissingLeaf(absolutePath);
    const relativePath = relative(repositoryRoot, canonicalResourcePath);
    if (
      (!relativePath && !allowRepositoryRoot) ||
      relativePath === '..' ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      throw new Error('The selected resource is outside the resolved Git working tree.');
    }
    return {
      repository,
      repositoryRoot,
      repositoryPath: relativePath ? relativePath.split(sep).join('/') : '.',
      absolutePath,
    };
  }
}
