import { describe, expect, it, vi } from 'vitest';
import type { EditorGitContextService } from '../../src/editor/EditorGitContextService';
import type { GitService } from '../../src/git/GitService';
import type { LineBlameService } from '../../src/git/LineBlameService';

const context = {
  repository: {
    id: 'repo-1',
    rootUri: 'file:///repo',
    gitDirUri: 'file:///repo/.git',
    displayName: 'repo',
    isBare: false,
    userName: 'Repository User',
    userEmail: 'repository@example.com',
  },
  repositoryRoot: '/repo',
  repositoryPath: 'lib/activity.dart',
  absolutePath: '/repo/lib/activity.dart',
};

const blame = {
  hash: 'a'.repeat(40),
  authorName: 'Ryan Zhang',
  authorEmail: 'ryan@example.com',
  authorTime: 1777016520,
  subject: 'feat(spot): add activity banner',
  committed: true,
};

describe('CurrentLineBlameController', () => {
  it('renders inline blame and complete hover data for the active cursor line', async () => {
    const modulePath = '../../src/editor/CurrentLineBlameController';
    const controllerModule = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(controllerModule, 'CurrentLineBlameController must exist').toBeDefined();
    if (!controllerModule) return;

    const resolve = vi.fn().mockResolvedValue(context);
    const getLineBlame = vi.fn().mockResolvedValue(blame);
    const getCommitMessage = vi
      .fn()
      .mockResolvedValue('feat(spot): add activity banner\n\nReason and implementation details.');
    const render = vi.fn();
    const controller = new controllerModule.CurrentLineBlameController(
      { resolve } as unknown as EditorGitContextService,
      { getLineBlame } as unknown as LineBlameService,
      { getCommitMessage } as unknown as GitService,
      {
        getActiveEditor: () => ({
          key: 'file:///repo/lib/activity.dart:4:7',
          fsPath: '/repo/lib/activity.dart',
          line: 7,
          workingContent: 'contents',
        }),
        render,
        locale: 'zh-CN',
        now: () => 1787250547000,
      },
    );

    await controller.refresh();

    expect(resolve).toHaveBeenCalledWith('/repo/lib/activity.dart');
    expect(getLineBlame).toHaveBeenCalledWith('/repo', 'lib/activity.dart', 8, {
      content: 'contents',
      signal: expect.any(AbortSignal),
    });
    expect(getCommitMessage).toHaveBeenCalledWith('/repo', blame.hash, expect.any(AbortSignal));
    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'file:///repo/lib/activity.dart:4:7' }),
      expect.objectContaining({
        contentText: expect.stringMatching(/^Ryan Zhang, .+ · feat\(spot\): add activity banner$/u),
        authorName: 'Ryan Zhang',
        authorEmail: 'ryan@example.com',
        hash: blame.hash,
        message: 'feat(spot): add activity banner\n\nReason and implementation details.',
        committed: true,
      }),
    );
  });

  it('renders the inline subject before the full commit message finishes loading', async () => {
    const { CurrentLineBlameController } =
      await import('../../src/editor/CurrentLineBlameController');
    let resolveMessage: ((message: string) => void) | undefined;
    const message = new Promise<string>((resolve) => {
      resolveMessage = resolve;
    });
    const render = vi.fn();
    const controller = new CurrentLineBlameController(
      { resolve: vi.fn().mockResolvedValue(context) } as unknown as EditorGitContextService,
      { getLineBlame: vi.fn().mockResolvedValue(blame) } as unknown as LineBlameService,
      { getCommitMessage: vi.fn().mockReturnValue(message) } as unknown as GitService,
      {
        getActiveEditor: () => ({
          key: 'editor:eager',
          fsPath: context.absolutePath,
          line: 1,
        }),
        render,
        locale: 'en',
        now: () => 1787250547000,
      },
    );

    const refresh = controller.refresh();
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1));
    expect(render).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ message: blame.subject }),
    );

    resolveMessage?.('complete commit message');
    await refresh;

    expect(render).toHaveBeenCalledTimes(2);
    expect(render).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ message: 'complete commit message' }),
    );
  });

  it('keeps inline blame visible when loading the full commit message fails', async () => {
    const { CurrentLineBlameController } =
      await import('../../src/editor/CurrentLineBlameController');
    const messageError = new Error('commit message unavailable');
    const render = vi.fn();
    const onError = vi.fn();
    const getCommitMessage = vi
      .fn()
      .mockRejectedValueOnce(messageError)
      .mockResolvedValueOnce('complete commit message');
    const controller = new CurrentLineBlameController(
      { resolve: vi.fn().mockResolvedValue(context) } as unknown as EditorGitContextService,
      { getLineBlame: vi.fn().mockResolvedValue(blame) } as unknown as LineBlameService,
      {
        getCommitMessage,
      } as unknown as GitService,
      {
        getActiveEditor: () => ({
          key: 'editor:message-error',
          fsPath: context.absolutePath,
          line: 1,
        }),
        render,
        onError,
        locale: 'en',
        now: () => 1787250547000,
      },
    );

    await controller.refresh();

    expect(render).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ message: blame.subject }),
    );
    expect(onError).toHaveBeenCalledWith(messageError);

    await controller.refresh();

    expect(getCommitMessage).toHaveBeenCalledTimes(2);
    expect(render).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ message: 'complete commit message' }),
    );
  });

  it('does not load a commit message for an uncommitted line', async () => {
    const { CurrentLineBlameController } =
      await import('../../src/editor/CurrentLineBlameController');
    const getCommitMessage = vi.fn();
    const render = vi.fn();
    const controller = new CurrentLineBlameController(
      {
        resolve: vi.fn().mockResolvedValue(context),
      } as unknown as EditorGitContextService,
      {
        getLineBlame: vi.fn().mockResolvedValue({
          ...blame,
          hash: '0'.repeat(40),
          committed: false,
        }),
      } as unknown as LineBlameService,
      { getCommitMessage } as unknown as GitService,
      {
        getActiveEditor: () => ({
          key: 'editor:1',
          fsPath: context.absolutePath,
          line: 1,
          editTime: 1787250487000,
        }),
        render,
        locale: 'zh-CN',
        now: () => 1787250547000,
      },
    );

    await controller.refresh();

    expect(getCommitMessage).not.toHaveBeenCalled();
    expect(render).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        contentText: 'Repository User, 1分钟前 · 未提交的更改',
        authorName: 'Repository User',
        authorEmail: 'repository@example.com',
        committed: false,
      }),
    );
    const presentation = render.mock.calls[0]?.[1];
    expect(presentation?.authoredAt).toBeDefined();
    expect(presentation?.relativeTime).toBe('1分钟前');
  });

  it('refreshes an uncommitted line from now to one minute ago without another blame', async () => {
    vi.useFakeTimers();
    try {
      const { CurrentLineBlameController } =
        await import('../../src/editor/CurrentLineBlameController');
      const editedAt = 1787250547000;
      let now = editedAt;
      const getLineBlame = vi.fn().mockResolvedValue({
        ...blame,
        hash: '0'.repeat(40),
        committed: false,
      });
      const render = vi.fn();
      const controller = new CurrentLineBlameController(
        {
          resolve: vi.fn().mockResolvedValue(context),
        } as unknown as EditorGitContextService,
        { getLineBlame } as unknown as LineBlameService,
        { getCommitMessage: vi.fn() } as unknown as GitService,
        {
          getActiveEditor: () => ({
            key: 'editor:timed',
            fsPath: context.absolutePath,
            line: 1,
            editTime: editedAt,
          }),
          render,
          locale: 'zh-CN',
          now: () => now,
        },
      );

      await controller.refresh();
      expect(render).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({
          contentText: 'Repository User, 现在 · 未提交的更改',
        }),
      );

      now += 60_000;
      await vi.advanceTimersByTimeAsync(60_000);

      expect(getLineBlame).toHaveBeenCalledTimes(1);
      expect(render).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({
          contentText: 'Repository User, 1分钟前 · 未提交的更改',
        }),
      );
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reuses repository context while moving between lines in the same file', async () => {
    const { CurrentLineBlameController } =
      await import('../../src/editor/CurrentLineBlameController');
    let active = { key: 'editor:line1', fsPath: context.absolutePath, line: 1 };
    const resolve = vi.fn().mockResolvedValue(context);
    const controller = new CurrentLineBlameController(
      { resolve } as unknown as EditorGitContextService,
      {
        getLineBlame: vi.fn().mockResolvedValue(blame),
      } as unknown as LineBlameService,
      {
        getCommitMessage: vi.fn().mockResolvedValue(blame.subject),
      } as unknown as GitService,
      {
        getActiveEditor: () => active,
        render: vi.fn(),
        locale: 'en',
        now: () => 1787250547000,
      },
    );

    await controller.refresh();
    active = { ...active, key: 'editor:line2', line: 2 };
    await controller.refresh();

    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('ignores repeated selection events for the same document version and line', async () => {
    const { CurrentLineBlameController } =
      await import('../../src/editor/CurrentLineBlameController');
    const getLineBlame = vi.fn().mockResolvedValue(blame);
    const render = vi.fn();
    const controller = new CurrentLineBlameController(
      {
        resolve: vi.fn().mockResolvedValue(context),
      } as unknown as EditorGitContextService,
      { getLineBlame } as unknown as LineBlameService,
      {
        getCommitMessage: vi.fn().mockResolvedValue(blame.subject),
      } as unknown as GitService,
      {
        getActiveEditor: () => ({
          key: 'same-editor-line',
          fsPath: context.absolutePath,
          line: 1,
        }),
        render,
        locale: 'en',
        now: () => 1787250547000,
      },
    );

    await controller.refresh();
    await controller.refresh();

    expect(getLineBlame).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledTimes(2);
  });

  it('reloads the same line after repository state invalidation', async () => {
    const { CurrentLineBlameController } =
      await import('../../src/editor/CurrentLineBlameController');
    const getLineBlame = vi.fn().mockResolvedValue(blame);
    const resolve = vi.fn().mockResolvedValue(context);
    const controller = new CurrentLineBlameController(
      {
        resolve,
      } as unknown as EditorGitContextService,
      { getLineBlame } as unknown as LineBlameService,
      {
        getCommitMessage: vi.fn().mockResolvedValue(blame.subject),
      } as unknown as GitService,
      {
        getActiveEditor: () => ({
          key: 'same-editor-line',
          fsPath: context.absolutePath,
          line: 1,
        }),
        render: vi.fn(),
        locale: 'en',
        now: () => 1787250547000,
      },
    );

    await controller.refresh();
    controller.invalidate();
    await controller.refresh();

    expect(getLineBlame).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('reports non-cancellation refresh failures to the host', async () => {
    const { CurrentLineBlameController } =
      await import('../../src/editor/CurrentLineBlameController');
    const error = new Error('repository lookup failed');
    const onError = vi.fn();
    const controller = new CurrentLineBlameController(
      {
        resolve: vi.fn().mockRejectedValue(error),
      } as unknown as EditorGitContextService,
      { getLineBlame: vi.fn() } as unknown as LineBlameService,
      { getCommitMessage: vi.fn() } as unknown as GitService,
      {
        getActiveEditor: () => ({
          key: 'editor:error',
          fsPath: context.absolutePath,
          line: 1,
        }),
        render: vi.fn(),
        onError,
        locale: 'en',
        now: () => 1787250547000,
      },
    );

    await controller.refresh();

    expect(onError).toHaveBeenCalledWith(error);
  });

  it('drops stale blame results after the cursor moves', async () => {
    const { CurrentLineBlameController } =
      await import('../../src/editor/CurrentLineBlameController');
    let active = { key: 'editor:1', fsPath: context.absolutePath, line: 1 };
    let resolveFirst: ((value: typeof blame) => void) | undefined;
    const first = new Promise<typeof blame>((resolve) => {
      resolveFirst = resolve;
    });
    const getLineBlame = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({ ...blame, subject: 'second line' });
    const render = vi.fn();
    const controller = new CurrentLineBlameController(
      {
        resolve: vi.fn().mockResolvedValue(context),
      } as unknown as EditorGitContextService,
      { getLineBlame } as unknown as LineBlameService,
      {
        getCommitMessage: vi.fn().mockResolvedValue('second line'),
      } as unknown as GitService,
      {
        getActiveEditor: () => active,
        render,
        locale: 'en',
        now: () => 1787250547000,
      },
    );

    const staleRefresh = controller.refresh();
    await vi.waitFor(() => expect(getLineBlame).toHaveBeenCalledTimes(1));
    active = { ...active, key: 'editor:1:line2', line: 2 };
    await controller.refresh();
    resolveFirst?.(blame);
    await staleRefresh;

    expect(render).toHaveBeenCalledTimes(2);
    for (const [renderedEditor, presentation] of render.mock.calls) {
      expect(renderedEditor).toEqual(expect.objectContaining({ key: 'editor:1:line2' }));
      expect(presentation).toEqual(
        expect.objectContaining({ contentText: expect.stringContaining('second line') }),
      );
    }
  });
});
