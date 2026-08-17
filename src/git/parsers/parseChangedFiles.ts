import type { ChangedFile, ChangedFileStatus } from '../../shared/models';

const supportedStatuses = new Set<ChangedFileStatus>(['A', 'M', 'D', 'R', 'C', 'T', 'U']);

function statusFromToken(token: string): ChangedFileStatus | undefined {
  const status = token[0] as ChangedFileStatus | undefined;
  return status && supportedStatuses.has(status) ? status : undefined;
}

export function parseNameStatus(output: Buffer): ChangedFile[] {
  const fields = output.toString('utf8').split('\0');
  const files: ChangedFile[] = [];
  let index = 0;

  while (index < fields.length) {
    const token = fields[index]?.replace(/^\r?\n/u, '') ?? '';
    index += 1;
    if (!token) continue;

    const status = statusFromToken(token);
    if (!status) continue;

    if (status === 'R' || status === 'C') {
      const oldPath = fields[index] ?? '';
      const path = fields[index + 1] ?? '';
      index += 2;
      if (oldPath && path) files.push({ status, oldPath, path, binary: false });
      continue;
    }

    const path = fields[index] ?? '';
    index += 1;
    if (path) files.push({ status, path, binary: false });
  }

  return files;
}

interface NumstatEntry {
  additions?: number;
  deletions?: number;
  binary: boolean;
}

function parseCount(value: string): number | undefined {
  if (value === '-') return undefined;
  const count = Number.parseInt(value, 10);
  return Number.isFinite(count) ? count : undefined;
}

function parseNumstat(output: Buffer): Map<string, NumstatEntry> {
  const fields = output.toString('utf8').split('\0');
  const entries = new Map<string, NumstatEntry>();
  let index = 0;

  while (index < fields.length) {
    const header = fields[index] ?? '';
    index += 1;
    if (!header) continue;

    const parts = header.split('\t');
    const additions = parseCount(parts[0] ?? '');
    const deletions = parseCount(parts[1] ?? '');
    let path = parts.slice(2).join('\t');

    if (!path) {
      index += 1;
      path = fields[index] ?? '';
      index += 1;
    }

    if (!path) continue;
    entries.set(path, {
      ...(additions !== undefined ? { additions } : {}),
      ...(deletions !== undefined ? { deletions } : {}),
      binary: additions === undefined || deletions === undefined,
    });
  }

  return entries;
}

export function applyNumstat(files: readonly ChangedFile[], output: Buffer): ChangedFile[] {
  const stats = parseNumstat(output);
  return files.map((file) => {
    const entry = stats.get(file.path);
    if (!entry) return file;
    return {
      ...file,
      ...(entry.additions !== undefined ? { additions: entry.additions } : {}),
      ...(entry.deletions !== undefined ? { deletions: entry.deletions } : {}),
      binary: entry.binary,
    };
  });
}
