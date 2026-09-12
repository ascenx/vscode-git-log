import type { GraphConnection, GraphRow } from '../../src/graph/layoutCommitGraph';

const ROW_HEIGHT = 28;
const NODE_Y = ROW_HEIGHT / 2;
const LANE_SPACING = 12;
const LANE_OFFSET = 8;
const MAX_GRAPH_VIEWPORT_WIDTH = 160;
const ELISION_GUTTER_LEFT = 145;
const MAX_VISIBLE_NODE_X = 140;
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
  const graphWidth = Math.max(28, LANE_OFFSET * 2 + Math.max(1, maxLaneCount) * LANE_SPACING);
  const viewportWidth = Math.min(graphWidth, MAX_GRAPH_VIEWPORT_WIDTH);
  const nodeX = laneX(row.nodeLane);
  const graphClipped = graphWidth > viewportWidth;
  const graphContentWidth = graphClipped ? ELISION_GUTTER_LEFT : viewportWidth;
  const nodeClipped = graphClipped && nodeX > MAX_VISIBLE_NODE_X;
  const nodeColor = color(row.nodeColor);
  const clipId = `commit-graph-clip-${row.hash}`;

  return (
    <span className="commit-graph-viewport" style={{ width: viewportWidth }}>
      <svg
        className="commit-graph"
        data-testid={`commit-graph-${row.hash}`}
        data-node-clipped={nodeClipped ? 'true' : undefined}
        width={viewportWidth}
        height={ROW_HEIGHT}
        viewBox={`0 0 ${String(viewportWidth)} ${String(ROW_HEIGHT)}`}
        aria-hidden="true"
      >
        <defs>
          <clipPath id={clipId}>
            <rect width={graphContentWidth} height={ROW_HEIGHT} />
          </clipPath>
        </defs>
        <g clipPath={`url(#${clipId})`}>
          {row.connections.map((connection, index) => (
            <path
              key={`${connection.kind}:${String(connection.fromLane)}:${String(connection.toLane)}:${String(index)}`}
              className={connection.collapsed ? 'commit-graph-connection-collapsed' : undefined}
              d={connectionPath(connection)}
              fill="none"
              stroke={color(connection.colorIndex)}
              strokeDasharray={connection.collapsed ? '3 3' : undefined}
              strokeLinecap={connection.collapsed ? 'round' : undefined}
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {!nodeClipped ? (
            <>
              <circle
                className="commit-node-outer"
                cx={nodeX}
                cy={NODE_Y}
                r="4.2"
                fill="var(--vscode-editor-background)"
                stroke={nodeColor}
                strokeWidth="1.7"
              />
              <circle
                className="commit-node-inner"
                cx={nodeX}
                cy={NODE_Y}
                r="1.8"
                fill={nodeColor}
              />
            </>
          ) : null}
        </g>
        {nodeClipped ? (
          <path
            className="commit-node-elision"
            d={`M 150 9 L 156 ${String(NODE_Y)} L 150 19`}
            fill="none"
            stroke={nodeColor}
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
      </svg>
    </span>
  );
}
