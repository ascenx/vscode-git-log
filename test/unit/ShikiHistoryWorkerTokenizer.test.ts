import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('ShikiHistoryWorkerTokenizer', () => {
  it('uses the file extension to produce adaptive light and dark syntax tokens', async () => {
    const modulePath = '../../src/editor/ShikiHistoryWorkerTokenizer';
    const module = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(module, 'ShikiHistoryWorkerTokenizer must exist').toBeDefined();
    if (!module) return;
    const tokenizer = new module.ShikiHistoryWorkerTokenizer();

    const lines = await tokenizer.tokenize(
      'const value: string = "ok";\nconsole.log(value);',
      'src/app.ts',
    );

    expect(lines).toHaveLength(2);
    expect(lines[0]?.map((token: { content: string }) => token.content).join('')).toBe(
      'const value: string = "ok";',
    );
    expect(lines.flat().some((token: { light: string; dark: string }) => (
      token.light !== token.dark && /^#[0-9a-f]{6,8}$/iu.test(token.light) &&
      /^#[0-9a-f]{6,8}$/iu.test(token.dark)
    ))).toBe(true);
    tokenizer.dispose();
  });

  it('defers loading language grammar modules until that language is requested', async () => {
    const source = await readFile('src/editor/ShikiHistoryWorkerTokenizer.ts', 'utf8');

    expect(source).not.toMatch(/^import .+ from '@shikijs\/langs\//gmu);
    expect(source).toContain("import('@shikijs/langs/typescript')");
  });
});
