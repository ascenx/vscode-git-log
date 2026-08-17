import { describe, expect, it, vi } from 'vitest';
import type { EditorGitContextService } from '../../src/editor/EditorGitContextService';
import type { GitService } from '../../src/git/GitService';

describe('EditorFileComparisonCommand', () => {
  it('lets the user pick a branch or tag and opens a dedicated comparison tab', async () => {
    const modulePath = '../../src/editor/EditorFileComparisonCommand';
    const commandModule = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(commandModule, 'EditorFileComparisonCommand must exist').toBeDefined();
    if (!commandModule) return;

    const target = 'a'.repeat(40);
    const workingFileUri = { scheme: 'file', fsPath: '/workspace/project/src/app.ts' };
    const context = {
      repository: {
        id: 'repo-1',
        rootUri: 'file:///workspace/project',
        gitDirUri: 'file:///workspace/project/.git',
        displayName: 'project',
        isBare: false,
        currentBranch: 'main',
      },
      repositoryRoot: '/workspace/project',
      repositoryPath: 'src/app.ts',
      absolutePath: '/workspace/project/src/app.ts',
    };
    const resolve = vi.fn().mockResolvedValue(context);
    const getRefs = vi.fn().mockResolvedValue([
      { fullName: 'HEAD', shortName: 'HEAD', kind: 'head', target, ahead: 0, behind: 0, isCurrent: true },
      { fullName: 'refs/heads/feature', shortName: 'feature', kind: 'local', target, ahead: 0, behind: 0, isCurrent: false },
      { fullName: 'refs/remotes/origin/main', shortName: 'origin/main', kind: 'remote', remote: 'origin', target, ahead: 0, behind: 0, isCurrent: false },
      { fullName: 'refs/tags/v1', shortName: 'v1', kind: 'tag', target, ahead: 0, behind: 0, isCurrent: false },
    ]);
    const openComparison = vi.fn().mockResolvedValue(undefined);
    const pickRef = vi.fn(
      async (groups: Array<{ label: string; items: Array<{ ref: { shortName: string; kind: string } }> }>) =>
        groups.flatMap((group) => group.items).find((item) => item.ref.shortName === 'feature')?.ref,
    );
    const showErrorMessage = vi.fn();
    const command = new commandModule.EditorFileComparisonCommand(
      { resolve } as unknown as EditorGitContextService,
      { getRefs } as unknown as GitService,
      { open: openComparison },
      {
        getActiveFile: () => ({
          fsPath: workingFileUri.fsPath,
          workingContent: 'unsaved editor content\n',
        }),
        pickRef,
        showErrorMessage,
      },
    );

    await command.run();

    expect(resolve).toHaveBeenCalledWith(workingFileUri.fsPath);
    expect(pickRef.mock.calls[0]?.[0].map((group) => group.label)).toEqual([
      'Local Branches',
      'Remote Branches',
      'Tags',
    ]);
    expect(pickRef.mock.calls[0]?.[0].flatMap((group) => group.items).map((item) => item.ref.kind)).toEqual([
      'local',
      'remote',
      'tag',
    ]);
    expect(openComparison).toHaveBeenCalledWith({
      repository: context.repository,
      cwd: '/workspace/project',
      revision: target,
      revisionLabel: 'feature',
      path: 'src/app.ts',
      workingContent: 'unsaved editor content\n',
    });
    expect(showErrorMessage).not.toHaveBeenCalled();
  });

  it('does nothing when the ref picker is cancelled', async () => {
    const { EditorFileComparisonCommand } = await import('../../src/editor/EditorFileComparisonCommand');
    const openComparison = vi.fn();
    const command = new EditorFileComparisonCommand(
      {
        resolve: vi.fn().mockResolvedValue({
          repository: {
            id: 'repo-1',
            rootUri: 'file:///repo',
            gitDirUri: 'file:///repo/.git',
            displayName: 'repo',
            isBare: false,
            currentBranch: 'main',
          },
          repositoryRoot: '/repo',
          repositoryPath: 'a.ts',
          absolutePath: '/repo/a.ts',
        }),
      } as unknown as EditorGitContextService,
      {
        getRefs: vi.fn().mockResolvedValue([
          { fullName: 'refs/heads/main', shortName: 'main', kind: 'local', target: 'a'.repeat(40), ahead: 0, behind: 0, isCurrent: true },
        ]),
      } as unknown as GitService,
      { open: openComparison },
      {
        getActiveFile: () => ({ fsPath: '/repo/a.ts' }),
        pickRef: () => Promise.resolve(undefined),
        showErrorMessage: vi.fn(),
      },
    );

    await command.run();

    expect(openComparison).not.toHaveBeenCalled();
  });

  it('opens the comparison tab when the selected ref does not contain the file', async () => {
    const { EditorFileComparisonCommand } = await import('../../src/editor/EditorFileComparisonCommand');
    const target = 'b'.repeat(40);
    const workingFileUri = { scheme: 'file', fsPath: '/repo/new.ts' };
    const openComparison = vi.fn().mockResolvedValue(undefined);
    const command = new EditorFileComparisonCommand(
      {
        resolve: vi.fn().mockResolvedValue({
          repository: {
            id: 'repo-1',
            rootUri: 'file:///repo',
            gitDirUri: 'file:///repo/.git',
            displayName: 'repo',
            isBare: false,
            currentBranch: 'main',
          },
          repositoryRoot: '/repo',
          repositoryPath: 'new.ts',
          absolutePath: '/repo/new.ts',
        }),
      } as unknown as EditorGitContextService,
      {
        getRefs: vi.fn().mockResolvedValue([
          {
            fullName: 'refs/tags/v1',
            shortName: 'v1',
            kind: 'tag',
            target,
            ahead: 0,
            behind: 0,
            isCurrent: false,
          },
        ]),
      } as unknown as GitService,
      { open: openComparison },
      {
        getActiveFile: () => ({ fsPath: workingFileUri.fsPath }),
        pickRef: async (groups) => groups[2]?.items[0]?.ref,
        showErrorMessage: vi.fn(),
      },
    );

    await command.run();

    expect(openComparison).toHaveBeenCalledWith({
      repository: expect.objectContaining({ id: 'repo-1' }),
      cwd: '/repo',
      revision: target,
      revisionLabel: 'v1',
      path: 'new.ts',
    });
  });
});
