import { describe, expect, it } from 'vitest';

describe('parseWebviewMessage', () => {
  it('accepts known typed messages and rejects malformed payloads', async () => {
    const modulePath = '../../src/protocol/messages';
    const protocol = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(protocol, 'the typed webview protocol must exist').toBeDefined();
    if (!protocol) return;

    expect(
      protocol.parseWebviewMessage({
        type: 'selectCommit',
        requestId: 'request-1',
        repositoryId: 'repository-1',
        hash: 'abc1234',
      }),
    ).toEqual({
      type: 'selectCommit',
      requestId: 'request-1',
      repositoryId: 'repository-1',
      hash: 'abc1234',
    });

    expect(protocol.parseWebviewMessage({ type: 'ready', requestId: 'ready-1' })).toEqual({
      type: 'ready',
      requestId: 'ready-1',
    });
    expect(protocol.parseWebviewMessage({ type: 'selectCommit', hash: '--unsafe' })).toBeUndefined();
    expect(protocol.parseWebviewMessage({ type: 'unknown', requestId: 'x' })).toBeUndefined();
    expect(protocol.parseWebviewMessage('selectCommit')).toBeUndefined();
    expect(
      protocol.parseWebviewMessage({
        type: 'openDiff',
        requestId: 'diff-1',
        repositoryId: 'repository-1',
        hash: 'abcdef1',
        parent: '1234567',
        path: 'src/app.ts',
        oldPath: 'src/old.ts',
        status: 'R',
      }),
    ).toMatchObject({ type: 'openDiff', path: 'src/app.ts', status: 'R' });
    expect(
      protocol.parseWebviewMessage({
        type: 'openCommitComparison',
        requestId: 'compare-1',
        repositoryId: 'repository-1',
        hash: 'abcdef1',
        parent: '1234567',
        mode: 'parent',
      }),
    ).toMatchObject({ type: 'openCommitComparison', mode: 'parent', parent: '1234567' });
    expect(
      protocol.parseWebviewMessage({
        type: 'selectParent',
        requestId: 'parent-1',
        repositoryId: 'repository-1',
        hash: 'abcdef1',
        parent: '1234567',
      }),
    ).toMatchObject({ type: 'selectParent', parent: '1234567' });
    expect(
      protocol.parseWebviewMessage({
        type: 'runOperation',
        requestId: 'operation-1',
        repositoryId: 'repository-1',
        operation: { kind: 'reset', hash: 'abcdef1', mode: 'hard' },
      }),
    ).toMatchObject({ type: 'runOperation', operation: { kind: 'reset', mode: 'hard' } });
    expect(
      protocol.parseWebviewMessage({
        type: 'runOperation',
        requestId: 'operation-unsafe',
        repositoryId: 'repository-1',
        operation: { kind: 'checkout', ref: '--upload-pack=unsafe' },
      }),
    ).toBeUndefined();
    expect(
      protocol.parseWebviewMessage({
        type: 'requestHistoryPage',
        requestId: 'history-page-1',
        repositoryId: 'repository-1',
        skip: 200,
      }),
    ).toMatchObject({ type: 'requestHistoryPage', skip: 200 });
    expect(
      protocol.parseWebviewMessage({
        type: 'openHistoryDiff',
        requestId: 'history-diff-1',
        repositoryId: 'repository-1',
        hash: 'abcdef1',
        parent: '1234567',
      }),
    ).toMatchObject({ type: 'openHistoryDiff', hash: 'abcdef1', parent: '1234567' });
    expect(
      protocol.parseWebviewMessage({
        type: 'openHistoryDiff',
        requestId: 'history-diff-invalid-parent',
        repositoryId: 'repository-1',
        hash: 'abcdef1',
        parent: '--unsafe',
      }),
    ).toBeUndefined();
    expect(
      protocol.parseWebviewMessage({
        type: 'closeHistory',
        requestId: 'history-close-1',
        repositoryId: 'repository-1',
      }),
    ).toMatchObject({ type: 'closeHistory' });
    expect(
      protocol.parseWebviewMessage({
        type: 'switchHistoryToFile',
        requestId: 'history-file-fallback',
        repositoryId: 'repository-1',
      }),
    ).toMatchObject({ type: 'switchHistoryToFile' });
    expect(
      protocol.parseWebviewMessage({
        type: 'openFile',
        requestId: 'open-file-1',
        repositoryId: 'repository-1',
        hash: 'abcdef1',
        parent: '1234567',
        path: 'src/app.ts',
        status: 'M',
        mode: 'revision',
      }),
    ).toMatchObject({ type: 'openFile', mode: 'revision', path: 'src/app.ts' });
    expect(
      protocol.parseWebviewMessage({
        type: 'openFile',
        requestId: 'open-file-traversal',
        repositoryId: 'repository-1',
        hash: 'abcdef1',
        path: '../outside.txt',
        status: 'M',
        mode: 'current',
      }),
    ).toBeUndefined();
    expect(
      protocol.parseWebviewMessage({
        type: 'runOperation',
        requestId: 'delete-remote-1',
        repositoryId: 'repository-1',
        operation: { kind: 'deleteRemoteBranch', remote: 'origin', branch: 'feature' },
      }),
    ).toBeDefined();
    expect(
      protocol.parseWebviewMessage({
        type: 'runOperation',
        requestId: 'delete-remote-tag',
        repositoryId: 'repository-1',
        operation: { kind: 'deleteRemoteBranch', remote: 'origin', branch: 'refs/tags/v1' },
      }),
    ).toBeUndefined();
    expect(protocol.parseWebviewMessage({ type: 'showOutput', requestId: 'output-1' })).toEqual({
      type: 'showOutput',
      requestId: 'output-1',
    });
    expect(
      protocol.parseWebviewMessage({
        type: 'copyToClipboard',
        requestId: 'copy-1',
        text: 'diagnostic',
      }),
    ).toMatchObject({ type: 'copyToClipboard', text: 'diagnostic' });
    expect(
      protocol.parseWebviewMessage({
        type: 'updateScrollAnchor',
        requestId: 'scroll-1',
        repositoryId: 'repository-1',
        scrollTop: 8400,
        logOffset: 5000,
        graphContinuation: {
          lanes: [{ id: 1, target: 'abcdef1', colorIndex: 2 }],
          nextLaneId: 3,
          nextColorIndex: 4,
        },
      }),
    ).toMatchObject({
      type: 'updateScrollAnchor',
      scrollTop: 8400,
      logOffset: 5000,
      graphContinuation: {
        lanes: [{ id: 1, target: 'abcdef1', colorIndex: 2 }],
      },
    });
    expect(
      protocol.parseWebviewMessage({
        type: 'updateScrollAnchor',
        requestId: 'scroll-invalid',
        repositoryId: 'repository-1',
        scrollTop: -1,
      }),
    ).toBeUndefined();
    for (const name of ['feature..bad', 'bad name', 'topic.lock', 'foo~bar']) {
      expect(
        protocol.parseWebviewMessage({
          type: 'runOperation',
          requestId: `invalid-ref-${name}`,
          repositoryId: 'repository-1',
          operation: { kind: 'createBranch', name, startPoint: 'abcdef1' },
        }),
      ).toBeUndefined();
    }
    expect(
      protocol.parseWebviewMessage({
        type: 'updateScrollAnchor',
        requestId: 'scroll-invalid-offset',
        repositoryId: 'repository-1',
        scrollTop: 0,
        logOffset: 10_000_001,
      }),
    ).toBeUndefined();
    expect(
      protocol.parseWebviewMessage({
        type: 'updateFilters',
        requestId: 'branch-option-injection',
        repositoryId: 'repository-1',
        filters: {
          text: '',
          branches: ['--output=/tmp/overwritten'],
          authors: [],
          paths: [],
        },
      }),
    ).toBeUndefined();
  });

  it('bounds filter payloads and rejects control characters or invalid dates', async () => {
    const { parseWebviewMessage } = await import('../../src/protocol/messages');
    const message = (filters: Record<string, unknown>) => ({
      type: 'updateFilters',
      requestId: 'filters-1',
      repositoryId: 'repository-1',
      filters: { text: '', branches: [], authors: [], paths: [], ...filters },
    });

    expect(parseWebviewMessage(message({ authors: ['A+B [bot]'] }))).toBeDefined();
    expect(parseWebviewMessage(message({ text: 'line\nbreak' }))).toBeUndefined();
    expect(parseWebviewMessage(message({ authors: ['Alice\rAdmin'] }))).toBeUndefined();
    expect(parseWebviewMessage(message({ paths: ['src\0unsafe'] }))).toBeUndefined();
    expect(parseWebviewMessage(message({ text: 'x'.repeat(2001) }))).toBeUndefined();
    expect(parseWebviewMessage(message({ authors: Array.from({ length: 101 }, () => 'Alice') }))).toBeUndefined();
    expect(parseWebviewMessage(message({ dateFrom: Number.NaN }))).toBeUndefined();
    expect(parseWebviewMessage(message({ dateTo: Number.POSITIVE_INFINITY }))).toBeUndefined();
    expect(parseWebviewMessage(message({ dateFrom: 200, dateTo: 100 }))).toBeUndefined();
    expect(
      parseWebviewMessage({
        type: 'requestLogPage',
        requestId: 'deep-page',
        repositoryId: 'repository-1',
        skip: 100_000,
      }),
    ).toBeDefined();
    expect(
      parseWebviewMessage({
        type: 'requestLogPage',
        requestId: 'absurd-page',
        repositoryId: 'repository-1',
        skip: 10_000_001,
      }),
    ).toBeUndefined();
    expect(
      parseWebviewMessage({
        type: 'updateLayout',
        requestId: 'layout-hidden-columns',
        layout: {
          refsWidth: 220,
          filesWidth: 320,
          detailsHeight: 156,
          filesViewMode: 'tree',
          hiddenColumns: ['refs', 'refs', 'refs', 'refs'],
        },
      }),
    ).toBeUndefined();
    expect(
      parseWebviewMessage({
        type: 'updateLayout',
        requestId: 'layout-invalid-commit-width',
        layout: {
          refsWidth: 220,
          filesWidth: 320,
          detailsHeight: 156,
          filesViewMode: 'tree',
          commitColumnWidth: 10,
        },
      }),
    ).toBeUndefined();
  });
});
