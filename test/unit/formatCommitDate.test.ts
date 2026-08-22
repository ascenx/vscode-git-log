import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('formatCommitDate', () => {
  it('reuses one Intl formatter across repeated commit dates', async () => {
    const createNativeFormatter = Intl.DateTimeFormat.bind(Intl);
    const formatter = vi
      .spyOn(Intl, 'DateTimeFormat')
      .mockImplementation(function DateTimeFormat(locales, options) {
        return createNativeFormatter(locales, options);
      });
    const { formatCommitDate } = await import('../../webview/src/formatCommitDate');

    expect(formatCommitDate(1)).not.toBe('');
    expect(formatCommitDate(2)).not.toBe('');
    expect(formatter).toHaveBeenCalledTimes(1);
  });

  it('does not create a formatter for an empty timestamp', async () => {
    const formatter = vi.spyOn(Intl, 'DateTimeFormat');
    const { formatCommitDate } = await import('../../webview/src/formatCommitDate');

    expect(formatCommitDate(0)).toBe('');
    expect(formatter).not.toHaveBeenCalled();
  });
});
