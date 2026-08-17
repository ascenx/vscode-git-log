import type { GitService } from '../git/GitService';
import type { RefLabel, RepositorySummary } from '../shared/models';
import type { EditorGitContextService } from './EditorGitContextService';

export interface EditorRefPickItem {
  label: string;
  description: string;
  detail: string;
  ref: RefLabel;
}

export interface EditorRefPickGroup {
  label: string;
  items: EditorRefPickItem[];
}

export interface EditorFileComparisonHost {
  getActiveFile(): { fsPath: string; workingContent?: string } | undefined;
  pickRef(groups: readonly EditorRefPickGroup[]): Promise<RefLabel | undefined>;
  showErrorMessage(message: string): void;
}

export interface FileComparisonRequest {
  repository: RepositorySummary;
  cwd: string;
  revision: string;
  revisionLabel: string;
  path: string;
  workingContent?: string;
}

export interface FileComparisonOpener {
  open(request: FileComparisonRequest): Promise<void>;
}

function refDescription(ref: RefLabel): string {
  if (ref.kind === 'local') return ref.isCurrent ? 'Local Branch · Current' : 'Local Branch';
  if (ref.kind === 'remote') return 'Remote Branch';
  return 'Tag';
}

export class EditorFileComparisonCommand {
  constructor(
    private readonly contexts: EditorGitContextService,
    private readonly git: GitService,
    private readonly comparisons: FileComparisonOpener,
    private readonly host: EditorFileComparisonHost,
  ) {}

  async run(): Promise<void> {
    const activeFile = this.host.getActiveFile();
    if (!activeFile) {
      this.host.showErrorMessage('Open a local file before comparing it with a branch or tag.');
      return;
    }
    try {
      const context = await this.contexts.resolve(activeFile.fsPath);
      const refs = (await this.git.getRefs(context.repositoryRoot, context.repository.currentBranch))
        .filter((ref) => ref.kind !== 'head');
      if (!refs.length) {
        this.host.showErrorMessage('This repository has no branches or tags to compare.');
        return;
      }
      const items = refs.map((ref) => ({
          label: ref.shortName,
          description: refDescription(ref),
          detail: `${ref.fullName} · ${ref.target.slice(0, 8)}`,
          ref,
        }));
      const selected = await this.host.pickRef([
        {
          label: 'Local Branches',
          items: items.filter((item) => item.ref.kind === 'local'),
        },
        {
          label: 'Remote Branches',
          items: items.filter((item) => item.ref.kind === 'remote'),
        },
        {
          label: 'Tags',
          items: items.filter((item) => item.ref.kind === 'tag'),
        },
      ]);
      if (!selected) return;
      await this.comparisons.open({
        repository: context.repository,
        cwd: context.repositoryRoot,
        revision: selected.target,
        revisionLabel: selected.shortName,
        path: context.repositoryPath,
        ...(activeFile.workingContent === undefined
          ? {}
          : { workingContent: activeFile.workingContent }),
      });
    } catch (error) {
      this.host.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }
}
