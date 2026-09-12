// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { GraphRow } from '../../src/graph/layoutCommitGraph';

afterEach(cleanup);

describe('CommitGraphCell', () => {
  it('renders graph connections and the commit node as SVG geometry', async () => {
    const modulePath = '../../webview/src/CommitGraphCell';
    const graphCellModule = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(graphCellModule, 'the graph cell component must exist').toBeDefined();
    if (!graphCellModule) return;

    const row: GraphRow = {
      hash: 'merge',
      nodeLane: 0,
      nodeColor: 0,
      lanesBefore: [],
      lanesAfter: [
        { id: 0, target: 'main', colorIndex: 0 },
        { id: 1, target: 'feature', colorIndex: 1 },
      ],
      connections: [
        { fromLane: 0, toLane: 0, colorIndex: 0, kind: 'parent' },
        { fromLane: 0, toLane: 1, colorIndex: 1, kind: 'parent' },
      ],
    };

    const { container } = render(<graphCellModule.CommitGraphCell row={row} maxLaneCount={2} />);

    expect(screen.getByTestId('commit-graph-merge')).toBeInTheDocument();
    expect(container.querySelectorAll('path')).toHaveLength(2);
    expect(container.querySelectorAll('circle')).toHaveLength(2);
  });

  it('clips an exceptionally wide graph without scaling its lane geometry', async () => {
    const modulePath = '../../webview/src/CommitGraphCell';
    const graphCellModule = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(graphCellModule, 'the graph cell component must exist').toBeDefined();
    if (!graphCellModule) return;

    const row: GraphRow = {
      hash: 'wide',
      nodeLane: 79,
      nodeColor: 0,
      lanesBefore: [],
      lanesAfter: [],
      connections: [{ fromLane: 12, toLane: 12, colorIndex: 1, kind: 'through' }],
    };

    render(<graphCellModule.CommitGraphCell row={row} maxLaneCount={80} />);

    const graph = screen.getByTestId('commit-graph-wide');
    expect(graph).toHaveAttribute('width', '160');
    expect(graph).toHaveAttribute('viewBox', '0 0 160 28');
    expect(graph).toHaveAttribute('data-node-clipped', 'true');
    expect(graph.querySelector('clipPath rect')).toHaveAttribute('width', '145');
    expect(graph.querySelector('.commit-node-outer')).not.toBeInTheDocument();
    expect(graph.querySelector('.commit-node-elision')).toBeInTheDocument();
    expect(graph.parentElement).toHaveClass('commit-graph-viewport');
    expect(graph.parentElement).toHaveStyle({ width: '160px' });
  });

  it('renders ancestry crossing hidden commits as a dashed collapsed route', async () => {
    const modulePath = '../../webview/src/CommitGraphCell';
    const graphCellModule = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(graphCellModule, 'the graph cell component must exist').toBeDefined();
    if (!graphCellModule) return;

    const row: GraphRow = {
      hash: 'filtered',
      nodeLane: 0,
      nodeColor: 0,
      lanesBefore: [],
      lanesAfter: [{ id: 0, target: 'visible-parent', colorIndex: 0, collapsed: true }],
      connections: [
        { fromLane: 0, toLane: 0, colorIndex: 0, kind: 'parent', collapsed: true },
        { fromLane: 0, toLane: 1, colorIndex: 1, kind: 'parent' },
      ],
    };

    render(<graphCellModule.CommitGraphCell row={row} maxLaneCount={2} />);

    const paths = screen.getByTestId('commit-graph-filtered').querySelectorAll('path');
    expect(paths[0]).toHaveClass('commit-graph-connection-collapsed');
    expect(paths[0]).toHaveAttribute('stroke-dasharray', '3 3');
    expect(paths[1]).not.toHaveClass('commit-graph-connection-collapsed');
    expect(paths[1]).not.toHaveAttribute('stroke-dasharray');
  });
});
