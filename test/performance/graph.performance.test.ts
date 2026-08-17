import { describe, expect, it } from 'vitest';
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
});
