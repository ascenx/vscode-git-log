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
  const accepted = incoming.slice(0, capacity);
  if (replace || !current) {
    return {
      commits: [...accepted],
      graphContinuation: incomingGraphContinuation,
      nextLogOffset: incomingOffset + accepted.length,
      startLogOffset: incomingOffset,
    };
  }

  const accumulated = [...current.commits, ...accepted];
  const droppedCount = Math.max(0, accumulated.length - capacity);
  const graphContinuation = droppedCount
    ? layoutCommitGraph(
        accumulated.slice(0, droppedCount),
        current.graphContinuation,
      ).continuation
    : current.graphContinuation;

  return {
    commits: accumulated.slice(droppedCount),
    graphContinuation,
    nextLogOffset: current.nextLogOffset + accepted.length,
    startLogOffset: current.startLogOffset + droppedCount,
  };
}
