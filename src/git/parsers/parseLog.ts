import type { CommitSummary } from '../../shared/models';

function parseTimestamp(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function parseLog(output: Buffer): CommitSummary[] {
  return output
    .toString('utf8')
    .split('\x1e')
    .filter((record) => record.length > 0)
    .map((record) => {
      const fields = record.replace(/^\r?\n/u, '').split('\0');
      const hash = fields[0] ?? '';
      const parents = (fields[1] ?? '').split(' ').filter(Boolean);

      return {
        hash,
        parents,
        authorName: fields[2] ?? '',
        authorEmail: fields[3] ?? '',
        authorTime: parseTimestamp(fields[4]),
        commitTime: parseTimestamp(fields[5]),
        subject: fields[6] ?? '',
        refs: [],
      } satisfies CommitSummary;
    })
    .filter((commit) => commit.hash.length > 0);
}

export interface SearchableCommit {
  commit: CommitSummary;
  body: string;
}

export function parseSearchableLog(output: Buffer): SearchableCommit[] {
  return output
    .toString('utf8')
    .split('\x1e')
    .filter((record) => record.length > 0)
    .map((record) => {
      const fields = record.replace(/^\r?\n/u, '').split('\0');
      const hash = fields[0] ?? '';
      return {
        commit: {
          hash,
          parents: (fields[1] ?? '').split(' ').filter(Boolean),
          authorName: fields[2] ?? '',
          authorEmail: fields[3] ?? '',
          authorTime: parseTimestamp(fields[4]),
          commitTime: parseTimestamp(fields[5]),
          subject: fields[6] ?? '',
          refs: [],
        },
        body: fields[7] ?? '',
      } satisfies SearchableCommit;
    })
    .filter(({ commit }) => commit.hash.length > 0);
}
