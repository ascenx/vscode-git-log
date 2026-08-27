import { describe, expect, it } from 'vitest';

describe('line history context', () => {
  it('selects the commit hunk that contains the tracked line', async () => {
    const contextModule = await import('../../src/git/lineHistoryContext').catch(() => undefined);
    expect(contextModule, 'line history context extractor must exist').toBeDefined();
    if (!contextModule) return;
    const patch = [
      'diff --git a/app.ts b/app.ts',
      '--- a/app.ts',
      '+++ b/app.ts',
      '@@ -1 +1 @@',
      '-old top',
      '+new top',
      '@@ -7,7 +7,7 @@',
      ' before 7',
      ' before 8',
      ' before 9',
      '-old target',
      '+new target',
      ' after 11',
      ' after 12',
      ' after 13',
    ].join('\n');

    const extracted = contextModule.extractLineHistoryContextPatch(patch, {
      oldStartLine: 10,
      oldLineCount: 1,
      newStartLine: 10,
      newLineCount: 1,
    }, 3);

    expect(extracted).toContain(' before 7');
    expect(extracted).toContain('-old target');
    expect(extracted).toContain(' after 13');
    expect(extracted).not.toContain('old top');
  });

  it('crops an added-file hunk around the tracked line', async () => {
    const { extractLineHistoryContextPatch } = await import('../../src/git/lineHistoryContext');
    const patch = [
      '@@ -0,0 +1,8 @@',
      '+line 1',
      '+line 2',
      '+line 3',
      '+line 4',
      '+line 5',
      '+line 6',
      '+line 7',
      '+line 8',
    ].join('\n');

    const extracted = extractLineHistoryContextPatch(patch, {
      oldStartLine: 0,
      oldLineCount: 0,
      newStartLine: 4,
      newLineCount: 1,
    }, 2);

    expect(extracted).toContain('+line 2');
    expect(extracted).toContain('+line 4');
    expect(extracted).toContain('+line 6');
    expect(extracted).not.toContain('+line 1');
    expect(extracted).not.toContain('+line 7');
  });

  it('counts only unchanged rows toward the configured context', async () => {
    const { extractLineHistoryContextPatch } = await import('../../src/git/lineHistoryContext');
    const patch = [
      '@@ -5,8 +5,8 @@',
      ' line 5',
      ' line 6',
      ' line 7',
      '-old adjacent',
      '+new adjacent',
      '-old target',
      '+new target',
      ' line 10',
      ' line 11',
      ' line 12',
    ].join('\n');

    const extracted = extractLineHistoryContextPatch(patch, {
      oldStartLine: 9,
      oldLineCount: 1,
      newStartLine: 9,
      newLineCount: 1,
    }, 3);

    expect(extracted).toBe(patch);
  });
});
