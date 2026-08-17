import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ShikiHistoryCodeTokenizer } from '../../src/editor/ShikiHistoryCodeTokenizer';

describe('history syntax highlighting performance', () => {
  it('keeps the extension-host event loop responsive while the worker tokenizes', async () => {
    const tokenizer = new ShikiHistoryCodeTokenizer({
      workerScriptPath: join(process.cwd(), 'test/fixtures/historySyntaxWorker.mjs'),
      timeoutMs: 2_000,
    });
    let timerFired = false;
    const timer = setTimeout(() => {
      timerFired = true;
    }, 25);

    const pending = tokenizer.tokenize('const value = 1;', 'src/app.ts');
    await new Promise((resolve) => setTimeout(resolve, 75));

    expect(timerFired).toBe(true);
    await expect(pending).resolves.toEqual([
      [{ content: 'const value = 1;', light: '#111111', dark: '#eeeeee' }],
    ]);
    clearTimeout(timer);
    tokenizer.dispose();
  });
});
