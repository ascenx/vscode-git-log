export interface LineHistoryPatchTarget {
  oldStartLine?: number;
  oldLineCount?: number;
  newStartLine?: number;
  newLineCount?: number;
}

export interface TracedLineHistoryTarget {
  target: LineHistoryPatchTarget;
  changed: boolean;
  previousLine?: string;
}

interface PatchRow {
  line: string;
  oldCursor: number;
  newCursor: number;
  oldLine?: number;
  newLine?: number;
  consumesOld: boolean;
  consumesNew: boolean;
}

const HUNK_PATTERN = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/u;

function containsLine(line: number | undefined, start: number | undefined, count: number | undefined): boolean {
  return line !== undefined && start !== undefined && count !== undefined && count > 0 &&
    line >= start && line < start + count;
}

function targetRow(row: PatchRow, target: LineHistoryPatchTarget): boolean {
  return containsLine(row.oldLine, target.oldStartLine, target.oldLineCount) ||
    containsLine(row.newLine, target.newStartLine, target.newLineCount);
}

function copyTarget(target: LineHistoryPatchTarget): LineHistoryPatchTarget {
  return {
    ...(target.oldStartLine !== undefined ? { oldStartLine: target.oldStartLine } : {}),
    ...(target.oldLineCount !== undefined ? { oldLineCount: target.oldLineCount } : {}),
    ...(target.newStartLine !== undefined ? { newStartLine: target.newStartLine } : {}),
    ...(target.newLineCount !== undefined ? { newLineCount: target.newLineCount } : {}),
  };
}

function parseRows(lines: readonly string[], oldStart: number, newStart: number): PatchRow[] {
  const rows: PatchRow[] = [];
  let oldCursor = oldStart;
  let newCursor = newStart;
  for (const line of lines) {
    const prefix = line[0];
    const consumesOld = prefix === ' ' || prefix === '-';
    const consumesNew = prefix === ' ' || prefix === '+';
    rows.push({
      line,
      oldCursor,
      newCursor,
      ...(consumesOld ? { oldLine: oldCursor } : {}),
      ...(consumesNew ? { newLine: newCursor } : {}),
      consumesOld,
      consumesNew,
    });
    if (consumesOld) oldCursor += 1;
    if (consumesNew) newCursor += 1;
  }
  return rows;
}

function comparableLine(line: string): string {
  return line.slice(1).trim().replace(/\s+/gu, ' ');
}

function bigramSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return 0;
  const leftBigrams = new Map<string, number>();
  for (let index = 0; index < left.length - 1; index += 1) {
    const bigram = left.slice(index, index + 2);
    leftBigrams.set(bigram, (leftBigrams.get(bigram) ?? 0) + 1);
  }
  let matches = 0;
  for (let index = 0; index < right.length - 1; index += 1) {
    const bigram = right.slice(index, index + 2);
    const available = leftBigrams.get(bigram) ?? 0;
    if (available === 0) continue;
    matches += 1;
    leftBigrams.set(bigram, available - 1);
  }
  return (2 * matches) / (left.length + right.length - 2);
}

function bestMatchingRow(rows: readonly PatchRow[], line: string): PatchRow | undefined {
  const comparable = comparableLine(line);
  const exact = rows.find((row) => comparableLine(row.line) === comparable);
  if (exact) return exact;
  let best: PatchRow | undefined;
  let bestScore = -1;
  for (const row of rows) {
    const score = bigramSimilarity(comparableLine(row.line), comparable);
    if (score <= bestScore) continue;
    best = row;
    bestScore = score;
  }
  return best;
}

export function traceCurrentLineHistoryTarget(
  patch: string,
  target: LineHistoryPatchTarget,
  currentLine?: string,
): TracedLineHistoryTarget {
  const lines = patch.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const hunk = HUNK_PATTERN.exec(lines[index] ?? '');
    if (!hunk) continue;
    let end = index + 1;
    while (end < lines.length && !HUNK_PATTERN.test(lines[end] ?? '') && !(lines[end] ?? '').startsWith('diff --git ')) {
      end += 1;
    }
    const rows = parseRows(
      lines.slice(index + 1, end),
      Number.parseInt(hunk[1] ?? '0', 10),
      Number.parseInt(hunk[3] ?? '0', 10),
    );
    const newRows = rows.filter((row) =>
      containsLine(row.newLine, target.newStartLine, target.newLineCount));
    const addedRows = newRows.filter((row) => row.line.startsWith('+'));
    const selectedNew = currentLine === undefined
      ? newRows.length === 1
        ? newRows[0]
        : addedRows.length === 1
          ? addedRows[0]
          : undefined
      : bestMatchingRow(newRows, ` ${currentLine}`);
    if (!selectedNew?.newLine) continue;

    const oldRows = rows.filter((row) =>
      containsLine(row.oldLine, target.oldStartLine, target.oldLineCount));
    const deletedRows = oldRows.filter((row) => row.line.startsWith('-'));
    const selectedOld = selectedNew.oldLine !== undefined
      ? selectedNew
      : bestMatchingRow(deletedRows, selectedNew.line);
    const oldStartLine = selectedOld?.oldLine ?? target.oldStartLine;
    return {
      target: {
        ...(oldStartLine !== undefined ? { oldStartLine } : {}),
        ...(selectedOld
          ? { oldLineCount: 1 }
          : target.oldLineCount !== undefined
            ? { oldLineCount: target.oldLineCount }
            : {}),
        newStartLine: selectedNew.newLine,
        newLineCount: 1,
      },
      changed: selectedNew.line.startsWith('+'),
      ...(selectedOld ? { previousLine: selectedOld.line.slice(1) } : {}),
    };
  }
  return { target: copyTarget(target), changed: true };
}

function expandContextBoundary(
  rows: readonly PatchRow[],
  targetIndex: number,
  direction: -1 | 1,
  contextLines: number,
  contextPrefix: ' ' | '+' | '-',
): number {
  let boundary = targetIndex;
  let countedContextLines = 0;
  while (countedContextLines < contextLines) {
    const next = boundary + direction;
    if (next < 0 || next >= rows.length) break;
    boundary = next;
    if (rows[boundary]?.line.startsWith(contextPrefix)) countedContextLines += 1;
  }
  return boundary;
}

export function extractLineHistoryContextPatch(
  patch: string,
  target: LineHistoryPatchTarget,
  contextLines: number,
): string | undefined {
  if (!Number.isSafeInteger(contextLines) || contextLines < 0) return undefined;
  const lines = patch.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const hunk = HUNK_PATTERN.exec(lines[index] ?? '');
    if (!hunk) continue;
    let end = index + 1;
    while (end < lines.length && !HUNK_PATTERN.test(lines[end] ?? '') && !(lines[end] ?? '').startsWith('diff --git ')) {
      end += 1;
    }
    const rows = parseRows(
      lines.slice(index + 1, end),
      Number.parseInt(hunk[1] ?? '0', 10),
      Number.parseInt(hunk[3] ?? '0', 10),
    );
    const targetIndexes = rows
      .map((row, rowIndex) => targetRow(row, target) ? rowIndex : -1)
      .filter((rowIndex) => rowIndex >= 0);
    if (!targetIndexes.length) continue;
    const firstTarget = targetIndexes[0] ?? 0;
    const lastTarget = targetIndexes.at(-1) ?? firstTarget;
    const hunkOldCount = hunk[2] === undefined ? 1 : Number.parseInt(hunk[2], 10);
    const hunkNewCount = hunk[4] === undefined ? 1 : Number.parseInt(hunk[4], 10);
    const contextPrefix = hunkOldCount === 0 ? '+' : hunkNewCount === 0 ? '-' : ' ';
    const first = expandContextBoundary(
      rows,
      firstTarget,
      -1,
      contextLines,
      contextPrefix,
    );
    const last = expandContextBoundary(
      rows,
      lastTarget,
      1,
      contextLines,
      contextPrefix,
    ) + 1;
    const selected = rows.slice(first, last);
    const oldStart = selected[0]?.oldCursor ?? Number.parseInt(hunk[1] ?? '0', 10);
    const newStart = selected[0]?.newCursor ?? Number.parseInt(hunk[3] ?? '0', 10);
    const oldCount = selected.filter((row) => row.consumesOld).length;
    const newCount = selected.filter((row) => row.consumesNew).length;
    return [
      `@@ -${String(oldStart)},${String(oldCount)} +${String(newStart)},${String(newCount)} @@${hunk[5] ?? ''}`,
      ...selected.map((row) => row.line),
    ].join('\n');
  }
  return undefined;
}
