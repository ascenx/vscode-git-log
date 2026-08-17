import { describe, expect, it } from 'vitest';

describe('buildLogArguments', () => {
  it('serializes branch, author, date, pagination, and path filters as argument-array entries', async () => {
    const modulePath = '../../src/git/logQuery';
    const queryModule = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(queryModule, 'the log query builder must exist').toBeDefined();
    if (!queryModule) return;

    expect(
      queryModule.buildLogArguments({
        limit: 50,
        skip: 100,
        format: 'FORMAT',
        filters: {
          text: '',
          branches: ['refs/heads/main', 'refs/remotes/origin/release'],
          authors: ['Alice <alice@example.com>', '张三'],
          dateFrom: 1_700_000_000,
          dateTo: 1_700_100_000,
          paths: ['src/app.ts', 'docs'],
        },
      }),
    ).toEqual([
      'log',
      '--date-order',
      '--no-color',
      '--format=FORMAT',
      '--max-count=50',
      '--skip=100',
      '--regexp-ignore-case',
      '--extended-regexp',
      '--author=Alice <alice@example\\.com>',
      '--author=张三',
      '--since=@1700000000',
      '--until=@1700100000',
      '--end-of-options',
      'refs/heads/main',
      'refs/remotes/origin/release',
      '--',
      'src/app.ts',
      'docs',
    ]);

    const currentBranchArgs = queryModule.buildLogArguments({
      limit: 200,
      skip: 0,
      format: 'FORMAT',
      filters: queryModule.EMPTY_LOG_FILTERS,
    });
    expect(currentBranchArgs).toContain('HEAD');
    expect(currentBranchArgs).not.toContain('--all');
  });

  it('treats selected author names as literal text instead of Git regular expressions', async () => {
    const { buildLogArguments, EMPTY_LOG_FILTERS } = await import('../../src/git/logQuery');

    const args = buildLogArguments({
      limit: 20,
      skip: 0,
      format: 'FORMAT',
      filters: { ...EMPTY_LOG_FILTERS, authors: ['A+B [bot] (release)'] },
    });

    expect(args).toContain('--regexp-ignore-case');
    expect(args).toContain('--extended-regexp');
    expect(args).toContain('--author=A\\+B \\[bot\\] \\(release\\)');
  });
});
