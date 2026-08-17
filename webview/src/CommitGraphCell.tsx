import type { GraphConnection, GraphRow } from '../../src/graph/layoutCommitGraph';

const ROW_HEIGHT = 28;
const NODE_Y = ROW_HEIGHT / 2;
const LANE_SPACING = 12;
const LANE_OFFSET = 8;
const colors = [
  'var(--vscode-charts-blue)',
  'var(--vscode-charts-orange)',
  'var(--vscode-charts-green)',
  'var(--vscode-charts-purple)',
  'var(--vscode-charts-red)',
  'var(--vscode-charts-yellow)',
  'var(--vscode-charts-foreground)',
] as const;

function laneX(lane: number): number {
  return LANE_OFFSET + lane * LANE_SPACING;
}

function connectionPath(connection: GraphConnection): string {
  const fromX = laneX(connection.fromLane);
  const toX = laneX(connection.toLane);
  const startY = connection.kind === 'parent' ? NODE_Y : 0;
  const endY = connection.kind === 'incoming' ? NODE_Y : ROW_HEIGHT;

  if (fromX === toX) return `M ${String(fromX)} ${String(startY)} L ${String(toX)} ${String(endY)}`;

  const controlY = (startY + endY) / 2;
  return `M ${String(fromX)} ${String(startY)} C ${String(fromX)} ${String(controlY)}, ${String(
    toX,
  )} ${String(controlY)}, ${String(toX)} ${String(endY)}`;
}

function color(colorIndex: number): string {
  return colors[colorIndex % colors.length] ?? colors[0];
}

export interface CommitGraphCellProps {
  row: GraphRow;
  maxLaneCount: number;
}

export function CommitGraphCell({ row, maxLaneCount }: CommitGraphCellProps) {
  const width = Math.max(28, LANE_OFFSET * 2 + Math.max(1, maxLaneCount) * LANE_SPACING);
  const nodeX = laneX(row.nodeLane);
  const nodeColor = color(row.nodeColor);

  return (
    <svg
      className="commit-graph"
      data-testid={`commit-graph-${row.hash}`}
      width={width}
      height={ROW_HEIGHT}
      viewBox={`0 0 ${String(width)} ${String(ROW_HEIGHT)}`}
      aria-hidden="true"
    >
      {row.connections.map((connection, index) => (
        <path
          key={`${connection.kind}:${String(connection.fromLane)}:${String(connection.toLane)}:${String(index)}`}
          d={connectionPath(connection)}
          fill="none"
          stroke={color(connection.colorIndex)}
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />
      ))}
      <circle
        cx={nodeX}
        cy={NODE_Y}
        r="4.2"
        fill="var(--vscode-editor-background)"
        stroke={nodeColor}
        strokeWidth="1.7"
      />
      <circle cx={nodeX} cy={NODE_Y} r="1.8" fill={nodeColor} />
    </svg>
  );
}
