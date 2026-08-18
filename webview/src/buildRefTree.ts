import type { RefLabel } from '../../src/shared/models';

export interface RefTreeDirectory {
  type: 'directory';
  id: string;
  name: string;
  path: string;
  children: RefTreeNode[];
}

export interface RefTreeLeaf {
  type: 'ref';
  name: string;
  path: string;
  ref: RefLabel;
}

export type RefTreeNode = RefTreeDirectory | RefTreeLeaf;

export function buildRefTree(refs: readonly RefLabel[]): RefTreeNode[] {
  const root: RefTreeNode[] = [];
  const directories = new Map<string, RefTreeDirectory>();

  for (const ref of refs) {
    const remoteName = ref.kind === 'remote' ? ref.remote : undefined;
    const remoteBranchPrefix = remoteName ? `${remoteName}/` : undefined;
    const branchName =
      remoteBranchPrefix && ref.shortName.startsWith(remoteBranchPrefix)
        ? ref.shortName.slice(remoteBranchPrefix.length)
        : ref.shortName;
    const parts = remoteName
      ? [remoteName, ...branchName.split('/').filter(Boolean)]
      : branchName.split('/').filter(Boolean);
    const refName = parts.pop();
    if (!refName) continue;

    let children = root;
    const directorySegments: string[] = [];
    for (const directoryName of parts) {
      directorySegments.push(directoryName);
      const directoryId = JSON.stringify(directorySegments);
      const directoryPath = directorySegments.join('/');
      let directory = directories.get(directoryId);
      if (!directory) {
        directory = {
          type: 'directory',
          id: directoryId,
          name: directoryName,
          path: directoryPath,
          children: [],
        };
        directories.set(directoryId, directory);
        children.push(directory);
      }
      children = directory.children;
    }

    children.push({ type: 'ref', name: refName, path: ref.shortName, ref });
  }

  return root;
}
