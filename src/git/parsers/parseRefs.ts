import type { RefKind, RefLabel } from '../../shared/models';

function classifyRef(fullName: string, remoteNames: readonly string[]): {
  kind: RefKind;
  shortName: string;
  remote?: string;
} | null {
  if (fullName.startsWith('refs/heads/')) {
    return { kind: 'local', shortName: fullName.slice('refs/heads/'.length) };
  }

  if (fullName.startsWith('refs/remotes/')) {
    const shortName = fullName.slice('refs/remotes/'.length);
    const separator = shortName.indexOf('/');
    const matchingRemotes = remoteNames.filter((candidate) =>
      shortName.startsWith(`${candidate}/`),
    );
    const remote =
      remoteNames.length === 0
        ? separator === -1
          ? shortName
          : shortName.slice(0, separator)
        : matchingRemotes.length === 1
          ? matchingRemotes[0]
          : undefined;
    return { kind: 'remote', shortName, ...(remote ? { remote } : {}) };
  }

  if (fullName.startsWith('refs/tags/')) {
    return { kind: 'tag', shortName: fullName.slice('refs/tags/'.length) };
  }

  return null;
}

function parseTracking(track: string): { ahead: number; behind: number } {
  const ahead = /ahead (\d+)/u.exec(track)?.[1];
  const behind = /behind (\d+)/u.exec(track)?.[1];

  return {
    ahead: ahead ? Number.parseInt(ahead, 10) : 0,
    behind: behind ? Number.parseInt(behind, 10) : 0,
  };
}

function shortenUpstream(upstream: string): string {
  if (upstream.startsWith('refs/remotes/')) return upstream.slice('refs/remotes/'.length);
  if (upstream.startsWith('refs/heads/')) return upstream.slice('refs/heads/'.length);
  return upstream;
}

export function parseRefs(
  output: Buffer,
  currentBranch?: string,
  remoteNames: readonly string[] = [],
): RefLabel[] {
  const fields = output.toString('utf8').split('\0');
  const refs: RefLabel[] = [];

  for (let index = 0; index + 4 < fields.length; index += 5) {
    const fullName = fields[index]?.replace(/^\r?\n/u, '');
    const objectTarget = fields[index + 1] ?? '';
    const peeledTarget = fields[index + 2] ?? '';
    const upstream = fields[index + 3] ?? '';
    const tracking = fields[index + 4] ?? '';
    const target = peeledTarget || objectTarget;

    if (!fullName || !target) continue;
    const classified = classifyRef(fullName, remoteNames);
    if (!classified) continue;

    const track = parseTracking(tracking);
    refs.push({
      fullName,
      shortName: classified.shortName,
      kind: classified.kind,
      target,
      ahead: track.ahead,
      behind: track.behind,
      isCurrent: classified.kind === 'local' && classified.shortName === currentBranch,
      ...(classified.remote ? { remote: classified.remote } : {}),
      ...(upstream ? { upstream: shortenUpstream(upstream) } : {}),
    });
  }

  return refs;
}
