import { describe, expect, it } from 'vitest';
import type { HistorySyntaxToken } from '../../src/editor/HistoryDiffSupport';

describe('HistorySyntaxWorkerProtocol', () => {
  it('rejects an excessive token object count before crossing the worker boundary', async () => {
    const modulePath = '../../src/editor/HistorySyntaxWorkerProtocol';
    const module = await import(/* @vite-ignore */ modulePath);
    const token: HistorySyntaxToken = {
      content: 'x',
      light: '#111111',
      dark: '#eeeeee',
    };
    const lines = [Array.from({ length: 25_001 }, () => token)];

    expect(() => module.enforceHistorySyntaxTokenBudget(lines))
      .toThrow('too many syntax tokens');
  });

  it('rejects malformed token rows in a successful worker response', async () => {
    const { isHistorySyntaxWorkerResponse } = await import(
      '../../src/editor/HistorySyntaxWorkerProtocol'
    );

    expect(isHistorySyntaxWorkerResponse({
      id: 1,
      type: 'tokenized',
      lines: [['bad-token']],
    })).toBe(false);
    expect(isHistorySyntaxWorkerResponse({
      id: 1,
      type: 'tokenized',
      lines: [[{ content: 'x', light: 'red', dark: '#eeeeee' }]],
    })).toBe(false);
  });
});
