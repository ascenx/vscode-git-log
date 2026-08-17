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
});
