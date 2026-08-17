import { describe, expect, it, vi } from 'vitest';
import type { HistorySyntaxToken } from '../../src/editor/HistoryDiffSupport';

describe('HistoryPatchSyntaxHighlighter', () => {
  it('tokenizes old and new source streams and maps tokens back to patch rows', async () => {
    const modulePath = '../../src/editor/HistoryPatchSyntaxHighlighter';
    const module = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(module, 'HistoryPatchSyntaxHighlighter must exist').toBeDefined();
    if (!module) return;
    const tokenize = vi.fn(async (code: string) => code.split('\n').map((line) => [
      { content: line, light: '#111111', dark: '#eeeeee' },
    ]));
    const highlighter = new module.HistoryPatchSyntaxHighlighter({ tokenize });
    const patch = [
      'diff --git a/src/app.ts b/src/app.ts',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1,2 +1,2 @@',
      ' const shared = 1;',
      '-oldValue();',
      '+newValue();',
    ].join('\n');
    const abortController = new AbortController();

    const highlighted = await highlighter.highlightPatch(
      'src/app.ts',
      patch,
      abortController.signal,
    );

    expect(tokenize).toHaveBeenNthCalledWith(
      1,
      'const shared = 1;\noldValue();',
      'src/app.ts',
      abortController.signal,
    );
    expect(tokenize).toHaveBeenNthCalledWith(
      2,
      'const shared = 1;\nnewValue();',
      'src/app.ts',
      abortController.signal,
    );
    expect(highlighted.slice(0, 4)).toEqual([undefined, undefined, undefined, undefined]);
    expect(highlighted[4]?.map((token: HistorySyntaxToken) => token.content).join('')).toBe(' const shared = 1;');
    expect(highlighted[5]?.map((token: HistorySyntaxToken) => token.content).join('')).toBe('-oldValue();');
    expect(highlighted[6]?.map((token: HistorySyntaxToken) => token.content).join('')).toBe('+newValue();');
  });

  it('returns no syntax rows for metadata-only patches', async () => {
    const { HistoryPatchSyntaxHighlighter } = await import(
      '../../src/editor/HistoryPatchSyntaxHighlighter'
    );
    const tokenize = vi.fn();
    const highlighter = new HistoryPatchSyntaxHighlighter({ tokenize });

    await expect(highlighter.highlightPatch('mode.txt', 'old mode 100644\nnew mode 100755'))
      .resolves.toEqual([undefined, undefined]);
    expect(tokenize).not.toHaveBeenCalled();
  });

  it('highlights a normal full-file patch that exceeds the old in-process budget', async () => {
    const { HistoryPatchSyntaxHighlighter } = await import(
      '../../src/editor/HistoryPatchSyntaxHighlighter'
    );
    const tokenize = vi.fn(async (code: string) => code.split('\n').map((line) => [
      { content: line, light: '#111111', dark: '#eeeeee' },
    ]));
    const highlighter = new HistoryPatchSyntaxHighlighter({ tokenize });
    const context = ` ${'const value = 1;'.padEnd(80, ' ')}\n`.repeat(100);
    const patch = `@@ -1,100 +1,100 @@\n${context}`;

    const highlighted = await highlighter.highlightPatch('src/app.ts', patch);

    expect(highlighted).toBeDefined();
    expect(tokenize).toHaveBeenCalledTimes(2);
  });

  it('falls back to plain rendering for patches that are too large to highlight', async () => {
    const { HistoryPatchSyntaxHighlighter } = await import(
      '../../src/editor/HistoryPatchSyntaxHighlighter'
    );
    const tokenize = vi.fn();
    const highlighter = new HistoryPatchSyntaxHighlighter({ tokenize });
    const patch = `@@ -1 +1 @@\n-${'x'.repeat(1024 * 1024 + 1)}\n+y`;

    await expect(highlighter.highlightPatch('large.ts', patch)).resolves.toBeUndefined();
    expect(tokenize).not.toHaveBeenCalled();
  });

  it('falls back before tokenizing a pathological single source line', async () => {
    const { HistoryPatchSyntaxHighlighter } = await import(
      '../../src/editor/HistoryPatchSyntaxHighlighter'
    );
    const tokenize = vi.fn();
    const highlighter = new HistoryPatchSyntaxHighlighter({ tokenize });
    const patch = `@@ -1 +1 @@\n-${'x'.repeat(64 * 1024 + 1)}\n+y`;

    await expect(highlighter.highlightPatch('large.ts', patch)).resolves.toBeUndefined();
    expect(tokenize).not.toHaveBeenCalled();
  });

  it('limits the combined old and new source tokenization budget', async () => {
    const { HistoryPatchSyntaxHighlighter } = await import(
      '../../src/editor/HistoryPatchSyntaxHighlighter'
    );
    const tokenize = vi.fn();
    const highlighter = new HistoryPatchSyntaxHighlighter({ tokenize });
    const context = ` ${'x'.repeat(300)}\n`.repeat(1_000);
    const patch = `@@ -1,1000 +1,1000 @@\n${context}`;

    await expect(highlighter.highlightPatch('large.ts', patch)).resolves.toBeUndefined();
    expect(tokenize).not.toHaveBeenCalled();
  });
});
