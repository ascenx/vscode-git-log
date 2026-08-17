import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('workbench styles', () => {
  it('uses the resized total column width and keeps the commit header horizontally aligned', async () => {
    const styles = await readFile('webview/src/styles.css', 'utf8');
    const app = await readFile('webview/src/App.tsx', 'utf8');

    expect(styles).toMatch(/\.log-header-viewport\s*\{[^}]*overflow:\s*hidden;/su);
    expect(styles).toMatch(/\.log-header\s*\{[^}]*min-width:\s*max\(100%, var\(--log-content-width/su);
    expect(styles).toMatch(/\.commit-list\s*\{[^}]*min-width:\s*max\(100%, var\(--log-content-width/su);
    expect(app).toContain('onHorizontalScroll');
    expect(app).toContain('log-header-viewport');
  });

  it('allows deeply nested changed files to overflow horizontally', async () => {
    const styles = await readFile('webview/src/styles.css', 'utf8');

    expect(styles).toMatch(/\.file-list-content\s*\{[^}]*min-width:\s*max-content;/su);
    expect(styles).toMatch(/\.file-row\s*\{[^}]*width:\s*max-content;/su);
  });

  it('matches the VS Code Explorer row height in changed-files tree and list views', async () => {
    const styles = await readFile('webview/src/styles.css', 'utf8');

    expect(styles).toMatch(/:root\s*\{[^}]*--explorer-row-height:\s*22px;/su);
    expect(styles).toMatch(
      /\.file-directory\s*>\s*summary\s*\{[^}]*height:\s*var\(--explorer-row-height\);/su,
    );
    expect(styles).toMatch(
      /\.file-row\s*\{[^}]*height:\s*var\(--explorer-row-height\);/su,
    );
  });

  it('keeps the branches heading fixed while references scroll vertically', async () => {
    const styles = await readFile('webview/src/styles.css', 'utf8');

    expect(styles).toMatch(
      /\.refs-pane\s*\{[^}]*grid-template-rows:\s*30px minmax\(0, 1fr\);[^}]*overflow:\s*hidden;/su,
    );
    expect(styles).toMatch(/\.refs-scroll\s*\{[^}]*min-height:\s*0;[^}]*overflow:\s*auto;/su);
  });

  it('colors additions green and deletions red', async () => {
    const styles = await readFile('webview/src/styles.css', 'utf8');

    expect(styles).toMatch(
      /\.file-stat-additions\s*\{[^}]*color:\s*var\(--vscode-gitDecoration-addedResourceForeground\);/su,
    );
    expect(styles).toMatch(
      /\.file-stat-deletions\s*\{[^}]*color:\s*var\(--vscode-gitDecoration-deletedResourceForeground\);/su,
    );
  });
});
