import { describe, expect, it } from 'vitest';
import { GitService } from '../../src/git/GitService';
import { EMPTY_LOG_FILTERS } from '../../src/git/logQuery';
import { layoutCommitGraph } from '../../src/graph/layoutCommitGraph';
import { getVirtualRange } from '../../webview/src/virtualRange';

describe('commit graph performance', () => {
  it.each([
    [1_000, 250],
    [10_000, 1_000],
    [100_000, 5_000],
  ] as const)('lays out %i linear commits within %ims', (count, budgetMs) => {
    const commits = Array.from({ length: count }, (_, index) => ({
      hash: `commit-${String(count - index)}`,
      parents: index === count - 1 ? [] : [`commit-${String(count - index - 1)}`],
    }));

    const startedAt = performance.now();
    const result = layoutCommitGraph(commits);
    const duration = performance.now() - startedAt;

    expect(result.rows).toHaveLength(count);
    expect(result.maxLaneCount).toBe(1);
    expect(duration).toBeLessThan(budgetMs);
  });

  it('lays out a dense merge history without unbounded lane growth', () => {
    const count = 5_000;
    const commits = Array.from({ length: count }, (_, index) => {
      const firstParent = index + 1 < count ? `dense-${String(index + 1)}` : undefined;
      const mergeParent = index % 5 === 0 && index + 3 < count ? `dense-${String(index + 3)}` : undefined;
      return {
        hash: `dense-${String(index)}`,
        parents: [firstParent, mergeParent].filter((parent): parent is string => Boolean(parent)),
      };
    });

    const startedAt = performance.now();
    const result = layoutCommitGraph(commits);
    const duration = performance.now() - startedAt;

    expect(result.rows).toHaveLength(count);
    expect(result.maxLaneCount).toBeLessThan(20);
    expect(duration).toBeLessThan(2_000);
  });

  it('keeps a 100,000-row viewport bounded to a small render window', () => {
    const range = getVirtualRange({
      itemCount: 100_000,
      rowHeight: 28,
      scrollTop: 1_400_000,
      viewportHeight: 840,
      overscan: 8,
    });

    expect(range.end - range.start).toBeLessThanOrEqual(46);
  });

  it('projects thousands of hidden split-and-rejoin paths without quadratic comparisons', async () => {
    const diamondCount = 3_000;
    const hash = (index: number): string => index.toString(16).padStart(40, '0');
    const top = hash(1);
    const base = hash(2);
    const diamonds = Array.from({ length: diamondCount }, (_, index) => ({
      split: hash(index * 4 + 10),
      left: hash(index * 4 + 11),
      right: hash(index * 4 + 12),
      join: hash(index * 4 + 13),
    }));
    const record = (commitHash: string, parents: string[], subject: string): string =>
      `\x1e${commitHash}\x00${parents.join(' ')}\x00Author\x00author@example.com\x001\x001\x00${subject}\x00${subject}\x00`;
    const records = [record(top, [diamonds[0]?.split ?? base], 'needle top')];
    for (const [index, diamond] of diamonds.entries()) {
      const next = diamonds[index + 1]?.split ?? base;
      records.push(
        record(diamond.split, [diamond.left, diamond.right], `hidden split ${String(index)}`),
        record(diamond.left, [diamond.join], `hidden left ${String(index)}`),
        record(diamond.right, [diamond.join], `hidden right ${String(index)}`),
        record(diamond.join, [next], `hidden join ${String(index)}`),
      );
    }
    records.push(record(base, [], 'needle base'));
    const runner = {
      run: async (args: readonly string[]) => {
        const skipArgument = args.find((argument) => argument.startsWith('--skip='));
        const skip = Number(skipArgument?.slice('--skip='.length) ?? '0');
        return {
          stdout: Buffer.from(records.slice(skip, skip + 5_000).join('')),
          stderr: Buffer.alloc(0),
          exitCode: 0,
          durationMs: 1,
        };
      },
    };

    const startedAt = performance.now();
    const commits = await new GitService(runner as never).getLog('/repository', {
      limit: 2,
      skip: 0,
      refs: [],
      filters: { ...EMPTY_LOG_FILTERS, text: 'needle' },
    });
    const duration = performance.now() - startedAt;

    expect(commits.map((commit) => commit.hash)).toEqual([top, base]);
    expect(commits[0]?.graphParents).toEqual([base]);
    expect(duration).toBeLessThan(1_000);
  });
});
