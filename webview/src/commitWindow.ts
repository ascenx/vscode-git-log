import {
  layoutCommitGraph,
  type GraphContinuationState,
} from '../../src/graph/layoutCommitGraph';
import type { CommitSummary } from '../../src/shared/models';

export interface CommitWindowState {
  commits: CommitSummary[];
  graphContinuation: GraphContinuationState | undefined;
  nextLogOffset: number;
  startLogOffset: number;
  /** Rendered rows discarded from the front; unlike startLogOffset, this includes graph context. */
  startRowOffset: number;
}

function logCommitCount(commits: readonly CommitSummary[]): number {
  return commits.filter((commit) => commit.filterMatch !== false).length;
}

function acceptCompleteContextGroups(
  incoming: readonly CommitSummary[],
  capacity: number,
): readonly CommitSummary[] {
  let end = Math.min(incoming.length, capacity);
  // Capacity is soft at a group boundary: a context row omitted here cannot be requested again,
  // because the next Git offset starts at the following matching commit.
  while (end < incoming.length && incoming[end]?.filterMatch === false) end += 1;
  return incoming.slice(0, end);
}

export function advanceCommitWindow(
  current: CommitWindowState | undefined,
  incoming: readonly CommitSummary[],
  maxCachedCommits: number,
  replace: boolean,
  incomingOffset = 0,
  incomingGraphContinuation?: GraphContinuationState,
): CommitWindowState {
  const capacity = Math.max(1, Math.floor(maxCachedCommits));
  const accepted = acceptCompleteContextGroups(incoming, capacity);
  if (replace || !current) {
    return {
      commits: [...accepted],
      graphContinuation: incomingGraphContinuation,
      nextLogOffset: incomingOffset + logCommitCount(accepted),
      startLogOffset: incomingOffset,
      startRowOffset: 0,
    };
  }

  const accumulated = [...current.commits, ...accepted];
  const droppedCount = Math.max(0, accumulated.length - capacity);
  const dropped = accumulated.slice(0, droppedCount);
  const graphContinuation = droppedCount
    ? layoutCommitGraph(
        dropped,
        current.graphContinuation,
      ).continuation
    : current.graphContinuation;

  return {
    commits: accumulated.slice(droppedCount),
    graphContinuation,
    nextLogOffset: current.nextLogOffset + logCommitCount(accepted),
    startLogOffset: current.startLogOffset + logCommitCount(dropped),
    startRowOffset: current.startRowOffset + droppedCount,
  };
}
