import { describe, expect, it, vi } from 'vitest';
import { LineEditTimeTracker } from '../../src/editor/LineEditTimeTracker';

interface TestChange {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  text: string;
}

function record(
  tracker: LineEditTimeTracker,
  lines: string[],
  changes: TestChange[],
  editTime: number,
  activeLine: number,
): void {
  tracker.record({
    documentKey: 'file:///repo/file.ts',
    lineCount: lines.length,
    lineText: (line) => lines[line] ?? '',
    changes,
    editTime,
    activeLine,
  });
}

describe('LineEditTimeTracker', () => {
  it('moves an existing timestamp when lines are inserted above it', () => {
    const tracker = new LineEditTimeTracker({ maximumDocuments: 5, maximumLines: 10 });
    record(
      tracker,
      ['first', 'edited', 'last'],
      [
        {
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 6 } },
          text: 'edited',
        },
      ],
      1_000,
      1,
    );

    record(
      tracker,
      ['inserted', 'first', 'edited', 'last'],
      [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          text: 'inserted\n',
        },
      ],
      2_000,
      0,
    );

    expect(tracker.get('file:///repo/file.ts', 2, 'edited')).toBe(1_000);
  });

  it('moves an existing timestamp when complete lines are deleted above it', () => {
    const tracker = new LineEditTimeTracker({ maximumDocuments: 5, maximumLines: 10 });
    record(
      tracker,
      ['remove', 'edited', 'last'],
      [
        {
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 6 } },
          text: 'edited',
        },
      ],
      1_000,
      1,
    );

    record(
      tracker,
      ['edited', 'last'],
      [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } },
          text: '',
        },
      ],
      2_000,
      0,
    );

    expect(tracker.get('file:///repo/file.ts', 0, 'edited')).toBe(1_000);
  });

  it('caps work for a newline-heavy paste before reading every resulting line', () => {
    const tracker = new LineEditTimeTracker({ maximumDocuments: 5, maximumLines: 10 });
    const lineText = vi.fn(() => 'pasted');

    tracker.record({
      documentKey: 'file:///repo/file.ts',
      lineCount: 100_001,
      lineText,
      changes: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          text: `${'pasted\n'.repeat(100_000)}pasted`,
        },
      ],
      editTime: 1_000,
      activeLine: 100_000,
    });

    expect(lineText.mock.calls.length).toBeLessThanOrEqual(10);
    expect(tracker.sizeForDocument('file:///repo/file.ts')).toBeLessThanOrEqual(10);
    expect(tracker.get('file:///repo/file.ts', 100_000, 'pasted')).toBe(1_000);
  });

  it('does not retain or hash an oversized single line', () => {
    const tracker = new LineEditTimeTracker({
      maximumDocuments: 5,
      maximumLines: 10,
      maximumLineCharacters: 1_024,
    });
    const longLine = 'x'.repeat(2 * 1024 * 1024);

    record(
      tracker,
      [longLine],
      [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          text: longLine,
        },
      ],
      1_000,
      0,
    );

    expect(tracker.sizeForDocument('file:///repo/file.ts')).toBe(0);
  });

  it('restores bounded edit timestamps after the extension reloads', () => {
    const options = { maximumDocuments: 5, maximumLines: 10 };
    const tracker = new LineEditTimeTracker(options);
    record(
      tracker,
      ['first', 'edited'],
      [
        {
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 6 } },
          text: 'edited',
        },
      ],
      1_000,
      1,
    );

    const serialized = tracker.serialize();
    expect(JSON.stringify(serialized)).not.toContain('edited');
    expect(JSON.stringify(serialized)).not.toContain('/repo/file.ts');
    const restored = new LineEditTimeTracker(options, serialized);

    expect(restored.get('file:///repo/file.ts', 1, 'edited')).toBe(1_000);
  });
});
