import type { CommitSummary } from '../shared/models';

export interface GraphLane {
  id: number;
  target: string;
  colorIndex: number;
}

export interface GraphContinuationState {
  lanes: GraphLane[];
  nextLaneId: number;
  nextColorIndex: number;
}

export type GraphConnectionKind = 'through' | 'incoming' | 'parent';

export interface GraphConnection {
  fromLane: number;
  toLane: number;
  colorIndex: number;
  kind: GraphConnectionKind;
}

export interface GraphRow {
  hash: string;
  nodeLane: number;
  nodeColor: number;
  lanesBefore: GraphLane[];
  lanesAfter: GraphLane[];
  connections: GraphConnection[];
}

export interface GraphLayoutResult {
  rows: GraphRow[];
  continuation: GraphContinuationState;
  maxLaneCount: number;
}

function cloneLanes(lanes: readonly GraphLane[]): GraphLane[] {
  return lanes.map((lane) => ({ ...lane }));
}

export function layoutCommitGraph(
  commits: readonly Pick<CommitSummary, 'hash' | 'parents'>[],
  continuation?: GraphContinuationState,
): GraphLayoutResult {
  const active = cloneLanes(continuation?.lanes ?? []);
  let nextLaneId = continuation?.nextLaneId ?? 0;
  let nextColorIndex = continuation?.nextColorIndex ?? 0;
  let maxLaneCount = active.length;
  const rows: GraphRow[] = [];

  const createLane = (target: string): GraphLane => ({
    id: nextLaneId++,
    target,
    colorIndex: nextColorIndex++,
  });

  for (const commit of commits) {
    const existingMatches = active
      .map((lane, index) => ({ lane, index }))
      .filter(({ lane }) => lane.target === commit.hash);

    let nodeLane: number;
    let node: GraphLane;
    let lanesBefore: GraphLane[];

    if (existingMatches.length) {
      nodeLane = existingMatches[0]?.index ?? 0;
      node = active[nodeLane] as GraphLane;
      lanesBefore = cloneLanes(active);
    } else {
      nodeLane = active.length;
      node = createLane(commit.hash);
      lanesBefore = cloneLanes(active);
      active.push(node);
    }

    const nodeColor = node.colorIndex;
    const connections: GraphConnection[] = [];

    for (let index = lanesBefore.length - 1; index >= 0; index -= 1) {
      const lane = lanesBefore[index];
      if (lane?.target === commit.hash && lane.id !== node.id) {
        const activeIndex = active.findIndex((candidate) => candidate.id === lane.id);
        if (activeIndex !== -1) active.splice(activeIndex, 1);
      }
    }

    const parentAssignments: { parent: string; laneId: number }[] = [];
    const firstParent = commit.parents[0];
    if (!firstParent) {
      const currentIndex = active.findIndex((lane) => lane.id === node.id);
      if (currentIndex !== -1) active.splice(currentIndex, 1);
    } else {
      const existingParentLane = active.find(
        (lane) => lane.id !== node.id && lane.target === firstParent,
      );
      if (existingParentLane) {
        parentAssignments.push({ parent: firstParent, laneId: existingParentLane.id });
        const currentIndex = active.findIndex((lane) => lane.id === node.id);
        if (currentIndex !== -1) active.splice(currentIndex, 1);
      } else {
        node.target = firstParent;
        parentAssignments.push({ parent: firstParent, laneId: node.id });
      }
    }

    for (const parent of commit.parents.slice(1)) {
      const existingParentLane = active.find((lane) => lane.target === parent);
      if (existingParentLane) {
        parentAssignments.push({ parent, laneId: existingParentLane.id });
        continue;
      }

      const lane = createLane(parent);
      const assignedIndices = parentAssignments
        .map((assignment) => active.findIndex((candidate) => candidate.id === assignment.laneId))
        .filter((index) => index >= 0);
      const insertionIndex = assignedIndices.length
        ? Math.max(...assignedIndices) + 1
        : Math.min(nodeLane + 1, active.length);
      active.splice(insertionIndex, 0, lane);
      parentAssignments.push({ parent, laneId: lane.id });
    }

    const lanesAfter = cloneLanes(active);

    for (const [index, lane] of lanesBefore.entries()) {
      if (lane.target === commit.hash) {
        connections.push({
          fromLane: index,
          toLane: nodeLane,
          colorIndex: lane.colorIndex,
          kind: 'incoming',
        });
        continue;
      }

      const toLane = lanesAfter.findIndex((candidate) => candidate.id === lane.id);
      if (toLane !== -1) {
        connections.push({
          fromLane: index,
          toLane,
          colorIndex: lane.colorIndex,
          kind: 'through',
        });
      }
    }

    for (const assignment of parentAssignments) {
      const toLane = lanesAfter.findIndex((lane) => lane.id === assignment.laneId);
      if (toLane !== -1) {
        const lane = lanesAfter[toLane];
        connections.push({
          fromLane: nodeLane,
          toLane,
          colorIndex: lane?.colorIndex ?? nodeColor,
          kind: 'parent',
        });
      }
    }

    maxLaneCount = Math.max(maxLaneCount, lanesBefore.length, lanesAfter.length, nodeLane + 1);
    rows.push({
      hash: commit.hash,
      nodeLane,
      nodeColor,
      lanesBefore,
      lanesAfter,
      connections,
    });
  }

  return {
    rows,
    continuation: {
      lanes: cloneLanes(active),
      nextLaneId,
      nextColorIndex,
    },
    maxLaneCount,
  };
}
