import { describe, expect, it } from 'vitest';

describe('worktree line mapping', () => {
  it('maps lines after an uncommitted insertion back to their HEAD positions', async () => {
    const modulePath = '../../src/git/worktreeLineMapping';
    const mappingModule = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(mappingModule, 'worktreeLineMapping must exist').toBeDefined();
    if (!mappingModule) return;

    const result = mappingModule.mapWorktreeLineRange(
      '@@ -2,0 +3,2 @@\n+inserted one\n+inserted two\n',
      7,
      7,
    );

    expect(result).toEqual({
      status: 'mapped',
      startLine: 5,
      endLine: 5,
      partiallyUncommitted: false,
    });
  });

  it('reports a range made entirely of uncommitted added lines', async () => {
    const { mapWorktreeLineRange } = await import('../../src/git/worktreeLineMapping');

    expect(
      mapWorktreeLineRange('@@ -2,0 +3,2 @@\n+inserted one\n+inserted two\n', 3, 4),
    ).toEqual({ status: 'uncommitted-only' });
  });

  it('keeps the committed part of a selection containing an inserted line', async () => {
    const { mapWorktreeLineRange } = await import('../../src/git/worktreeLineMapping');

    expect(
      mapWorktreeLineRange('@@ -2,0 +3,1 @@\n+inserted\n', 2, 4),
    ).toEqual({
      status: 'mapped',
      startLine: 2,
      endLine: 3,
      partiallyUncommitted: true,
    });
  });

  it('rejects a selection whose mapped HEAD lines are discontinuous after a deletion', async () => {
    const { mapWorktreeLineRange } = await import('../../src/git/worktreeLineMapping');

    expect(
      mapWorktreeLineRange('@@ -3,2 +2,0 @@\n-deleted one\n-deleted two\n', 2, 3),
    ).toEqual({ status: 'discontinuous' });
  });

  it('maps replacement lines positionally and treats excess new lines as uncommitted', async () => {
    const { mapWorktreeLineRange } = await import('../../src/git/worktreeLineMapping');

    expect(
      mapWorktreeLineRange(
        '@@ -4,2 +4,3 @@\n-old one\n-old two\n+new one\n+new two\n+new three\n',
        4,
        6,
      ),
    ).toEqual({
      status: 'mapped',
      startLine: 4,
      endLine: 5,
      partiallyUncommitted: true,
    });
  });
});
