import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('production build artifacts', () => {
  it('bundles the production React runtime and keeps the webview compact', async () => {
    await execFileAsync(process.execPath, ['scripts/build.mjs'], { cwd: process.cwd() });

    const webviewPath = 'dist/webview.js';
    const [source, metadata] = await Promise.all([
      readFile(webviewPath, 'utf8'),
      stat(webviewPath),
    ]);

    expect(source).not.toContain('react.development.js');
    expect(source).not.toContain('react-dom-client.development.js');
    expect(metadata.size).toBeLessThan(400 * 1024);
  });
});
