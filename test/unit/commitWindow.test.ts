import { describe, expect, it } from 'vitest';
import { layoutCommitGraph } from '../../src/graph/layoutCommitGraph';
import type { CommitSummary } from '../../src/shared/models';
import { advanceCommitWindow } from '../../webview/src/commitWindow';

function commit(hash: string, parents: string[] = []): CommitSummary {
  return {
    hash,
    parents,
    subject: hash,
    authorName: 'Alice',
    authorEmail: 'alice@example.com',
    authorTime: 1,
    commitTime: 1,
    refs: [],
  };
}

describe('advanceCommitWindow', () => {
  it('never advances past commits that could not fit in the retained window', () => {
    const initial = advanceCommitWindow(undefined, [commit('c1'), commit('c2')], 3, true);
    const appended = advanceCommitWindow(
      initial,
      [commit('c3'), commit('c4'), commit('c5'), commit('c6')],
      3,
      false,
    );

    expect(appended.commits.map((entry) => entry.hash)).toEqual(['c3', 'c4', 'c5']);
    expect(appended.nextLogOffset).toBe(5);
    expect(appended.startLogOffset).toBe(2);
  });

  it('preserves graph lanes and colors when older window rows are discarded', () => {
    const commits = [
      commit('merge', ['main', 'side']),
      commit('main', ['base']),
      commit('side', ['base']),
      commit('base', ['root']),
      commit('root'),
    ];
    const full = layoutCommitGraph(commits);
    const initial = advanceCommitWindow(undefined, commits.slice(0, 3), 4, true);
    const appended = advanceCommitWindow(initial, commits.slice(3), 4, false);
    const retainedGraph = layoutCommitGraph(appended.commits, appended.graphContinuation);
    const firstRetainedIndex = commits.findIndex(
      (entry) => entry.hash === appended.commits[0]?.hash,
    );

    expect(retainedGraph.rows).toEqual(full.rows.slice(firstRetainedIndex));
  });

  it('restores a replacement window from a persisted global offset', () => {
    const prefix = [commit('merge', ['main', 'side']), commit('main', ['base'])];
    const incoming = [commit('side', ['base']), commit('base', ['root']), commit('root')];
    const continuation = layoutCommitGraph(prefix).continuation;
    const restored = advanceCommitWindow(
      undefined,
      incoming,
      5000,
      true,
      5000,
      continuation,
    );

    expect(restored.startLogOffset).toBe(5000);
    expect(restored.nextLogOffset).toBe(5003);
    expect(layoutCommitGraph(restored.commits, restored.graphContinuation).rows).toEqual(
      layoutCommitGraph([...prefix, ...incoming]).rows.slice(prefix.length),
    );
  });
});
