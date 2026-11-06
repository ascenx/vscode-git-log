import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { GitRunner } from '../../src/git/GitRunner';
import { BranchStatisticsService } from '../../src/git/BranchStatisticsService';
import { statisticsPeriodBounds } from '../../src/shared/statisticsPeriod';

const exec = promisify(execFile);
const directories: string[] = [];
const now = Date.parse('2026-11-04T11:19:00Z');

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'git-log-statistics-'));
  directories.push(cwd);
  const git = async (args: string[], name = 'Alice', date = '2026-11-04T10:00:00Z') =>
    (
      await exec('git', args, {
        cwd,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: name,
          GIT_AUTHOR_EMAIL: `${name.toLowerCase()}@test`,
          GIT_COMMITTER_NAME: name,
          GIT_COMMITTER_EMAIL: `${name.toLowerCase()}@test`,
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_DATE: date,
        },
      })
    ).stdout.trim();
  await git(['init', '-b', 'main']);
  return { cwd, git, service: new BranchStatisticsService(new GitRunner()) };
}

describe('branch statistics', () => {
  it('has no date bounds for All', () => {
    expect(statisticsPeriodBounds('all', now)).toEqual({});
  });

  it('uses local calendar days including today', () => {
    for (const [period, days] of [['today', 1], ['7d', 7], ['30d', 30]] as const) {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - days + 1);
      expect(statisticsPeriodBounds(period, now)).toEqual({
        dateFrom: start.getTime() / 1000,
        dateTo: now / 1000,
      });
    }
  });

  it('aggregates reachable commits once, counts merges without duplicate line changes and includes root', async () => {
    const { cwd, git, service } = await fixture();
    await writeFile(join(cwd, 'app.txt'), 'one\ntwo\n');
    await git(['add', '.']);
    await git(['commit', '-m', 'root']);
    await git(['switch', '-c', 'feature']);
    await writeFile(join(cwd, 'feature.txt'), 'feature\n');
    await git(['add', '.']);
    await git(['commit', '-m', 'feature'], 'Bob');
    const feature = await git(['rev-parse', 'HEAD']);
    await git(['switch', 'main']);
    await writeFile(join(cwd, 'app.txt'), 'one\nthree\nfour\n');
    await git(['add', '.']);
    await git(['commit', '-m', 'main']);
    await git(['merge', '--no-ff', 'feature', '-m', 'merge']);
    const main = await git(['rev-parse', 'HEAD']);
    const result = await service.getStatistics(cwd, {
      revisions: [main, feature],
      period: '30d',
      now,
    });
    expect(result.totals).toEqual({
      commits: 4,
      merges: 1,
      additions: 5,
      deletions: 1,
      netAdditions: 4,
    });
    expect(result.authors).toEqual([
      {
        authorName: 'Alice',
        authorEmail: 'alice@test',
        commits: 3,
        merges: 1,
        additions: 4,
        deletions: 1,
        netAdditions: 3,
      },
      {
        authorName: 'Bob',
        authorEmail: 'bob@test',
        commits: 1,
        merges: 0,
        additions: 1,
        deletions: 0,
        netAdditions: 1,
      },
    ]);
    expect(
      (await service.getStatistics(cwd, { revisions: [feature], period: 'all', now })).totals
        .commits,
    ).toBe(2);
  });

  it('handles rename paths with tabs/newlines and binary files without inflating line totals', async () => {
    const { cwd, git, service } = await fixture();
    await writeFile(join(cwd, 'old.txt'), 'one\ntwo\n');
    await git(['add', '.']);
    await git(['commit', '-m', 'root']);
    await git(['mv', 'old.txt', 'new\n\tname.txt']);
    await writeFile(join(cwd, 'binary'), Buffer.from([0, 1, 2]));
    await git(['add', '.']);
    await git(['commit', '-m', 'rename and binary']);
    const head = await git(['rev-parse', 'HEAD']);
    expect(
      (await service.getStatistics(cwd, { revisions: [head], period: 'all', now })).totals,
    ).toEqual({ commits: 2, merges: 0, additions: 2, deletions: 0, netAdditions: 2 });
  });

  it('honors client-local date bounds by committer time, including midnight and excluding future commits', async () => {
    const { git, service, cwd } = await fixture();
    for (const date of [
      '2026-10-01T00:00:00Z',
      '2026-11-03T15:59:59Z',
      '2026-11-03T16:00:00Z',
      '2026-11-05T00:00:00Z',
    ]) {
      await git(['commit', '--allow-empty', '-m', date], 'Alice', date);
    }
    const revisions = [await git(['rev-parse', 'HEAD'])];
    const dateRange = { dateFrom: Date.parse('2026-11-03T16:00:00Z') / 1000, dateTo: now / 1000 };
    expect(
      (await service.getStatistics(cwd, { revisions, period: 'today', now, dateRange })).totals.commits,
    ).toBe(1);
    expect(
      (await service.getStatistics(cwd, { revisions, period: '7d', now })).totals.commits,
    ).toBe(2);
    expect(
      (await service.getStatistics(cwd, { revisions, period: '30d', now })).totals.commits,
    ).toBe(2);
    const all = await service.getStatistics(cwd, { revisions, period: 'all', now });
    expect(all.totals.commits).toBe(4);
    expect(all).not.toHaveProperty('dateFrom');
    expect(all).not.toHaveProperty('dateTo');
    const localRange = { dateFrom: Date.parse('2026-11-04T00:00:00Z') / 1000, dateTo: now / 1000 };
    const local = await service.getStatistics(cwd, { revisions, period: 'today', now, dateRange: localRange });
    expect(local.totals.commits).toBe(0);
    expect(local).toMatchObject(localRange);
  });

  it('counts in-range ancestors beyond a commit with an earlier committer date', async () => {
    const { cwd, git, service } = await fixture();
    for (const [file, content, author, date] of [
      ['root.txt', 'first\nsecond\n', 'Alice', '2026-11-03T10:00:00Z'],
      ['excluded.txt', 'ignored\n', 'Bob', '2026-10-01T10:00:00Z'],
      ['tip.txt', 'third\n', 'Alice', '2026-11-04T10:00:00Z'],
    ] as const) {
      await writeFile(join(cwd, file), content);
      await git(['add', '.']);
      await git(['commit', '-m', file], author, date);
    }
    const result = await service.getStatistics(cwd, {
      revisions: [await git(['rev-parse', 'HEAD'])], period: '7d', now,
    });
    expect(result.totals).toEqual({ commits: 2, merges: 0, additions: 3, deletions: 0, netAdditions: 3 });
    expect(result.authors).toEqual([
      { authorName: 'Alice', authorEmail: 'alice@test', ...result.totals },
    ]);
  });

  it('keeps scanning past a page with no commits in the date range', async () => {
    const { git, service, cwd } = await fixture();
    await git(['commit', '--allow-empty', '-m', 'in-range ancestor']);
    for (let index = 0; index < 200; index++) {
      await git(['commit', '--allow-empty', '-m', `excluded ${String(index)}`], 'Bob', '2026-10-01T00:00:00Z');
    }
    const result = await service.getStatistics(cwd, {
      revisions: [await git(['rev-parse', 'HEAD'])], period: '7d', now,
    });
    expect(result.totals.commits).toBe(1);
    expect(result.authors).toEqual([
      { authorName: 'Alice', authorEmail: 'alice@test', ...result.totals },
    ]);
  });

  it('returns empty totals for no selected revisions and rejects invalid object IDs', async () => {
    const { service, cwd } = await fixture();
    expect(
      (await service.getStatistics(cwd, { revisions: [], period: 'today', now })).totals.commits,
    ).toBe(0);
    await expect(
      service.getStatistics(cwd, { revisions: ['--all'], period: 'today', now }),
    ).rejects.toThrow();
  });

  it('aggregates all history beyond a page and applies mailmap identities', async () => {
    const { service, cwd, git } = await fixture();
    await writeFile(join(cwd, '.mailmap'), 'Canonical <canonical@test> Alice <alice@test>\n');
    for (let index = 0; index < 201; index++) {
      await git(['commit', '--allow-empty', '-m', String(index)]);
    }
    const result = await service.getStatistics(cwd, {
      revisions: [await git(['rev-parse', 'HEAD'])],
      period: 'all',
      now,
    });
    expect(result.totals.commits).toBe(201);
    expect(result.authors).toEqual([
      expect.objectContaining({
        authorName: 'Canonical',
        authorEmail: 'canonical@test',
        commits: 201,
      }),
    ]);
  });

  it('cancels without returning partial totals', async () => {
    const { service, cwd, git } = await fixture();
    await git(['commit', '--allow-empty', '-m', 'root']);
    const abort = new AbortController();
    abort.abort();
    await expect(
      service.getStatistics(cwd, {
        revisions: [await git(['rev-parse', 'HEAD'])],
        period: 'today',
        now,
        signal: abort.signal,
      }),
    ).rejects.toMatchObject({ cancelled: true });
  });
});
