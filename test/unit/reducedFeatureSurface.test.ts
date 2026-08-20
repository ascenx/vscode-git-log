import { access, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('reduced feature surface', () => {
  it('keeps only stash management and Amend HEAD from the current feature work', async () => {
    const [app, protocol, packageJson] = await Promise.all([
      readFile('webview/src/App.tsx', 'utf8'),
      readFile('src/protocol/messages.ts', 'utf8'),
      readFile('package.json', 'utf8'),
    ]);

    expect(app).toContain('Manage stashes');
    expect(app).toContain('Amend HEAD…');
    expect(protocol).toContain("kind: 'createStash'");
    expect(protocol).toContain("kind: 'amendCommit'");

    for (const removedUi of [
      'Compare revisions',
      'Incoming / Outgoing',
      'Interactive Rebase',
      'Create Fixup Commit',
      'Open Merge Editor',
    ]) {
      expect(app).not.toContain(removedUi);
    }

    for (const removedProtocol of [
      "kind: 'continueOperation'",
      "kind: 'fixupCommit'",
      "kind: 'interactiveRebase'",
      "type: 'openConflictFile'",
      "type: 'openRevisionComparison'",
      "type: 'requestBranchDivergence'",
    ]) {
      expect(protocol).not.toContain(removedProtocol);
    }

    expect(packageJson).not.toContain('gitLogWorkbench.editor.showBlame');
    for (const removedFile of [
      'src/editor/BlameEditor.ts',
      'src/editor/EditorBlameCommand.ts',
      'src/git/BlameService.ts',
    ]) {
      await expect(access(removedFile)).rejects.toBeDefined();
    }
  });
});
