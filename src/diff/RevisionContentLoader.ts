import type { GitService } from '../git/GitService';
import type { RepositoryRegistry } from '../repositories/RepositoryRegistry';
import type { RevisionQuery } from './diffModel';

export class RevisionContentLoader {
  constructor(
    private readonly repositories: RepositoryRegistry,
    private readonly git: GitService,
    private readonly maximumBytes: number,
  ) {}

  async load(query: RevisionQuery, signal?: AbortSignal): Promise<string> {
    const root = this.repositories.getRoot(query.repositoryId);
    if (!root) throw new Error(`Unknown repository: ${query.repositoryId}`);
    if (query.empty) return '';

    const size = await this.git.getFileSize(root, query.revision, query.path, signal);
    if (size > this.maximumBytes) {
      throw new Error(
        `File is too large for the built-in revision viewer (${String(size)} bytes).`,
      );
    }
    const content = await this.git.getFileContent(
      root,
      query.revision,
      query.path,
      signal,
      this.maximumBytes,
    );
    if (content.includes(0)) throw new Error(`Binary file cannot be opened as text: ${query.path}`);
    return content.toString('utf8');
  }
}
