import { describe, expect, it } from 'vitest';
import type { ChangedFile } from '../../src/shared/models';

describe('buildFileTree', () => {
  it('groups changed files by directory while retaining the full file records', async () => {
    const modulePath = '../../webview/src/buildFileTree';
    const treeModule = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(treeModule, 'the changed-file tree builder must exist').toBeDefined();
    if (!treeModule) return;

    const files: ChangedFile[] = [
      { status: 'M', path: 'src/app.ts', binary: false },
      { status: 'A', path: 'src/utils/format.ts', binary: false },
      { status: 'M', path: 'README.md', binary: false },
    ];

    expect(treeModule.buildFileTree(files)).toEqual([
      {
        type: 'directory',
        name: 'src',
        path: 'src',
        children: [
          { type: 'file', name: 'app.ts', path: 'src/app.ts', file: files[0] },
          {
            type: 'directory',
            name: 'utils',
            path: 'src/utils',
            children: [
              {
                type: 'file',
                name: 'format.ts',
                path: 'src/utils/format.ts',
                file: files[1],
              },
            ],
          },
        ],
      },
      { type: 'file', name: 'README.md', path: 'README.md', file: files[2] },
    ]);
  });
});
