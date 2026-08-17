import { describe, expect, it } from 'vitest';

describe('getVirtualRange', () => {
  it('returns an overscanned fixed-row window and clamps boundaries', async () => {
    const modulePath = '../../webview/src/virtualRange';
    const rangeModule = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(rangeModule, 'the virtual range helper must exist').toBeDefined();
    if (!rangeModule) return;

    expect(
      rangeModule.getVirtualRange({
        itemCount: 1000,
        rowHeight: 28,
        scrollTop: 280,
        viewportHeight: 280,
        overscan: 5,
      }),
    ).toEqual({ start: 5, end: 25 });

    expect(
      rangeModule.getVirtualRange({
        itemCount: 3,
        rowHeight: 28,
        scrollTop: 999,
        viewportHeight: 280,
        overscan: 5,
      }),
    ).toEqual({ start: 0, end: 3 });
  });
});
