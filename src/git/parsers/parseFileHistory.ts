import type { HistoryEntry, RefLabel } from '../../shared/models';

function parseCount(value: string): number | undefined {
  if (!/^\d+$/u.test(value)) return undefined;
  const count = Number.parseInt(value, 10);
  return Number.isSafeInteger(count) ? count : undefined;
}

function parseNumstat(stat: string): [added: string, deleted: string, path: string] {
  const firstSeparator = stat.indexOf('\t');
  const secondSeparator =
    firstSeparator === -1 ? -1 : stat.indexOf('\t', firstSeparator + 1);
  if (firstSeparator === -1 || secondSeparator === -1) return ['', '', ''];
  return [
    stat.slice(0, firstSeparator),
    stat.slice(firstSeparator + 1, secondSeparator),
    stat.slice(secondSeparator + 1),
  ];
}

export function parseFileHistory(output: Buffer, refs: readonly RefLabel[]): HistoryEntry[] {
  const records = output.toString('utf8').split('\x1e').slice(1);
  const entries: HistoryEntry[] = [];
  const seenHashes = new Set<string>();
  for (const record of records) {
    const fields = record.split('\0');
    const hash = fields[0]?.trim();
    if (!hash || seenHashes.has(hash)) continue;
    const stat = (fields[8] ?? '').replace(/^\r?\n/u, '');
    const [added, deleted, inlinePath] = parseNumstat(stat);
    const rename = inlinePath === '' && Boolean(fields[9]) && Boolean(fields[10]);
    const path = rename ? (fields[10] ?? '') : inlinePath;
    if (!path) continue;
    seenHashes.add(hash);
    const oldPath = rename ? fields[9] : undefined;
    const binary = added === '-' || deleted === '-';
    const additions = binary ? undefined : parseCount(added);
    const deletions = binary ? undefined : parseCount(deleted);
    entries.push({
      hash,
      parents: (fields[1] ?? '').split(' ').filter(Boolean),
      authorName: fields[2] ?? '',
      authorEmail: fields[3] ?? '',
      authorTime: Number.parseInt(fields[4] ?? '0', 10) || 0,
      commitTime: Number.parseInt(fields[5] ?? '0', 10) || 0,
      subject: fields[6] ?? '',
      refs: refs.filter((ref) => ref.target === hash),
      path,
      ...(oldPath ? { oldPath } : {}),
      ...(additions !== undefined ? { additions } : {}),
      ...(deletions !== undefined ? { deletions } : {}),
      binary,
    });
  }
  return entries;
}
