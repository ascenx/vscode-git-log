import type { CommitDetails, SignatureStatus } from '../../shared/models';

function parseTimestamp(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseSignature(value: string | undefined): SignatureStatus {
  switch (value) {
    case 'G':
      return 'good';
    case 'B':
      return 'bad';
    case 'U':
      return 'unknown';
    case 'X':
    case 'Y':
      return 'expired';
    case 'R':
      return 'revoked';
    case 'E':
      return 'error';
    case 'N':
    default:
      return 'none';
  }
}

export function parseCommitDetails(output: Buffer): CommitDetails {
  const fields = output.toString('utf8').split('\0');
  const body = fields[8] ?? '';
  const subject = body.split(/\r?\n/u, 1)[0] ?? '';

  return {
    hash: fields[0] ?? '',
    parents: (fields[1] ?? '').split(' ').filter(Boolean),
    authorName: fields[2] ?? '',
    authorEmail: fields[3] ?? '',
    authorTime: parseTimestamp(fields[4]),
    committerName: fields[5] ?? '',
    committerEmail: fields[6] ?? '',
    commitTime: parseTimestamp(fields[7]),
    subject,
    body,
    refs: [],
    signature: parseSignature(fields[9]),
  };
}
