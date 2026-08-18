import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { HistoryPatchSyntaxHighlighter } from '../../src/editor/HistoryPatchSyntaxHighlighter';
import { ShikiHistoryCodeTokenizer } from '../../src/editor/ShikiHistoryCodeTokenizer';

const execFileAsync = promisify(execFile);
const TAB_WAIT_TIMEOUT_MS = 10_000;

async function waitForTab(
  predicate: (tab: vscode.Tab) => boolean,
  message: string,
): Promise<vscode.Tab> {
  const deadline = Date.now() + TAB_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const tab = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .find(predicate);
    if (tab) return tab;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(message);
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('ascenx.git-log');
  assert.ok(extension, 'the Git Log extension should be installed in the test host');

  await extension.activate();
  assert.equal(extension.isActive, true, 'the extension should activate successfully');

  const syntaxTokenizer = new ShikiHistoryCodeTokenizer({
    workerScriptPath: join(extension.extensionPath, 'dist/history-syntax-worker.js'),
    timeoutMs: 5_000,
  });
  try {
    const syntaxLines = await syntaxTokenizer.tokenize(
      'const value: string = "worker";',
      'worker-check.ts',
    );
    assert.equal(
      syntaxLines[0]?.map((token) => token.content).join(''),
      'const value: string = "worker";',
      'the packaged history syntax worker should preserve source text',
    );
    assert.ok(
      syntaxLines.flat().some((token) => token.light !== token.dark),
      'the packaged history syntax worker should return adaptive syntax colors',
    );
    const fullFileLines = Array.from(
      { length: 200 },
      (_, index) => `const value${String(index)}: string = "worker";`,
    );
    const fullFilePatch = [
      '@@ -1,200 +1,200 @@',
      ...fullFileLines.map((line) => ` ${line}`),
    ].join('\n');
    const highlightedPatch = await new HistoryPatchSyntaxHighlighter(syntaxTokenizer)
      .highlightPatch('worker-check.ts', fullFilePatch);
    assert.ok(
      highlightedPatch?.some((line) => line?.some((token) => token.light !== token.dark)),
      'a normal full-file patch above the old 8 KiB budget should retain syntax highlighting',
    );
    const excessiveTokenSource = Array.from(
      { length: 5_000 },
      (_, index) => `const value${String(index)}: string = "worker";`,
    ).join('\n');
    await assert.rejects(
      syntaxTokenizer.tokenize(excessiveTokenSource, 'large.ts'),
      /too many syntax tokens/u,
      'the packaged worker should reject excessive token objects before posting them',
    );
  } finally {
    syntaxTokenizer.dispose();
  }

  const commands = await vscode.commands.getCommands(true);
  assert.ok(
    commands.includes('gitLogWorkbench.openLog'),
    'the public open-log command should be registered',
  );
  for (const command of [
    'gitLogWorkbench.editor.showLineHistory',
    'gitLogWorkbench.editor.showSelectionHistory',
    'gitLogWorkbench.editor.showFileHistory',
    'gitLogWorkbench.editor.compareFileWithRef',
  ]) {
    assert.ok(commands.includes(command), `${command} should be registered`);
  }

  await vscode.commands.executeCommand('gitLogWorkbench.openLog');
  await new Promise((resolve) => setTimeout(resolve, 250));
  const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs);
  assert.ok(
    tabs.every((tab) => tab.label !== 'Git Log'),
    'the command should focus the bottom Git Log view without opening an editor tab',
  );

  await assert.rejects(
    Promise.resolve(
      vscode.workspace.openTextDocument(
        vscode.Uri.from({ scheme: 'git-log-workbench', path: '/invalid.ts', query: 'invalid=1' }),
      ),
    ),
    /Invalid Git Log revision URI/u,
    'the historical content provider should be registered',
  );

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(workspaceRoot, 'the integration host should provide a workspace folder');
  const fixturePath = vscode.Uri.joinPath(vscode.Uri.file(workspaceRoot), 'editor-history.ts');
  const gitDirectory = vscode.Uri.joinPath(vscode.Uri.file(workspaceRoot), '.git').fsPath;
  let fixtureDocument: vscode.TextDocument | undefined;
  try {
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: workspaceRoot });
    await writeFile(fixturePath.fsPath, 'const first = 1;\nconst second = 2;\n');
    await execFileAsync('git', ['add', 'editor-history.ts'], { cwd: workspaceRoot });
    await execFileAsync('git', ['commit', '-m', 'editor history fixture'], {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Integration Test',
        GIT_AUTHOR_EMAIL: 'integration@example.com',
        GIT_COMMITTER_NAME: 'Integration Test',
        GIT_COMMITTER_EMAIL: 'integration@example.com',
      },
    });
    await execFileAsync('git', ['branch', 'feature'], { cwd: workspaceRoot });
    await execFileAsync('git', ['tag', 'v1'], { cwd: workspaceRoot });
    const document = await vscode.workspace.openTextDocument(fixturePath);
    fixtureDocument = document;
    let editor = await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(0, 0, 0, 0);

    await vscode.commands.executeCommand('gitLogWorkbench.editor.showLineHistory');
    await waitForTab(
      (tab) => tab.label === 'Line History: editor-history.ts:1',
      'Line History should open in a dedicated editor tab',
    );
    editor = await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand('gitLogWorkbench.editor.showFileHistory');
    await waitForTab(
      (tab) => tab.label === 'File History: editor-history.ts',
      'File History should open in a dedicated editor tab',
    );
    const fileHistoryTabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs);
    assert.ok(
      fileHistoryTabs.some(
        (tab) =>
          tab.input instanceof vscode.TabInputText && tab.input.uri.fsPath === fixturePath.fsPath,
      ),
      'opening File History should keep the source file tab open',
    );
    editor = await vscode.window.showTextDocument(document);
    await editor.edit((builder) => builder.insert(new vscode.Position(0, 0), 'unsaved line\n'));
    assert.equal(document.isDirty, true, 'the fixture document should contain unsaved content');
    editor.selection = new vscode.Selection(0, 0, 2, 0);
    await vscode.commands.executeCommand('gitLogWorkbench.editor.showSelectionHistory');
    assert.equal(document.isDirty, true, 'line history must not save the active document');
    await waitForTab(
      (tab) => tab.label === 'Selection History: editor-history.ts:1–2',
      'Selection History should open in a dedicated editor tab',
    );

    editor = await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand('gitLogWorkbench.editor.compareFileWithRef');
    await new Promise((resolve) => setTimeout(resolve, 250));
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    assert.equal(document.isDirty, true, 'Branch/Tag comparison must not save the active document');

    await waitForTab(
      (tab) =>
        tab.label.startsWith('Compare: editor-history.ts') &&
        tab.input instanceof vscode.TabInputTextDiff,
      'the Branch/Tag comparison command should open a native VS Code diff tab',
    );

    const editorTabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs);
    assert.ok(
      editorTabs.some((tab) => tab.label === 'File History: editor-history.ts'),
      'the dedicated File History tab should remain available',
    );
    const comparisonTab = editorTabs.find(
      (tab) =>
        tab.label.startsWith('Compare: editor-history.ts') &&
        tab.input instanceof vscode.TabInputTextDiff,
    );
    assert.ok(
      comparisonTab?.input instanceof vscode.TabInputTextDiff,
      'the Branch/Tag comparison command should open a native VS Code diff tab',
    );
    assert.equal(
      comparisonTab.input.original.scheme,
      'git-log-workbench',
      'the original side should be loaded from the selected Git revision',
    );
    assert.equal(
      comparisonTab.input.modified.scheme,
      'git-log-workbench-working',
      'a dirty editor should use the in-memory working snapshot side',
    );
    const snapshotDocument = await vscode.workspace.openTextDocument(comparisonTab.input.modified);
    assert.equal(
      snapshotDocument.getText(),
      document.getText(),
      'the native diff should compare the unsaved editor text instead of the saved file',
    );
  } finally {
    if (fixtureDocument?.isDirty) {
      await vscode.window.showTextDocument(fixtureDocument);
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await rm(fixturePath.fsPath, { force: true });
    await rm(gitDirectory, { recursive: true, force: true });
  }
}
