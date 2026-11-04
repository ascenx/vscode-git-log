import { useEffect, useMemo, useState } from 'react';
import type {
  BranchStatistics as StatisticsData,
  StatisticsCounts,
  StatisticsPeriod,
} from '../../src/shared/models';
import type { ExtensionToWebviewMessage } from '../../src/protocol/messages';
import { getVsCodeApi } from './vscodeApi';
import { statisticsPeriodBounds } from '../../src/shared/statisticsPeriod';

const periods: Array<{ value: StatisticsPeriod; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: 'Last 7 Days' },
  { value: '30d', label: 'Last 30 Days' },
  { value: 'all', label: 'All' },
];
const number = new Intl.NumberFormat('en-US');
const date = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function Counts({ counts }: { counts: StatisticsCounts }) {
  return (
    <>
      <td>{number.format(counts.commits)}</td>
      <td>{number.format(counts.merges)}</td>
      <td className="statistics-additions">{number.format(counts.additions)}</td>
      <td className="statistics-deletions">{number.format(counts.deletions)}</td>
      <td className={counts.netAdditions >= 0 ? 'statistics-additions' : 'statistics-deletions'}>
        {counts.netAdditions > 0 ? '+' : ''}
        {number.format(counts.netAdditions)}
      </td>
    </>
  );
}

export function BranchStatistics({
  repositoryId,
  branches,
  allBranches,
  scopeLabel,
  revision,
}: {
  repositoryId: string;
  branches: readonly string[];
  allBranches: boolean;
  scopeLabel: string;
  revision: number;
}) {
  const vscode = useMemo(() => getVsCodeApi(), []);
  const [period, setPeriod] = useState<StatisticsPeriod>('7d');
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<{ key: string; data?: StatisticsData; error?: string }>();
  const branchesKey = JSON.stringify(branches);
  const key = JSON.stringify([repositoryId, branchesKey, allBranches, period, revision, refresh]);
  const current = result?.key === key ? result : undefined;

  useEffect(() => {
    const requestId = `statistics-${crypto.randomUUID()}`;
    // Calculate on the user's machine, including when the extension host is remote.
    const bounds = statisticsPeriodBounds(period);
    const listener = (event: MessageEvent<ExtensionToWebviewMessage>) => {
      const message = event.data;
      if (
        !message ||
        message.requestId !== requestId ||
        !('repositoryId' in message) ||
        message.repositoryId !== repositoryId
      )
        return;
      if (message.type === 'branchStatisticsLoaded') setResult({ key, data: message.statistics });
      if (message.type === 'error') setResult({ key, error: message.message });
    };
    window.addEventListener('message', listener);
    vscode.postMessage({
      type: 'requestBranchStatistics',
      requestId,
      repositoryId,
      period,
      ...(bounds.dateFrom !== undefined && bounds.dateTo !== undefined
        ? { dateRange: { dateFrom: bounds.dateFrom, dateTo: bounds.dateTo } } : {}),
      filters: {
        text: '',
        branches: JSON.parse(branchesKey) as string[],
        allBranches,
        authors: [],
        paths: [],
      },
    });
    return () => {
      window.removeEventListener('message', listener);
      vscode.postMessage({ type: 'cancelBranchStatistics', requestId, repositoryId });
    };
  }, [vscode, repositoryId, branchesKey, allBranches, period, key]);

  return (
    <section className="branch-statistics" aria-label="Branch statistics">
      <div className="statistics-toolbar">
        <strong title={scopeLabel}>{scopeLabel}</strong>
        <div role="tablist" aria-label="Statistics period">
          {periods.map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              id={`statistics-tab-${item.value}`}
              aria-selected={period === item.value}
              aria-controls="statistics-results"
              onClick={() => setPeriod(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-label="Refresh statistics"
          title="Refresh statistics"
          onClick={() => setRefresh((value) => value + 1)}
        >
          ↻
        </button>
      </div>
      <div
        id="statistics-results"
        role="tabpanel"
        aria-labelledby={`statistics-tab-${period}`}
        className="statistics-results"
        aria-busy={!current}
      >
        {current?.error ? (
          <div className="statistics-message" role="alert">
            <span>{current.error}</span>
            <button type="button" onClick={() => setRefresh((value) => value + 1)}>
              Retry
            </button>
          </div>
        ) : current?.data ? (
          <>
            <p className="statistics-period">
              {current.data.dateFrom !== undefined && current.data.dateTo !== undefined
                ? `${date.format(current.data.dateFrom * 1000)} to ${date.format(current.data.dateTo * 1000)} (local time)`
                : 'All time'} · Sorted by total commits
            </p>
            <table aria-label="Author commit statistics">
              <thead>
                <tr>
                  <th scope="col">Author</th>
                  <th scope="col">Total Commits</th>
                  <th scope="col">Merges</th>
                  <th scope="col">Lines Added</th>
                  <th scope="col">Lines Deleted</th>
                  <th scope="col">Net Lines</th>
                </tr>
              </thead>
              <tbody>
                {current.data.authors.map((author) => (
                  <tr key={JSON.stringify([author.authorName, author.authorEmail])}>
                    <th scope="row" title={author.authorEmail}>
                      {author.authorName || author.authorEmail}
                    </th>
                    <Counts counts={author} />
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">Total</th>
                  <Counts counts={current.data.totals} />
                </tr>
              </tfoot>
            </table>
            {!current.data.authors.length ? (
              <p className="statistics-message">No commits on this branch in the selected period.</p>
            ) : null}
            <p className="statistics-note">
              Counts commits reachable from the selected branches, deduplicated across branches.
              Merges contribute to commit counts only. Line counts exclude binary files.
              Only the selected branches and period apply.
            </p>
          </>
        ) : (
          <p className="statistics-message" role="status">
            Calculating branch statistics…
          </p>
        )}
      </div>
    </section>
  );
}
