import type { HistoryEntry, RepositorySummary } from '../shared/models';

export interface HistorySyntaxToken {
  content: string;
  light: string;
  dark: string;
}

export type HistoryHighlightedLine = readonly HistorySyntaxToken[] | undefined;

export interface HistorySyntaxHighlighter {
  highlightPatch(
    path: string,
    patch: string,
    signal?: AbortSignal,
  ): Promise<readonly HistoryHighlightedLine[] | undefined>;
}

export interface HistoryNativeDiffOpener {
  open(
    repository: RepositorySummary,
    cwd: string,
    entry: HistoryEntry,
    parent?: string,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface HistoryDiffSupport {
  syntaxHighlighter?: HistorySyntaxHighlighter;
  nativeDiffOpener?: HistoryNativeDiffOpener;
}
