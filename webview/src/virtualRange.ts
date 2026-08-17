export interface VirtualRangeOptions {
  itemCount: number;
  rowHeight: number;
  scrollTop: number;
  viewportHeight: number;
  overscan: number;
}

export interface VirtualRange {
  start: number;
  end: number;
}

export function getVirtualRange(options: VirtualRangeOptions): VirtualRange {
  if (options.itemCount <= 0 || options.rowHeight <= 0) return { start: 0, end: 0 };

  const visibleCount = Math.max(1, Math.ceil(options.viewportHeight / options.rowHeight));
  if (options.itemCount <= visibleCount + options.overscan * 2) {
    return { start: 0, end: options.itemCount };
  }

  const firstVisible = Math.min(
    options.itemCount - 1,
    Math.max(0, Math.floor(options.scrollTop / options.rowHeight)),
  );
  const start = Math.max(0, firstVisible - options.overscan);
  const end = Math.min(options.itemCount, firstVisible + visibleCount + options.overscan);
  return { start, end };
}
