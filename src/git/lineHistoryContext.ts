export interface LineHistoryPatchTarget {
  oldStartLine?: number;
  oldLineCount?: number;
  newStartLine?: number;
  newLineCount?: number;
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
    const first = Math.max(0, firstTarget - contextLines);
    const last = Math.min(rows.length, lastTarget + contextLines + 1);
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
