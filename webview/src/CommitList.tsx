import { useEffect, useRef, useState } from 'react';
import type { GraphLayoutResult } from '../../src/graph/layoutCommitGraph';
import type { CommitSummary, HistoryEntry } from '../../src/shared/models';
import { CommitGraphCell } from './CommitGraphCell';
import { formatCommitDate } from './formatCommitDate';
import { getVirtualRange } from './virtualRange';

interface CommitListProps {
  commits: CommitSummary[];
  graphLayout: GraphLayoutResult;
  selectedHashes: ReadonlySet<string>;
  headHash: string | undefined;
  hasMore: boolean;
  loading: boolean;
  initialScrollTop: number;
  scrollAnchorKey: string;
  horizontalScrollResetKey: string;
  revealTarget?: {
    hash: string;
    requestId: number;
    listRevision: number;
    minimumListRevision: number;
  };
  onScrollTopChange(scrollTop: number): void;
  onHorizontalScroll(scrollLeft: number): void;
  onSelect(commit: CommitSummary, extend: boolean, toggle?: boolean): void;
  onContextMenu(commit: CommitSummary, x: number, y: number): void;
  onLoadMore(): void;
}

export function CommitList({
  commits,
  graphLayout,
  selectedHashes,
  headHash,
  hasMore,
  loading,
  initialScrollTop,
  scrollAnchorKey,
  horizontalScrollResetKey,
  revealTarget,
  onScrollTopChange,
  onHorizontalScroll,
  onSelect,
  onContextMenu,
  onLoadMore,
}: CommitListProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const scrollFrame = useRef<number | undefined>(undefined);
  const pendingScrollTop = useRef<number | undefined>(undefined);
  const lastRevealRequest = useRef<number | undefined>(undefined);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(560);
  const rowHeight = 28;
  const revealHash = revealTarget?.hash;
  const revealRequestId = revealTarget?.requestId;
  const revealListRevision = revealTarget?.listRevision;
  const minimumRevealListRevision = revealTarget?.minimumListRevision;
  const trailingRevealSpace = Math.max(0, viewportHeight - rowHeight);
  const range = getVirtualRange({
    itemCount: commits.length,
    rowHeight,
    scrollTop,
    viewportHeight,
    overscan: 8,
  });

  const focusCommit = (index: number): void => {
    const viewport = viewportRef.current;
    const target = commits[index];
    if (!viewport || !target) return;
    const top = index * rowHeight;
    if (top < viewport.scrollTop || top + rowHeight > viewport.scrollTop + viewportHeight) {
      viewport.scrollTop = Math.max(0, top - Math.floor(viewportHeight / 2));
      setScrollTop(viewport.scrollTop);
    }
    const focus = (): void => {
      viewport.querySelector<HTMLElement>(`[data-commit-hash="${target.hash}"]`)?.focus();
    };
    focus();
    window.requestAnimationFrame(focus);
  };

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const updateHeight = (): void => setViewportHeight(viewport.clientHeight || 560);
    updateHeight();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateHeight);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollTop = initialScrollTop;
    setScrollTop(initialScrollTop);
  }, [initialScrollTop, scrollAnchorKey]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (
      !viewport ||
      !revealHash ||
      revealRequestId === undefined ||
      revealListRevision === undefined ||
      minimumRevealListRevision === undefined ||
      revealListRevision < minimumRevealListRevision
    ) {
      return;
    }
    if (lastRevealRequest.current === revealRequestId) return;
    const index = commits.findIndex((commit) => commit.hash === revealHash);
    if (index < 0) return;
    lastRevealRequest.current = revealRequestId;
    if (scrollFrame.current !== undefined) {
      window.cancelAnimationFrame(scrollFrame.current);
      scrollFrame.current = undefined;
    }
    const top = index * rowHeight;
    pendingScrollTop.current = top;
    viewport.scrollTop = top;
    scrollFrame.current = window.requestAnimationFrame(() => {
      scrollFrame.current = undefined;
      const pending = pendingScrollTop.current;
      pendingScrollTop.current = undefined;
      if (pending !== undefined) setScrollTop(pending);
    });
  }, [
    commits,
    minimumRevealListRevision,
    revealHash,
    revealListRevision,
    revealRequestId,
  ]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollLeft = 0;
    onHorizontalScroll(0);
    return () => onHorizontalScroll(0);
  }, [horizontalScrollResetKey, onHorizontalScroll]);

  useEffect(
    () => () => {
      if (scrollFrame.current !== undefined) {
        window.cancelAnimationFrame(scrollFrame.current);
      }
    },
    [],
  );

  return (
    <div
      className="commit-viewport"
      ref={viewportRef}
      onScroll={(event) => {
        const viewport = event.currentTarget;
        pendingScrollTop.current = viewport.scrollTop;
        onScrollTopChange(viewport.scrollTop);
        onHorizontalScroll(viewport.scrollLeft);
        if (scrollFrame.current === undefined) {
          scrollFrame.current = window.requestAnimationFrame(() => {
            scrollFrame.current = undefined;
            const pending = pendingScrollTop.current;
            pendingScrollTop.current = undefined;
            if (pending !== undefined) setScrollTop(pending);
          });
        }
        if (
          hasMore &&
          !loading &&
          viewport.scrollTop + viewport.clientHeight >=
            viewport.scrollHeight - trailingRevealSpace - rowHeight * 5
        ) {
          onLoadMore();
        }
      }}
    >
      <div
        className="commit-list"
        role="rowgroup"
        style={{
          height:
            commits.length * rowHeight +
            trailingRevealSpace +
            (hasMore ? 32 : 0),
        }}
      >
        {commits.slice(range.start, range.end).map((commit, visibleIndex) => {
          const index = range.start + visibleIndex;
          const graphRow = graphLayout.rows[index];
          return (
            <div
              className={`commit-row${selectedHashes.has(commit.hash) ? ' selected' : ''}${
                headHash === commit.hash ? ' head-row' : ''
              }`}
              style={{ top: index * rowHeight }}
              role="row"
              aria-rowindex={index + 2}
              aria-selected={selectedHashes.has(commit.hash)}
              data-commit-hash={commit.hash}
              tabIndex={0}
              key={commit.hash}
              onClick={(event) =>
                onSelect(commit, event.shiftKey, event.ctrlKey || event.metaKey)
              }
              onContextMenu={(event) => {
                event.preventDefault();
                onContextMenu(commit, event.clientX, event.clientY);
              }}
              onKeyDown={(event) => {
                let targetIndex: number | undefined;
                if (event.key === 'ArrowUp') targetIndex = Math.max(0, index - 1);
                if (event.key === 'ArrowDown') {
                  targetIndex = Math.min(commits.length - 1, index + 1);
                }
                if (event.key === 'PageUp') {
                  targetIndex = Math.max(
                    0,
                    index - Math.max(1, Math.floor(viewportHeight / rowHeight)),
                  );
                }
                if (event.key === 'PageDown') {
                  targetIndex = Math.min(
                    commits.length - 1,
                    index + Math.max(1, Math.floor(viewportHeight / rowHeight)),
                  );
                }
                if (event.key === 'Home') targetIndex = 0;
                if (event.key === 'End') {
                  targetIndex = commits.length - 1;
                  if (hasMore) onLoadMore();
                }
                if (targetIndex !== undefined) {
                  event.preventDefault();
                  const target = commits[targetIndex];
                  if (target) {
                    onSelect(target, event.shiftKey);
                    focusCommit(targetIndex);
                  }
                } else if (event.key === 'Enter' || event.key === ' ') {
                  onSelect(commit, event.shiftKey);
                }
              }}
            >
              <span className="commit-subject-cell" role="gridcell">
                {graphRow ? (
                  <CommitGraphCell row={graphRow} maxLaneCount={graphLayout.maxLaneCount} />
                ) : null}
                <span className="commit-subject">{commit.subject}</span>
                {'oldPath' in commit &&
                (commit as HistoryEntry).oldPath &&
                (commit as HistoryEntry).oldPath !== (commit as HistoryEntry).path ? (
                  <span
                    className="history-rename"
                    title={`${(commit as HistoryEntry).oldPath ?? ''} → ${(commit as HistoryEntry).path}`}
                  >
                    {(commit as HistoryEntry).oldPath} → {(commit as HistoryEntry).path}
                  </span>
                ) : null}
                {'binary' in commit ? (
                  <span className="history-stats">
                    {(commit as HistoryEntry).binary ? (
                      <span className="history-stat-binary">Binary</span>
                    ) : (
                      <>
                        {(commit as HistoryEntry).additions !== undefined ? (
                          <span className="file-stat-additions">
                            +{String((commit as HistoryEntry).additions)}
                          </span>
                        ) : null}
                        {(commit as HistoryEntry).deletions !== undefined ? (
                          <span className="file-stat-deletions">
                            −{String((commit as HistoryEntry).deletions)}
                          </span>
                        ) : null}
                      </>
                    )}
                  </span>
                ) : null}
              </span>
              <span className="commit-author" role="gridcell" title={commit.authorEmail}>
                {commit.authorName}
              </span>
              <span className="commit-date" role="gridcell">
                {formatCommitDate(commit.commitTime)}
              </span>
              <span className="commit-refs" role="gridcell">
                {commit.refs.map((ref) => (
                  <span className={`ref-label ${ref.kind}`} key={ref.fullName}>
                    {ref.shortName}
                  </span>
                ))}
              </span>
            </div>
          );
        })}
        {hasMore ? (
          <button
            type="button"
            className="load-more"
            style={{ top: commits.length * rowHeight }}
            onClick={onLoadMore}
          >
            {loading ? 'Loading…' : 'Load more commits'}
          </button>
        ) : null}
      </div>
    </div>
  );
}
