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
  it('does not count structural graph context as a Git log offset', () => {
    const context = { ...commit('context'), filterMatch: false };
    const initial = advanceCommitWindow(
      undefined,
      [commit('c1'), context, commit('c2')],
      5,
      true,
    );
    const appended = advanceCommitWindow(initial, [commit('c3')], 3, false);

    expect(initial.nextLogOffset).toBe(2);
    expect(appended.commits.map((entry) => entry.hash)).toEqual(['context', 'c2', 'c3']);
    expect(appended.startLogOffset).toBe(1);
    expect(appended.nextLogOffset).toBe(3);
  });

  it('does not truncate the structural context group of an accepted match', () => {
    const contexts = ['context-1', 'context-2', 'context-3'].map((hash) => ({
      ...commit(hash),
      filterMatch: false as const,
    }));
    const state = advanceCommitWindow(
      undefined,
      [commit('c1'), ...contexts, commit('c2')],
      3,
      true,
    );

    expect(state.commits.map((entry) => entry.hash)).toEqual([
      'c1',
      'context-1',
      'context-2',
      'context-3',
    ]);
    expect(state.nextLogOffset).toBe(1);
  });

  it('tracks evicted render rows separately from the Git log offset', () => {
    const context = { ...commit('context'), filterMatch: false as const };
    const initial = advanceCommitWindow(
      undefined,
      [commit('c1'), context, commit('c2')],
      3,
      true,
    );
    const afterMatch = advanceCommitWindow(initial, [commit('c3')], 3, false);
    const afterContext = advanceCommitWindow(afterMatch, [commit('c4')], 3, false);

    expect(afterMatch.startLogOffset).toBe(1);
    expect(afterMatch.startRowOffset).toBe(1);
    expect(afterContext.startLogOffset).toBe(1);
    expect(afterContext.startRowOffset).toBe(2);
  });

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
