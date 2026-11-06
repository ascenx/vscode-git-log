import { GitCommandError, type GitRunner } from './GitRunner';
import type {
  AuthorStatistics,
  BranchStatistics,
  StatisticsCounts,
  StatisticsPeriod,
  StatisticsDateRange,
} from '../shared/models';
import { statisticsPeriodBounds } from '../shared/statisticsPeriod';

const PAGE_SIZE = 200;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

function emptyCounts(): StatisticsCounts {
  return { commits: 0, merges: 0, additions: 0, deletions: 0, netAdditions: 0 };
}

export class BranchStatisticsService {
  constructor(private readonly runner: GitRunner) {}

  async getStatistics(
    cwd: string,
    query: {
      revisions: readonly string[];
      period: StatisticsPeriod;
      dateRange?: StatisticsDateRange;
      now?: number;
      signal?: AbortSignal;
    },
  ): Promise<BranchStatistics> {
    if (query.revisions.some((revision) => !OBJECT_ID.test(revision))) {
      throw new Error('Invalid statistics revision.');
    }
    const bounds = query.period === 'all'
      ? statisticsPeriodBounds('all')
      : query.dateRange ?? statisticsPeriodBounds(query.period, query.now);
    const authors = new Map<string, AuthorStatistics>();
    const totals = emptyCounts();
    for (let skip = 0; query.revisions.length; skip += PAGE_SIZE) {
      if (query.signal?.aborted) {
        throw new GitCommandError(
          'Git command was cancelled.',
          [],
          cwd,
          null,
          Buffer.alloc(0),
          Buffer.alloc(0),
          true,
          false,
        );
      }
      const result = await this.runner.run(
        [
          '-c',
          'log.diffMerges=off',
          'log',
          '--no-color',
          '--no-ext-diff',
          '--no-textconv',
          '--numstat',
          '-z',
          '-M',
          // Filter dates after traversal: --since can prune in-range ancestors with newer dates.
          // --since-as-filter is unavailable in the minimum supported Git version (2.27).
          '--format=%x00%H%x00%P%x00%aN%x00%aE%x00%ct%x00',
          `--max-count=${String(PAGE_SIZE)}`,
          `--skip=${String(skip)}`,
          '--end-of-options',
          ...new Set(query.revisions),
          '--',
        ],
        {
          cwd,
          ...(query.signal ? { signal: query.signal } : {}),
          timeoutMs: 60_000,
          maxStdoutBytes: 16 * 1024 * 1024,
        },
      );
      const fields = result.stdout.toString('utf8').split('\0');
      let author: AuthorStatistics | undefined;
      let merge = false;
      let commits = 0;
      for (let index = 0; index < fields.length; index++) {
        const field = fields[index]!;
        if (field === '' && OBJECT_ID.test(fields[index + 1] ?? '')) {
          const parents = fields[index + 2]!;
          const authorName = fields[index + 3]!;
          const authorEmail = fields[index + 4]!;
          const committedAt = Number(fields[index + 5]);
          // Pagination counts all visited commits, including those outside the date range.
          commits++;
          index += 5;
          author = undefined;
          if (
            (bounds.dateFrom !== undefined && committedAt < bounds.dateFrom) ||
            (bounds.dateTo !== undefined && committedAt > bounds.dateTo)
          ) continue;
          const key = JSON.stringify([authorName, authorEmail]);
          author = authors.get(key) ?? { authorName, authorEmail, ...emptyCounts() };
          authors.set(key, author);
          merge = parents.includes(' ');
          author.commits++;
          if (merge) author.merges++;
          continue;
        }
        const stat = /^\n?(\d+|-)\t(\d+|-)\t([\s\S]*)$/u.exec(field);
        if (!stat) continue;
        // A rename has two following NUL-delimited paths, which may contain tabs/newlines.
        if (stat[3] === '') index += 2;
        if (!author || merge || stat[1] === '-' || stat[2] === '-') continue;
        author.additions += Number(stat[1]);
        author.deletions += Number(stat[2]);
      }
      if (commits < PAGE_SIZE) break;
    }
    const rows = [...authors.values()].sort(
      (left, right) =>
        right.commits - left.commits ||
        left.authorName.localeCompare(right.authorName) ||
        left.authorEmail.localeCompare(right.authorEmail),
    );
    for (const row of rows) {
      row.netAdditions = row.additions - row.deletions;
      for (const key of Object.keys(totals) as Array<keyof StatisticsCounts>)
        totals[key] += row[key];
    }
    return { ...bounds, authors: rows, totals };
  }
}
