import { describe, expect, it } from 'vitest';

describe('Git revision diff model', () => {
  it('builds correct empty and historical sides for add, delete, and rename', async () => {
    const modulePath = '../../src/diff/diffModel';
    const diffModule = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(diffModule, 'the diff model must exist').toBeDefined();
    if (!diffModule) return;

    expect(
      diffModule.buildDiffSides({
        hash: 'bbbbbbb',
        path: 'new.ts',
        status: 'A',
      }),
    ).toEqual({
      left: { kind: 'empty', path: 'new.ts' },
      right: { kind: 'revision', revision: 'bbbbbbb', path: 'new.ts' },
    });

    expect(
      diffModule.buildDiffSides({
        hash: 'bbbbbbb',
        parent: 'aaaaaaa',
        path: 'deleted.ts',
        status: 'D',
      }),
    ).toEqual({
      left: { kind: 'revision', revision: 'aaaaaaa', path: 'deleted.ts' },
      right: { kind: 'empty', path: 'deleted.ts' },
    });

    expect(
      diffModule.buildDiffSides({
        hash: 'bbbbbbb',
        parent: 'aaaaaaa',
        oldPath: 'old name.ts',
        path: '新名字.ts',
        status: 'R',
      }),
    ).toEqual({
      left: { kind: 'revision', revision: 'aaaaaaa', path: 'old name.ts' },
      right: { kind: 'revision', revision: 'bbbbbbb', path: '新名字.ts' },
    });
  });

  it('round-trips revision query values containing reserved characters', async () => {
    const modulePath = '../../src/diff/diffModel';
    const diffModule = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(diffModule, 'the diff model must exist').toBeDefined();
    if (!diffModule) return;

    const encoded = diffModule.encodeRevisionQuery({
      repositoryId: 'repo:1',
      revision: 'abcdef1',
      path: 'src/中文 #1?.ts',
      empty: false,
    });

    expect(diffModule.parseRevisionQuery(encoded)).toEqual({
      repositoryId: 'repo:1',
      revision: 'abcdef1',
      path: 'src/中文 #1?.ts',
      empty: false,
    });
    expect(diffModule.parseRevisionQuery('repositoryId=missing-fields')).toBeUndefined();
  });

  it('selects the existing historical side when opening a changed file at a revision', async () => {
    const { buildRevisionFileTarget } = await import('../../src/diff/diffModel');

    expect(
      buildRevisionFileTarget({
        hash: 'bbbbbbb',
        parent: 'aaaaaaa',
        path: 'deleted.ts',
        status: 'D',
      }),
    ).toEqual({ revision: 'aaaaaaa', path: 'deleted.ts' });
    expect(
      buildRevisionFileTarget({
        hash: 'bbbbbbb',
        parent: 'aaaaaaa',
        oldPath: 'old.ts',
        path: 'new.ts',
        status: 'R',
      }),
    ).toEqual({ revision: 'bbbbbbb', path: 'new.ts' });
  });
});
