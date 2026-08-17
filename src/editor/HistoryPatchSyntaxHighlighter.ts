import type {
  HistoryHighlightedLine,
  HistorySyntaxHighlighter,
  HistorySyntaxToken,
} from './HistoryDiffSupport';

export interface HistoryCodeTokenizer {
  tokenize(
    code: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<readonly (readonly HistorySyntaxToken[])[]>;
}

interface PatchLineMapping {
  side: 'old' | 'new';
  sourceLine: number;
  prefix: string;
}

const FALLBACK_LIGHT = '#24292f';
const FALLBACK_DARK = '#c9d1d9';
const MAX_HIGHLIGHT_PATCH_BYTES = 1024 * 1024;
const MAX_HIGHLIGHT_PATCH_LINES = 10_000;
const MAX_HIGHLIGHT_SOURCE_LINE_BYTES = 64 * 1024;
const MAX_HIGHLIGHT_SOURCE_BYTES = 512 * 1024;

function prefixedTokens(
  prefix: string,
  tokens: readonly HistorySyntaxToken[] | undefined,
): readonly HistorySyntaxToken[] {
  const color = tokens?.[0];
  return [
    {
      content: prefix,
      light: color?.light ?? FALLBACK_LIGHT,
      dark: color?.dark ?? FALLBACK_DARK,
    },
    ...(tokens ?? []),
  ];
}

export class HistoryPatchSyntaxHighlighter implements HistorySyntaxHighlighter {
  constructor(private readonly tokenizer: HistoryCodeTokenizer) {}

  async highlightPatch(
    path: string,
    patch: string,
    signal?: AbortSignal,
  ): Promise<readonly HistoryHighlightedLine[] | undefined> {
    signal?.throwIfAborted();
    if (Buffer.byteLength(patch, 'utf8') > MAX_HIGHLIGHT_PATCH_BYTES) return undefined;
    const patchLines = patch.split(/\r?\n/u);
    if (patchLines.length > MAX_HIGHLIGHT_PATCH_LINES) return undefined;
    const highlighted: HistoryHighlightedLine[] = patchLines.map(() => undefined);
    const oldLines: string[] = [];
    const newLines: string[] = [];
    const mappings = new Map<number, PatchLineMapping>();
    let inHunk = false;
    let sourceBytes = 0;

    for (let index = 0; index < patchLines.length; index += 1) {
      const line = patchLines[index] ?? '';
      if (/^@@ -\d+/u.test(line)) {
        inHunk = true;
        continue;
      }
      if (line.startsWith('diff --git ')) {
        inHunk = false;
        continue;
      }
      if (!inHunk || line.startsWith('\\ No newline at end of file')) continue;
      const sourceLine = line.slice(1);
      const sourceLineBytes = Buffer.byteLength(sourceLine, 'utf8');
      if (sourceLineBytes > MAX_HIGHLIGHT_SOURCE_LINE_BYTES) return undefined;
      const sourceLineBudget = sourceLineBytes + 1;
      if (line.startsWith('-')) {
        mappings.set(index, { side: 'old', sourceLine: oldLines.length, prefix: '-' });
        oldLines.push(sourceLine);
        sourceBytes += sourceLineBudget;
        if (sourceBytes > MAX_HIGHLIGHT_SOURCE_BYTES) return undefined;
        continue;
      }
      if (line.startsWith('+')) {
        mappings.set(index, { side: 'new', sourceLine: newLines.length, prefix: '+' });
        newLines.push(sourceLine);
        sourceBytes += sourceLineBudget;
        if (sourceBytes > MAX_HIGHLIGHT_SOURCE_BYTES) return undefined;
        continue;
      }
      if (line.startsWith(' ')) {
        oldLines.push(sourceLine);
        mappings.set(index, { side: 'new', sourceLine: newLines.length, prefix: ' ' });
        newLines.push(sourceLine);
        sourceBytes += sourceLineBudget * 2;
      }
      if (sourceBytes > MAX_HIGHLIGHT_SOURCE_BYTES) return undefined;
    }

    if (!mappings.size) return highlighted;
    const [oldTokens, newTokens] = await Promise.all([
      this.tokenizer.tokenize(oldLines.join('\n'), path, signal),
      this.tokenizer.tokenize(newLines.join('\n'), path, signal),
    ]);
    signal?.throwIfAborted();
    for (const [patchLine, mapping] of mappings) {
      const source = mapping.side === 'old' ? oldTokens : newTokens;
      highlighted[patchLine] = prefixedTokens(mapping.prefix, source[mapping.sourceLine]);
    }
    return highlighted;
  }
}
