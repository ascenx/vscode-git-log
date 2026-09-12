import { describe, expect, it } from 'vitest';
import type { CommitSummary } from '../../src/shared/models';

function commit(hash: string, parents: string[] = []): CommitSummary {
  return {
    hash,
    parents,
    subject: hash,
    authorName: 'Graph Test',
    authorEmail: 'graph@example.com',
    authorTime: 0,
    commitTime: 0,
    refs: [],
  };
}

describe('layoutCommitGraph', () => {
  it('keeps a linear history in one stable lane across pagination', async () => {
    const modulePath = '../../src/graph/layoutCommitGraph';
    const graphModule = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(graphModule, 'the commit graph layout module must exist').toBeDefined();
    if (!graphModule) return;

    const firstPage = graphModule.layoutCommitGraph([
      commit('c3', ['c2']),
      commit('c2', ['c1']),
    ]);
    const secondPage = graphModule.layoutCommitGraph([commit('c1')], firstPage.continuation);

    expect(firstPage.rows.map((row: { nodeLane: number }) => row.nodeLane)).toEqual([0, 0]);
    expect(firstPage.continuation.lanes).toEqual([
      expect.objectContaining({ target: 'c1', colorIndex: 0 }),
    ]);
    expect(secondPage.rows[0]).toMatchObject({ nodeLane: 0, nodeColor: 0 });
    expect(secondPage.continuation.lanes).toEqual([]);
  });

  it('creates and rejoins lanes for a two-parent merge', async () => {
    const modulePath = '../../src/graph/layoutCommitGraph';
    const graphModule = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(graphModule, 'the commit graph layout module must exist').toBeDefined();
    if (!graphModule) return;

    const result = graphModule.layoutCommitGraph([
      commit('merge', ['main', 'feature']),
      commit('main', ['root']),
      commit('feature', ['root']),
      commit('root'),
    ]);

    expect(result.rows.map((row: { nodeLane: number }) => row.nodeLane)).toEqual([0, 0, 1, 0]);
    expect(result.rows[0].lanesAfter.map((lane: { target: string }) => lane.target)).toEqual([
      'main',
      'feature',
    ]);
    expect(result.rows[2].connections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fromLane: 1, toLane: 0, kind: 'parent' }),
      ]),
    );
    expect(result.continuation.lanes).toEqual([]);
  });

  it('supports octopus merges with more than two parents', async () => {
    const modulePath = '../../src/graph/layoutCommitGraph';
    const graphModule = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(graphModule, 'the commit graph layout module must exist').toBeDefined();
    if (!graphModule) return;

    const result = graphModule.layoutCommitGraph([
      commit('octopus', ['p1', 'p2', 'p3']),
      commit('p1', ['root']),
      commit('p2', ['root']),
      commit('p3', ['root']),
      commit('root'),
    ]);

    expect(result.rows[0].lanesAfter.map((lane: { target: string }) => lane.target)).toEqual([
      'p1',
      'p2',
      'p3',
    ]);
    expect(result.rows.map((row: { nodeLane: number }) => row.nodeLane)).toEqual([0, 0, 1, 1, 0]);
  });

  it('uses collapsed graph parents for commits separated by hidden search results', async () => {
    const modulePath = '../../src/graph/layoutCommitGraph';
    const graphModule = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(graphModule, 'the commit graph layout module must exist').toBeDefined();
    if (!graphModule) return;

    const result = graphModule.layoutCommitGraph([
      { ...commit('visible-child', ['hidden-parent']), graphParents: ['visible-parent'] },
      { ...commit('visible-parent', ['older-hidden-parent']), graphParents: [] },
    ]);

    expect(result.maxLaneCount).toBe(1);
    expect(result.rows.map((row: { nodeLane: number }) => row.nodeLane)).toEqual([0, 0]);
    expect(result.continuation.lanes).toEqual([]);
  });

  it('keeps a hidden ancestry route collapsed until its visible parent is reached', async () => {
    const modulePath = '../../src/graph/layoutCommitGraph';
    const graphModule = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(graphModule, 'the commit graph layout module must exist').toBeDefined();
    if (!graphModule) return;

    const result = graphModule.layoutCommitGraph([
      { ...commit('visible-child', ['hidden-parent']), graphParents: ['visible-parent'] },
      { ...commit('unrelated-match'), graphParents: [] },
      { ...commit('visible-parent'), graphParents: [] },
    ]);

    expect(result.rows[0]?.connections).toEqual([
      expect.objectContaining({ kind: 'parent', collapsed: true }),
    ]);
    expect(result.rows[1]?.connections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'through', collapsed: true }),
      ]),
    );
    expect(result.rows[2]?.connections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'incoming', collapsed: true }),
      ]),
    );
    expect(result.continuation.lanes).toEqual([]);
  });

  it('keeps direct and collapsed routes separate when they share a visible parent across pages', async () => {
    const modulePath = '../../src/graph/layoutCommitGraph';
    const graphModule = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(graphModule, 'the commit graph layout module must exist').toBeDefined();
    if (!graphModule) return;

    const firstPage = graphModule.layoutCommitGraph([
      { ...commit('collapsed-child', ['hidden']), graphParents: ['parent'] },
    ]);
    const secondPage = graphModule.layoutCommitGraph(
      [
        { ...commit('direct-child', ['parent']), graphParents: ['parent'] },
        { ...commit('parent'), graphParents: [] },
      ],
      firstPage.continuation,
    );

    expect(secondPage.rows[0]?.lanesAfter).toEqual([
      expect.objectContaining({ target: 'parent', collapsed: true }),
      expect.not.objectContaining({ collapsed: true }),
    ]);
    const incoming = secondPage.rows[1]?.connections.filter(
      (connection: { kind: string }) => connection.kind === 'incoming',
    );
    expect(incoming).toHaveLength(2);
    expect(incoming).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ collapsed: true }),
        expect.not.objectContaining({ collapsed: true }),
      ]),
    );
  });
});
