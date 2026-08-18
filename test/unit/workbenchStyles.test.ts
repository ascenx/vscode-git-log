import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('workbench styles', () => {
  it('removes the webview root spacing so the workbench reaches both edges', async () => {
    const styles = await readFile('webview/src/styles.css', 'utf8');

    expect(styles).toMatch(
      /html,\s*body,\s*#root\s*\{[^}]*margin:\s*0;[^}]*padding:\s*0;/su,
    );
  });

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
      /\.refs-pane\s*\{[^}]*grid-template-rows:\s*38px 30px minmax\(0, 1fr\);[^}]*overflow:\s*hidden;/su,
    );
    expect(styles).toMatch(/\.refs-scroll\s*\{[^}]*min-height:\s*0;[^}]*overflow:\s*auto;/su);
  });

  it('clips commit pane overflow while positioning only filter popovers outside it', async () => {
    const styles = await readFile('webview/src/styles.css', 'utf8');
    const app = await readFile('webview/src/App.tsx', 'utf8');

    expect(styles).toMatch(
      /\.filter-popover\s*\{[^}]*position:\s*fixed;[^}]*top:\s*38px;[^}]*right:\s*8px;[^}]*left:\s*auto;/su,
    );
    expect(styles).not.toMatch(/\.filter-(?:branch|user|date|paths)\s*\{[^}]*left:/su);
    expect(styles).toMatch(/\.log-pane\s*\{[^}]*overflow:\s*hidden;/su);
    expect(styles).toMatch(
      /\.filter-bar\s*\{[^}]*overflow-x:\s*auto;[^}]*overflow-y:\s*hidden;/su,
    );
    expect(app).toContain('getBoundingClientRect()');
  });

  it('pins every workspace pane to its grid column when sibling panes are hidden', async () => {
    const styles = await readFile('webview/src/styles.css', 'utf8');
    const app = await readFile('webview/src/App.tsx', 'utf8');

    expect(styles).toMatch(/\.refs-pane\s*\{[^}]*grid-column:\s*1;/su);
    expect(styles).toMatch(/\.refs-resizer\s*\{[^}]*grid-column:\s*2;/su);
    expect(styles).toMatch(/\.log-pane\s*\{[^}]*grid-column:\s*3;/su);
    expect(styles).toMatch(/\.files-resizer\s*\{[^}]*grid-column:\s*4;/su);
    expect(styles).toMatch(/\.files-pane\s*\{[^}]*grid-column:\s*5;/su);
    expect(app).toContain('pane-resizer vertical refs-resizer');
    expect(app).toContain('pane-resizer vertical files-resizer');
  });

  it('draws one-pixel pane dividers while keeping a wider resize hit target', async () => {
    const styles = await readFile('webview/src/styles.css', 'utf8');
    const app = await readFile('webview/src/App.tsx', 'utf8');

    expect(styles).toMatch(
      /\.workspace-grid\s*\{[^}]*grid-template-columns:\s*220px 1px minmax\(340px, 1fr\) 1px 320px;/su,
    );
    expect(app).toContain('refsCollapsed ? 0 : 1');
    expect(app).toContain('filesCollapsed ? 0 : 1');
    expect(styles).not.toMatch(
      /\.refs-pane,\s*\n\.log-pane\s*\{[^}]*border-right:\s*1px solid var\(--vscode-panel-border\);/su,
    );
    expect(styles).toMatch(
      /\.pane-resizer\.vertical\s*\{[^}]*width:\s*7px;[^}]*justify-self:\s*center;[^}]*cursor:\s*col-resize;/su,
    );
    expect(styles).toMatch(
      /\.pane-resizer\.vertical::after\s*\{[^}]*inset:\s*0 3px;[^}]*background:\s*var\(--vscode-panel-border\);/su,
    );
    expect(styles.indexOf('.pane-resizer.vertical::after')).toBeLessThan(
      styles.indexOf('.pane-resizer:hover::after'),
    );
  });

  it('reserves the changed-files top row for the global actions toolbar', async () => {
    const styles = await readFile('webview/src/styles.css', 'utf8');

    expect(styles).toMatch(/:root\s*\{[^}]*--global-toolbar-width:\s*224px;/su);
    expect(styles).toMatch(
      /\.global-toolbar\s*\{[^}]*position:\s*fixed;[^}]*top:\s*0;[^}]*right:\s*0;[^}]*width:\s*calc\(var\(--global-toolbar-width\) \+ 8px\);[^}]*padding:\s*5px 8px 5px 0;[^}]*background:\s*var\(--workbench-header-background\);/su,
    );
    expect(styles).toMatch(
      /\.files-pane\s*\{[^}]*grid-template-rows:\s*38px 30px minmax\(0, 1fr\) auto;/su,
    );
    expect(styles).toMatch(
      /\.workbench-shell\.files-collapsed\s+\.filter-bar\s*\{[^}]*margin-right:\s*calc\(var\(--global-toolbar-width\) \+ 8px\);/su,
    );
  });

  it('uses one dark background for every pane toolbar and heading row', async () => {
    const styles = await readFile('webview/src/styles.css', 'utf8');
    const app = await readFile('webview/src/App.tsx', 'utf8');

    expect(styles).toMatch(
      /:root\s*\{[^}]*--workbench-header-background:\s*var\(--vscode-sideBar-background\);/su,
    );
    for (const selector of [
      '.filter-bar',
      '.refs-toolbar',
      '.global-toolbar',
      '.global-toolbar-spacer',
    ]) {
      const escapedSelector = selector.replace('.', '\\.');
      expect(styles).toMatch(
        new RegExp(`${escapedSelector}\\s*\\{[^}]*background:\\s*var\\(--workbench-header-background\\);`, 'su'),
      );
    }
    expect(styles).toMatch(
      /\.pane-heading,\s*\n\.log-header\s*\{[^}]*background:\s*var\(--workbench-header-background\);/su,
    );
    expect(app).toContain('className="refs-toolbar"');
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
