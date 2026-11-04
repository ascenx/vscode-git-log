// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BranchStatistics } from '../../webview/src/BranchStatistics';
import type { WebviewToExtensionMessage } from '../../src/protocol/messages';
import { statisticsPeriodBounds } from '../../src/shared/statisticsPeriod';

const posted: WebviewToExtensionMessage[] = [];
beforeEach(() => {
  posted.length = 0;
  window.acquireVsCodeApi = () => ({
    postMessage(message) {
      posted.push(message);
    },
    getState() {},
    setState() {},
  });
});
afterEach(cleanup);

function deliver(requestId: string, name = 'Alice', allTime = false) {
  act(() =>
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'branchStatisticsLoaded',
          requestId,
          repositoryId: 'repo',
          statistics: {
            ...(allTime ? {} : { dateFrom: 1791216000, dateTo: 1793791140 }),
            authors: [
              {
                authorName: name,
                authorEmail: 'a@test',
                commits: 12,
                merges: 2,
                additions: 1234,
                deletions: 1500,
                netAdditions: -266,
              },
            ],
            totals: {
              commits: 12,
              merges: 2,
              additions: 1234,
              deletions: 1500,
              netAdditions: -266,
            },
          },
        },
      }),
    ),
  );
}

describe('BranchStatistics', () => {
  it('defaults to 7 days, switches tabs, ignores stale results and displays totals', () => {
    render(
      <BranchStatistics
        repositoryId="repo"
        branches={['refs/heads/feature']}
        allBranches={false}
        scopeLabel="feature"
        revision={0}
      />,
    );
    const initial = posted.find((message) => message.type === 'requestBranchStatistics');
    expect(initial).toMatchObject({
      period: '7d',
      dateRange: { dateFrom: statisticsPeriodBounds('7d').dateFrom, dateTo: expect.any(Number) },
      filters: { branches: ['refs/heads/feature'], authors: [], text: '', paths: [] },
    });
    expect(screen.getByRole('tab', { name: 'Last 7 Days' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('tab', { name: 'Today' }));
    const latest = posted.filter((message) => message.type === 'requestBranchStatistics').at(-1)!;
    expect(latest).toMatchObject({ period: 'today' });
    deliver(initial!.requestId, 'Stale');
    expect(screen.queryByText('Stale')).not.toBeInTheDocument();
    deliver(latest.requestId);
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getAllByText('1,234')).toHaveLength(2);
    expect(screen.getByText('Total')).toBeInTheDocument();
    expect(screen.getByText(/\(local time\)/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Last 7 Days' }));
    expect(posted.at(-1)).toMatchObject({ type: 'requestBranchStatistics', period: '7d' });
    expect(screen.queryByText('Alice')).not.toBeInTheDocument();
  });

  it('requests all history and displays an unbounded period for All', () => {
    render(<BranchStatistics repositoryId="repo" branches={['refs/heads/feature']}
      allBranches={false} scopeLabel="feature" revision={0} />);
    fireEvent.click(screen.getByRole('tab', { name: 'All' }));
    const request = posted.filter((message) => message.type === 'requestBranchStatistics').at(-1)!;
    expect(request).toMatchObject({ period: 'all', filters: { branches: ['refs/heads/feature'], allBranches: false } });
    expect(request).not.toHaveProperty('dateRange');
    deliver(request.requestId, 'Alice', true);
    expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText(/All time · Sorted by total commits/u)).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Last 30 Days' }));
    expect(posted.at(-1)).toMatchObject({ type: 'requestBranchStatistics', period: '30d' });
  });

  it('shows query errors and supports retry, cancelling requests when unmounted', () => {
    const { unmount } = render(
      <BranchStatistics
        repositoryId="repo"
        branches={[]}
        allBranches={false}
        scopeLabel="HEAD"
        revision={0}
      />,
    );
    const first = posted.at(-1)!;
    act(() =>
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'error',
            requestId: first.requestId,
            repositoryId: 'repo',
            message: 'Unable to read history',
          },
        }),
      ),
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Unable to read history');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    const latest = posted.at(-1)!;
    expect(latest.requestId).not.toBe(first.requestId);
    unmount();
    expect(posted.at(-1)).toMatchObject({
      type: 'cancelBranchStatistics',
      requestId: latest.requestId,
    });
  });
});
