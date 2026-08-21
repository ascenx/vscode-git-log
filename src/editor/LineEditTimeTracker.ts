import { createHash } from 'node:crypto';

export interface LineEditTimeChange {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  text: string;
}

export interface RecordLineEditTimesOptions {
  documentKey: string;
  lineCount: number;
  lineText(line: number): string;
  changes: readonly LineEditTimeChange[];
  editTime: number;
  activeLine?: number;
}

interface LineEditTime {
  text?: string;
  textHash: string;
  editTime: number;
}

interface LineEditTimeTrackerOptions {
  maximumDocuments: number;
  maximumLines: number;
  maximumLineCharacters?: number;
}

export interface SerializedLineEditTimeTracker {
  version: 1;
  documents: Array<{
    documentKey: string;
    entries: Array<{ line: number; textHash: string; editTime: number }>;
  }>;
}

function fingerprintLine(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function fingerprintDocumentKey(documentKey: string): string {
  return createHash('sha256').update(`document:${documentKey}`).digest('hex');
}

function countLineBreaks(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text.charCodeAt(index);
    if (character === 10) {
      count += 1;
    } else if (character === 13) {
      count += 1;
      if (text.charCodeAt(index + 1) === 10) index += 1;
    }
  }
  return count;
}

function comparePositions(
  left: { line: number; character: number },
  right: { line: number; character: number },
): number {
  return left.line - right.line || left.character - right.character;
}

export class LineEditTimeTracker {
  private readonly documents = new Map<string, Map<number, LineEditTime>>();

  constructor(
    private readonly options: LineEditTimeTrackerOptions,
    initialState?: SerializedLineEditTimeTracker,
  ) {
    if (initialState?.version !== 1 || !Array.isArray(initialState.documents)) return;
    for (const document of initialState.documents.slice(-options.maximumDocuments)) {
      if (!document || typeof document.documentKey !== 'string' || !Array.isArray(document.entries))
        continue;
      const entries = new Map<number, LineEditTime>();
      for (const entry of document.entries.slice(-options.maximumLines)) {
        if (
          !entry ||
          !Number.isSafeInteger(entry.line) ||
          entry.line < 0 ||
          typeof entry.textHash !== 'string' ||
          !Number.isFinite(entry.editTime)
        ) {
          continue;
        }
        entries.set(entry.line, { textHash: entry.textHash, editTime: entry.editTime });
      }
      if (entries.size > 0) this.documents.set(document.documentKey, entries);
    }
  }

  get(documentKey: string, line: number, text: string): number | undefined {
    const entry = this.documents.get(fingerprintDocumentKey(documentKey))?.get(line);
    if (!entry) return undefined;
    const matches =
      entry.text !== undefined ? entry.text === text : entry.textHash === fingerprintLine(text);
    return matches ? entry.editTime : undefined;
  }

  sizeForDocument(documentKey: string): number {
    return this.documents.get(fingerprintDocumentKey(documentKey))?.size ?? 0;
  }

  serialize(maximumEntries = 2_000): SerializedLineEditTimeTracker {
    let remainingEntries = Math.max(0, maximumEntries);
    const documents: SerializedLineEditTimeTracker['documents'] = [];
    const recentDocuments = [...this.documents.entries()].reverse();
    for (const [documentKey, editTimes] of recentDocuments) {
      const entries: Array<{ line: number; textHash: string; editTime: number }> = [];
      for (const [line, entry] of [...editTimes.entries()].reverse()) {
        if (remainingEntries === 0) break;
        entries.push({ line, textHash: entry.textHash, editTime: entry.editTime });
        remainingEntries -= 1;
      }
      if (entries.length > 0) documents.push({ documentKey, entries: entries.reverse() });
      if (remainingEntries === 0) break;
    }
    return { version: 1, documents: documents.reverse() };
  }

  record(options: RecordLineEditTimesOptions): void {
    const documentKey = fingerprintDocumentKey(options.documentKey);
    const changes = options.changes
      .map((change) => ({ change, insertedLineBreaks: countLineBreaks(change.text) }))
      .sort((left, right) =>
        comparePositions(left.change.range.start, right.change.range.start),
      );
    const previous = this.documents.get(documentKey) ?? new Map<number, LineEditTime>();
    const next = new Map<number, LineEditTime>();

    for (const [oldLine, entry] of previous) {
      let shiftedLine = oldLine;
      let affected = false;
      for (const { change, insertedLineBreaks } of changes) {
        const { start, end } = change.range;
        if (oldLine < start.line) break;
        const lineStartIsAfterChange =
          oldLine > end.line || (oldLine === end.line && end.character === 0);
        if (lineStartIsAfterChange) {
          shiftedLine += insertedLineBreaks - (end.line - start.line);
          continue;
        }
        affected = true;
        break;
      }
      if (
        !affected &&
        shiftedLine >= 0 &&
        shiftedLine < options.lineCount &&
        this.getEntryMatches(entry, options.lineText(shiftedLine))
      ) {
        next.set(shiftedLine, entry);
      }
    }

    const changedLines = new Set<number>();
    if (options.activeLine !== undefined) changedLines.add(options.activeLine);
    let precedingDelta = 0;
    for (const { change, insertedLineBreaks } of changes) {
      const startLine = change.range.start.line + precedingDelta;
      const available = Math.max(0, this.options.maximumLines - changedLines.size);
      const linesToRecord = Math.min(insertedLineBreaks + 1, available);
      for (let offset = 0; offset < linesToRecord; offset += 1) {
        changedLines.add(startLine + offset);
      }
      precedingDelta += insertedLineBreaks - (change.range.end.line - change.range.start.line);
    }

    for (const line of changedLines) {
      if (line < 0 || line >= options.lineCount) continue;
      if (next.has(line)) continue;
      const text = options.lineText(line);
      if (text.length > (this.options.maximumLineCharacters ?? 16 * 1024)) continue;
      next.set(line, { text, textHash: fingerprintLine(text), editTime: options.editTime });
    }
    while (next.size > this.options.maximumLines) {
      const oldestLine = next.keys().next().value as number | undefined;
      if (oldestLine === undefined) break;
      next.delete(oldestLine);
    }

    this.documents.delete(documentKey);
    this.documents.set(documentKey, next);
    while (this.documents.size > this.options.maximumDocuments) {
      const oldestDocument = this.documents.keys().next().value as string | undefined;
      if (!oldestDocument) break;
      this.documents.delete(oldestDocument);
    }
  }

  private getEntryMatches(entry: LineEditTime, text: string): boolean {
    if (text.length > (this.options.maximumLineCharacters ?? 16 * 1024)) return false;
    return entry.text !== undefined
      ? entry.text === text
      : entry.textHash === fingerprintLine(text);
  }
}
