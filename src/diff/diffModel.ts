import type { ChangedFileStatus } from '../shared/models';

export type DiffSide =
  | { kind: 'empty'; path: string }
  | { kind: 'revision'; revision: string; path: string };

export interface DiffRequest {
  hash: string;
  parent?: string;
  path: string;
  oldPath?: string;
  status: ChangedFileStatus;
}

export interface DiffSides {
  left: DiffSide;
  right: DiffSide;
}

export function buildDiffSides(request: DiffRequest): DiffSides {
  const leftPath = request.oldPath ?? request.path;
  const left: DiffSide =
    request.status === 'A' || !request.parent
      ? { kind: 'empty', path: leftPath }
      : { kind: 'revision', revision: request.parent, path: leftPath };
  const right: DiffSide =
    request.status === 'D'
      ? { kind: 'empty', path: request.path }
      : { kind: 'revision', revision: request.hash, path: request.path };
  return { left, right };
}

export function buildRevisionFileTarget(
  request: DiffRequest,
): { revision: string; path: string } | undefined {
  if (request.status === 'D') {
    return request.parent
      ? { revision: request.parent, path: request.oldPath ?? request.path }
      : undefined;
  }
  return { revision: request.hash, path: request.path };
}

export interface RevisionQuery {
  repositoryId: string;
  revision: string;
  path: string;
  empty: boolean;
}

export function encodeRevisionQuery(query: RevisionQuery): string {
  const values = new URLSearchParams();
  values.set('repositoryId', query.repositoryId);
  values.set('revision', query.revision);
  values.set('path', query.path);
  values.set('empty', query.empty ? '1' : '0');
  return values.toString();
}

export function parseRevisionQuery(query: string): RevisionQuery | undefined {
  const values = new URLSearchParams(query);
  const repositoryId = values.get('repositoryId');
  const revision = values.get('revision');
  const path = values.get('path');
  const emptyValue = values.get('empty');
  if (!repositoryId || revision === null || !path || (emptyValue !== '0' && emptyValue !== '1')) {
    return undefined;
  }
  if (path.includes('\0') || (!revision && emptyValue !== '1')) return undefined;
  return { repositoryId, revision, path, empty: emptyValue === '1' };
}
