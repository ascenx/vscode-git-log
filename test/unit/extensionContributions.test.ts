import { access, readdir, readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const brandingRoots = ['src', 'webview', 'test'];
const brandingExtensions = new Set(['.md', '.ts', '.tsx', '.json']);

async function collectBrandingTextFiles(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const child = join(path, entry.name);
      if (entry.isDirectory()) return collectBrandingTextFiles(child);
      return brandingExtensions.has(extname(entry.name)) ? [child] : [];
    }),
  );
  return files.flat();
}

describe('extension contributions', () => {
  it('keeps local README links pointed at files in the repository', async () => {
    const missing: string[] = [];

    for (const file of ['README.md', 'README.zh-CN.md']) {
      const markdown = await readFile(file, 'utf8');
      for (const match of markdown.matchAll(/\]\(([^)#]+)(?:#[^)]+)?\)/g)) {
        const target = match[1];
        if (!target) continue;
        if (/^[a-z][a-z\d+.-]*:/i.test(target)) continue;

        try {
          await access(join(dirname(file), decodeURIComponent(target)));
        } catch {
          missing.push(`${file} -> ${target}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it('uses ascenx.git-log as the extension identifier', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
      name?: string;
      publisher?: string;
    };

    expect(`${packageJson.publisher}.${packageJson.name}`).toBe('ascenx.git-log');
  });

  it('declares VS Code 1.85 and Node 18 as the extension compatibility baseline', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
      engines?: { vscode?: string };
      devDependencies?: Record<string, string>;
    };

    expect(packageJson.engines?.vscode).toBe('^1.85.0');
    expect(packageJson.devDependencies?.['@types/vscode']).toBe('1.85.0');

    const buildSource = await readFile('scripts/build.mjs', 'utf8');
    expect(buildSource).not.toContain("target: 'node20'");
    expect(buildSource.match(/target: 'node18'/gu)).toHaveLength(3);
  });

  it('runs extension integration tests against VS Code 1.85.2 by default', async () => {
    const integrationSource = await readFile('scripts/run-integration.mjs', 'utf8');

    expect(integrationSource).toContain(
      "const version = process.env.VSCODE_TEST_VERSION ?? '1.85.2';",
    );
    expect(integrationSource).toContain('version,');
  });

  it('verifies VS Code 1.85.2 compatibility before publishing a release', async () => {
    const workflow = await readFile('.github/workflows/release.yml', 'utf8');

    expect(workflow).toContain('xvfb-run -a npm run test:integration');
  });

  it('provides a PNG icon for the extension details page', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
      icon?: string;
    };

    expect(packageJson.icon).toBe('media/git-log.png');

    const icon = await readFile(packageJson.icon!);
    expect(icon.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(icon.readUInt32BE(16)).toBe(128);
    expect(icon.readUInt32BE(20)).toBe(128);
  });

  it('uses Git Log branding without third-party product references', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
      displayName?: string;
      description?: string;
    };
    expect(packageJson.displayName).toBe('Git Log — Commit Graph & History');
    expect(packageJson.description).toBe(
      'A visual Git log, commit graph, history browser, and repository operations extension for Visual Studio Code.',
    );

    const files = [
      'README.md',
      'README.zh-CN.md',
      'CONTRIBUTING.md',
      'LICENSE',
      'package.json',
      ...(await Promise.all(brandingRoots.map(collectBrandingTextFiles))).flat(),
    ];
    const prohibitedBrand = ['Jet', 'Brains'].join('');
    const violations: string[] = [];
    for (const file of files) {
      if ((await readFile(file, 'utf8')).toLocaleLowerCase().includes(prohibitedBrand.toLocaleLowerCase())) {
        violations.push(file);
      }
    }
    expect(violations).toEqual([]);
  });

  it('contributes Git Log as a bottom panel tab without an activity-bar launcher', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
      version?: string;
      activationEvents?: string[];
      contributes?: {
        commands?: Array<{ command?: string; title?: string }>;
        submenus?: Array<{ id?: string; label?: string }>;
        menus?: Record<string, Array<Record<string, unknown>>>;
        viewsContainers?: {
          activitybar?: unknown;
          panel?: Array<{ id?: string; title?: string }>;
        };
        views?: Record<string, Array<{ id?: string; type?: string }>>;
        viewsWelcome?: unknown;
      };
    };

    expect(packageJson.version).toBe('0.0.8');
    expect(packageJson.contributes?.viewsWelcome).toBeUndefined();
    expect(packageJson.contributes?.viewsContainers?.activitybar).toBeUndefined();
    expect(packageJson.contributes?.viewsContainers?.panel).toEqual([
      expect.objectContaining({ id: 'gitLogWorkbench', title: 'Git Log' }),
    ]);
    expect(packageJson.contributes?.views?.gitLogWorkbench).toEqual([
      expect.objectContaining({ id: 'gitLogWorkbench.log', type: 'webview' }),
    ]);
    expect(packageJson.activationEvents).toContain('onView:gitLogWorkbench.log');
    expect(packageJson.activationEvents).not.toContain('onView:gitLogWorkbench.launcher');
    expect(packageJson.contributes?.submenus).toContainEqual({
      id: 'gitLogWorkbench.editorContext',
      label: 'Git Log',
    });
    expect(packageJson.contributes?.submenus).toContainEqual({
      id: 'gitLogWorkbench.explorerContext',
      label: 'Git Log',
    });
    expect(packageJson.contributes?.menus?.['editor/context']).toContainEqual(
      expect.objectContaining({
        submenu: 'gitLogWorkbench.editorContext',
        when: 'resourceScheme == file',
      }),
    );
    expect(packageJson.contributes?.menus?.['gitLogWorkbench.editorContext']).toEqual([
      expect.objectContaining({
        command: 'gitLogWorkbench.editor.showLineHistory',
        when: 'resourceScheme == file && !editorHasSelection',
      }),
      expect.objectContaining({
        command: 'gitLogWorkbench.editor.showSelectionHistory',
        when: 'resourceScheme == file && editorHasSelection',
      }),
      expect.objectContaining({ command: 'gitLogWorkbench.editor.showFileHistory' }),
      expect.objectContaining({ command: 'gitLogWorkbench.editor.compareFileWithRef' }),
    ]);
    expect(packageJson.contributes?.menus?.['explorer/context']).toContainEqual(
      expect.objectContaining({
        submenu: 'gitLogWorkbench.explorerContext',
        when: 'resourceScheme == file',
      }),
    );
    expect(packageJson.contributes?.menus?.['gitLogWorkbench.explorerContext']).toEqual([
      expect.objectContaining({
        command: 'gitLogWorkbench.editor.showFileHistory',
        when: 'resourceScheme == file && !explorerResourceIsFolder',
      }),
      expect.objectContaining({
        command: 'gitLogWorkbench.explorer.showFolderHistory',
        when: 'resourceScheme == file && explorerResourceIsFolder',
      }),
    ]);
    expect(packageJson.contributes?.menus?.commandPalette).toContainEqual({
      command: 'gitLogWorkbench.explorer.showFolderHistory',
      when: 'false',
    });
    expect(packageJson.activationEvents).toContain(
      'onCommand:gitLogWorkbench.explorer.showFolderHistory',
    );
  });

  it('registers the workbench as a retained bottom-panel webview and focuses it on command', async () => {
    const source = await readFile('src/extension.ts', 'utf8');

    expect(source).toMatch(/registerWebviewViewProvider\(\s*'gitLogWorkbench\.log'/);
    expect(source).toContain('retainContextWhenHidden: true');
    expect(source).toContain("executeCommand('gitLogWorkbench.log.focus')");
    expect(source).not.toContain('WorkbenchLauncherProvider');
    expect(source).not.toContain('workbench.action.closeSidebar');
    expect(source).toContain('new EditorFileComparisonCommand');
    expect(source).toContain('new FileComparisonEditor');
    expect(source).toContain('new WorkingSnapshotContentProvider');
    expect(source).toContain('WORKING_SNAPSHOT_SCHEME');
    expect(source).toContain('tabGroups.onDidChangeTabs');
    expect(source).toContain('tab.input instanceof vscode.TabInputTextDiff');
    expect(source).toContain('vscode.window.tabGroups.all');
    expect(source).toContain('releaseNativeDiffResourcesIfUnused');
    expect(source).not.toContain('onDidCloseTextDocument');
    expect(source).toContain('new EditorHistoryCommands');
    expect(source).toContain('new FileHistoryEditor');
    expect(source).toContain('new LineHistoryEditor');
    expect(source).toContain('new ShikiHistoryCodeTokenizer');
    expect(source).toContain('new HistoryPatchSyntaxHighlighter');
    expect(source).toContain('new HistoryNativeDiffOpener');
    expect(source).toContain('syntaxHighlighter');
    expect(source).toContain('nativeDiffOpener');
    expect(source).toContain('openFileHistory: (request) => fileHistoryEditor.open(request)');
    expect(source).toContain('openLineHistory: (request) => lineHistoryEditor.open(request)');
    expect(source).toContain('openFolderHistory: (request) => workbenchProvider.openFolderHistory(request)');
    expect(source).not.toContain('showLineHistory: () => {},');
    expect(source).not.toContain('showSelectionHistory: () => {},');
    expect(source).not.toContain('showFileHistory: () => {},');
    expect(source).toContain('compareFileWithRef: () =>');
    expect(source).not.toContain('compareFileWithRef: () => {},');
  });

  it('activates and wires current-line blame decorations for local editors', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
      activationEvents?: string[];
      contributes?: {
        configuration?: { properties?: Record<string, unknown> };
      };
    };
    const source = await readFile('src/extension.ts', 'utf8');

    expect(packageJson.activationEvents).toContain('onStartupFinished');
    expect(packageJson.contributes?.configuration?.properties).toHaveProperty(
      'gitLogWorkbench.currentLineBlame.enabled',
    );
    expect(source).toContain('new CurrentLineBlameController');
    expect(source).toContain('createTextEditorDecorationType');
    expect(source).toContain("new vscode.ThemeColor('editorGhostText.foreground')");
    expect(source).not.toContain("new vscode.ThemeColor('editorCodeLens.foreground')");
    expect(source).toContain('onDidChangeTextEditorSelection');
    expect(source).toContain('onDidChangeActiveTextEditor');
    expect(source).toContain('onDidChangeTextDocument');
    expect(source).toContain('new LineEditTimeTracker');
    expect(source).toContain('export async function deactivate(): Promise<void>');
    expect(source).toContain('MAX_DIRTY_BLAME_CHARACTERS');
    expect(source).toContain('document.offsetAt');
    expect(source).toContain('editor.viewColumn');
    expect(source).not.toContain('editorSnapshot()?.key');
    expect(source).toContain("getExtension<GitExtension>('vscode.git')");
    expect(source).toContain('repository.state.onDidChange');
    expect(source).toContain('currentLineBlame.invalidate()');
    expect(source).toContain('lineBlameService.invalidate()');
  });

  it('returns editor-history command promises so VS Code waits for their tabs to open', async () => {
    const source = await readFile('src/extension.ts', 'utf8');

    expect(source).toContain('showLineHistory: () => editorHistoryCommands.showLineHistory(),');
    expect(source).toContain(
      'showSelectionHistory: () => editorHistoryCommands.showSelectionHistory(),',
    );
    expect(source).toContain('showFileHistory: (resource) =>');
    expect(source).toContain('showFolderHistory: (resource) =>');
    expect(source).not.toContain('void editorHistoryCommands.showLineHistory()');
  });

  it('builds Shiki syntax highlighting as a separate worker bundle', async () => {
    const buildSource = await readFile('scripts/build.mjs', 'utf8');

    expect(buildSource).toContain("entryPoints: ['src/editor/HistorySyntaxWorker.ts']");
    expect(buildSource).toContain("outfile: 'dist/history-syntax-worker.js'");
  });

  it('hosts the Git Log in a WebviewView instead of creating an editor tab', async () => {
    const source = await readFile('src/webview/WorkbenchPanel.ts', 'utf8');

    expect(source).toContain('implements vscode.WebviewViewProvider');
    expect(source).toContain('resolveWebviewView(view: vscode.WebviewView)');
    expect(source).toContain('openEditorHistory(request: EditorHistoryRequest)');
    expect(source).toContain('pendingHistoryRequest');
    expect(source).not.toContain('createWebviewPanel');
    expect(source).not.toContain('ViewColumn');
  });

  it('does not expose stale disabled File History placeholders', async () => {
    const source = await readFile('webview/src/App.tsx', 'utf8');

    expect(source).not.toContain('File History is planned for Milestone 7');
    expect(source).not.toContain('Show in File History');
  });
});
