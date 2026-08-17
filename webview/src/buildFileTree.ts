import type { ChangedFile } from '../../src/shared/models';

export interface FileTreeDirectory {
  type: 'directory';
  name: string;
  path: string;
  children: FileTreeNode[];
}

export interface FileTreeFile {
  type: 'file';
  name: string;
  path: string;
  file: ChangedFile;
}

export type FileTreeNode = FileTreeDirectory | FileTreeFile;

export function buildFileTree(files: readonly ChangedFile[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];
  const directories = new Map<string, FileTreeDirectory>();

  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean);
    const fileName = parts.pop();
    if (!fileName) continue;

    let children = root;
    let parentPath = '';
    for (const directoryName of parts) {
      const directoryPath = parentPath ? `${parentPath}/${directoryName}` : directoryName;
      let directory = directories.get(directoryPath);
      if (!directory) {
        directory = {
          type: 'directory',
          name: directoryName,
          path: directoryPath,
          children: [],
        };
        directories.set(directoryPath, directory);
        children.push(directory);
      }
      children = directory.children;
      parentPath = directoryPath;
    }

    children.push({ type: 'file', name: fileName, path: file.path, file });
  }

  return root;
}
