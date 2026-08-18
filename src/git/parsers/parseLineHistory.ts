import type { HistoryEntry, RefLabel } from '../../shared/models';

export interface LineHistoryEntry extends HistoryEntry {
  linePatch: string;
}

const HUNK_PATTERN = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u;

function parseHunkCount(value: string | undefined): number {
  return value === undefined ? 1 : Number.parseInt(value, 10);
}

function decodeQuotedGitPath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  const body = value.slice(1, -1);
  const bytes: number[] = [];
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index] ?? '';
    if (character !== '\\') {
      bytes.push(...Buffer.from(character));
      continue;
    }
    const escaped = body[index + 1] ?? '';
    if (/^[0-7]$/u.test(escaped)) {
      const octal = body.slice(index + 1, index + 4);
      if (/^[0-7]{3}$/u.test(octal)) {
        bytes.push(Number.parseInt(octal, 8));
        index += 3;
        continue;
      }
    }
    const decoded = escaped === 't' ? '\t' : escaped === 'n' ? '\n' : escaped === 'r' ? '\r' : escaped;
    bytes.push(...Buffer.from(decoded));
    index += 1;
  }
  return Buffer.from(bytes).toString('utf8');
}

function patchPath(line: string, prefix: '--- ' | '+++ '): string | undefined {
  if (!line.startsWith(prefix)) return undefined;
  const raw = decodeQuotedGitPath(line.slice(prefix.length).replace(/\t.*$/u, ''));
  if (raw === '/dev/null') return undefined;
  return raw.startsWith('a/') || raw.startsWith('b/') ? raw.slice(2) : raw;
}

export function parseLineHistory(
  output: Buffer,
  refs: readonly RefLabel[],
  fallbackPath: string,
): LineHistoryEntry[] {
  const records = output.toString('utf8').split('\x1e').slice(1);
  const entries: LineHistoryEntry[] = [];
  for (const record of records) {
    const fields = record.split('\0');
    const hash = fields[0]?.trim();
    if (!hash) continue;
    const patch = fields.slice(7).join('\0').replace(/^\r?\n/u, '');
    const lines = patch.split(/\r?\n/u);
    let additions = 0;
    let deletions = 0;
    let hasHunk = false;
    let oldPath: string | undefined;
    let path: string | undefined;
    let oldStartLine: number | undefined;
    let oldLineCount: number | undefined;
    let newStartLine: number | undefined;
    let newLineCount: number | undefined;
    for (const line of lines) {
      if (!hasHunk) {
        oldPath = patchPath(line, '--- ') ?? oldPath;
        path = patchPath(line, '+++ ') ?? path;
      }
      const hunk = HUNK_PATTERN.exec(line);
      if (hunk) {
        hasHunk = true;
        if (oldStartLine === undefined) {
          oldStartLine = Number.parseInt(hunk[1] ?? '0', 10);
          oldLineCount = parseHunkCount(hunk[2]);
          newStartLine = Number.parseInt(hunk[3] ?? '0', 10);
          newLineCount = parseHunkCount(hunk[4]);
        }
        continue;
      }
      if (hasHunk && line.startsWith('+')) additions += 1;
      if (hasHunk && line.startsWith('-')) deletions += 1;
    }
    const binary = /^(?:Binary files .* differ|GIT binary patch)$/mu.test(patch);
    if (!hasHunk || additions + deletions === 0) continue;
    const resolvedPath = path ?? oldPath ?? fallbackPath;
    entries.push({
      hash,
      parents: (fields[1] ?? '').split(' ').filter(Boolean),
      authorName: fields[2] ?? '',
      authorEmail: fields[3] ?? '',
      authorTime: Number.parseInt(fields[4] ?? '0', 10) || 0,
      commitTime: Number.parseInt(fields[5] ?? '0', 10) || 0,
      subject: fields[6] ?? '',
      refs: refs.filter((ref) => ref.target === hash),
      path: resolvedPath,
      ...(oldPath && oldPath !== resolvedPath ? { oldPath } : {}),
      ...(!binary && hasHunk ? { additions, deletions } : {}),
      binary,
      linePatch: patch,
      ...(oldStartLine !== undefined ? { oldStartLine } : {}),
      ...(oldLineCount !== undefined ? { oldLineCount } : {}),
      ...(newStartLine !== undefined ? { newStartLine } : {}),
      ...(newLineCount !== undefined ? { newLineCount } : {}),
    });
  }
  return entries;
}
