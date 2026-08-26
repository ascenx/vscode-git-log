import type { GitService } from '../git/GitService';
import type { LineBlame, LineBlameService } from '../git/LineBlameService';
import type { EditorGitContext, EditorGitContextService } from './EditorGitContextService';

const MAX_CACHED_COMMIT_MESSAGES = 200;
const MAX_CACHED_EDITOR_CONTEXTS = 50;

export const CURRENT_LINE_BLAME_CONFIGURATION_KEYS = [
  'gitLogWorkbench.currentLineBlame.enabled',
  'git.blame.editorDecoration.enabled',
] as const;

export function shouldUseCustomLineBlame(
  customEnabled: boolean,
  builtInEnabled: boolean,
): boolean {
  return customEnabled && !builtInEnabled;
}

export interface CurrentLineEditorSnapshot {
  key: string;
  fsPath: string;
  line: number;
  workingContent?: string;
  editTime?: number;
}

export interface CurrentLineBlamePresentation {
  contentText: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  relativeTime: string;
  hash: string;
  message: string;
  committed: boolean;
}

export interface CurrentLineBlameHost {
  getActiveEditor(): CurrentLineEditorSnapshot | undefined;
  render(editor: CurrentLineEditorSnapshot, presentation: CurrentLineBlamePresentation): void;
  clear?(): void;
  onError?(error: unknown): void;
  readonly locale: string;
  now(): number;
}

function formatRelativeTime(timestamp: number, now: number, locale: string): string {
  const elapsedSeconds = (timestamp * 1000 - now) / 1000;
  const units: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 365 * 24 * 60 * 60],
    ['month', 30 * 24 * 60 * 60],
    ['week', 7 * 24 * 60 * 60],
    ['day', 24 * 60 * 60],
    ['hour', 60 * 60],
    ['minute', 60],
    ['second', 1],
  ];
  const absoluteSeconds = Math.abs(elapsedSeconds);
  const [unit, seconds] = units.find(([, threshold]) => absoluteSeconds >= threshold) ?? units[6]!;
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(
    Math.round(elapsedSeconds / seconds),
    unit,
  );
}

function formatBlame(
  blame: LineBlame,
  message: string,
  now: number,
  locale: string,
): CurrentLineBlamePresentation {
  const relativeTime = formatRelativeTime(blame.authorTime, now, locale);
  const authoredAt = new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(blame.authorTime * 1000));
  return {
    contentText: `${blame.authorName}, ${relativeTime} · ${blame.subject}`,
    authorName: blame.authorName,
    authorEmail: blame.authorEmail,
    authoredAt,
    relativeTime,
    hash: blame.hash,
    message,
    committed: blame.committed,
  };
}

export class CurrentLineBlameController {
  private generation = 0;
  private activeRequest: AbortController | undefined;
  private activeEditorKey: string | undefined;
  private readonly commitMessages = new Map<string, string>();
  private readonly editorContexts = new Map<string, Promise<EditorGitContext>>();
  private readonly uncommittedEditTimes = new Map<string, number>();
  private presentationTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly contexts: EditorGitContextService,
    private readonly blames: LineBlameService,
    private readonly commits: GitService,
    private readonly host: CurrentLineBlameHost,
  ) {}

  private resolveContext(filePath: string): Promise<EditorGitContext> {
    const cached = this.editorContexts.get(filePath);
    if (cached) {
      this.editorContexts.delete(filePath);
      this.editorContexts.set(filePath, cached);
      return cached;
    }

    const pending = this.contexts.resolve(filePath);
    this.editorContexts.set(filePath, pending);
    void pending.catch(() => {
      if (this.editorContexts.get(filePath) === pending) this.editorContexts.delete(filePath);
    });
    while (this.editorContexts.size > MAX_CACHED_EDITOR_CONTEXTS) {
      const oldestPath = this.editorContexts.keys().next().value as string | undefined;
      if (!oldestPath) break;
      this.editorContexts.delete(oldestPath);
    }
    return pending;
  }

  private clearPresentationTimer(): void {
    if (this.presentationTimer) clearTimeout(this.presentationTimer);
    this.presentationTimer = undefined;
  }

  private renderPresentation(
    editor: CurrentLineEditorSnapshot,
    blame: LineBlame,
    message: string,
  ): void {
    const now = this.host.now();
    this.host.render(editor, formatBlame(blame, message, now, this.host.locale));
    this.clearPresentationTimer();
    if (blame.committed) return;

    const elapsedMs = Math.max(0, now - blame.authorTime * 1000);
    const refreshDelay =
      elapsedMs < 60_000 ? 60_000 - elapsedMs : 60_000 - (elapsedMs % 60_000);
    this.presentationTimer = setTimeout(() => {
      this.presentationTimer = undefined;
      const activeEditor = this.host.getActiveEditor();
      if (!activeEditor || activeEditor.key !== editor.key) return;
      this.renderPresentation(activeEditor, blame, message);
    }, Math.max(250, refreshDelay));
  }

  async refresh(): Promise<void> {
    const editor = this.host.getActiveEditor();
    if (!editor) {
      this.generation += 1;
      this.activeEditorKey = undefined;
      this.activeRequest?.abort();
      this.activeRequest = undefined;
      this.clearPresentationTimer();
      this.host.clear?.();
      return;
    }
    if (editor.key === this.activeEditorKey) return;

    const generation = ++this.generation;
    this.activeEditorKey = editor.key;
    this.activeRequest?.abort();
    this.clearPresentationTimer();
    const request = new AbortController();
    this.activeRequest = request;
    this.host.clear?.();

    try {
      const context = await this.resolveContext(editor.fsPath);
      if (generation !== this.generation || request.signal.aborted) return;
      let blame = await this.blames.getLineBlame(
        context.repositoryRoot,
        context.repositoryPath,
        editor.line + 1,
        {
          ...(editor.workingContent !== undefined ? { content: editor.workingContent } : {}),
          signal: request.signal,
        },
      );
      if (!blame || generation !== this.generation || request.signal.aborted) return;

      const now = this.host.now();
      if (!blame.committed) {
        const isChinese = this.host.locale.toLowerCase().startsWith('zh');
        const editTime =
          editor.editTime ?? this.uncommittedEditTimes.get(editor.key) ?? now;
        this.uncommittedEditTimes.set(editor.key, editTime);
        while (this.uncommittedEditTimes.size > MAX_CACHED_COMMIT_MESSAGES) {
          const oldestKey = this.uncommittedEditTimes.keys().next().value as string | undefined;
          if (!oldestKey) break;
          this.uncommittedEditTimes.delete(oldestKey);
        }
        blame = {
          ...blame,
          authorName: context.repository.userName?.trim() || (isChinese ? '你' : 'You'),
          authorEmail: context.repository.userEmail?.trim() ?? '',
          authorTime: Math.floor(editTime / 1000),
          subject: isChinese ? '未提交的更改' : 'Uncommitted changes',
        };
      }

      let message = blame.subject;
      if (blame.committed) {
        const cachedMessage = this.commitMessages.get(blame.hash);
        if (cachedMessage !== undefined) {
          message = cachedMessage;
        } else {
          this.renderPresentation(editor, blame, message);
          try {
            message = await this.commits.getCommitMessage(
              context.repositoryRoot,
              blame.hash,
              request.signal,
            );
          } catch (error) {
            if (generation === this.generation && !request.signal.aborted) {
              this.activeEditorKey = undefined;
              this.host.onError?.(error);
            }
            return;
          }
          if (generation !== this.generation || request.signal.aborted) return;
          this.commitMessages.set(blame.hash, message);
          while (this.commitMessages.size > MAX_CACHED_COMMIT_MESSAGES) {
            const oldestHash = this.commitMessages.keys().next().value as string | undefined;
            if (!oldestHash) break;
            this.commitMessages.delete(oldestHash);
          }
        }
      }

      if (generation !== this.generation || request.signal.aborted) return;
      this.renderPresentation(editor, blame, message);
    } catch (error) {
      if (generation === this.generation && !request.signal.aborted) {
        this.activeEditorKey = undefined;
        this.host.clear?.();
        this.host.onError?.(error);
      }
    }
  }

  invalidate(): void {
    this.generation += 1;
    this.activeEditorKey = undefined;
    this.activeRequest?.abort();
    this.activeRequest = undefined;
    this.editorContexts.clear();
    this.clearPresentationTimer();
    this.host.clear?.();
  }

  dispose(): void {
    this.generation += 1;
    this.activeEditorKey = undefined;
    this.activeRequest?.abort();
    this.activeRequest = undefined;
    this.clearPresentationTimer();
    this.editorContexts.clear();
    this.uncommittedEditTimes.clear();
    this.host.clear?.();
  }
}
