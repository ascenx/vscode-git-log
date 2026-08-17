import { describe, expect, it } from 'vitest';

describe('changed-file parsers', () => {
  it('parses NUL-delimited statuses including rename and copy source paths', async () => {
    const modulePath = '../../src/git/parsers/parseChangedFiles';
    const parser = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(parser, 'the changed-files parser must exist').toBeDefined();
    if (!parser) return;

    const output = Buffer.from(
      'M\0src/app.ts\0A\0README.md\0D\0old.txt\0R100\0before.ts\0after.ts\0C87\0source.ts\0copy.ts\0',
      'utf8',
    );

    expect(parser.parseNameStatus(output)).toEqual([
      { status: 'M', path: 'src/app.ts', binary: false },
      { status: 'A', path: 'README.md', binary: false },
      { status: 'D', path: 'old.txt', binary: false },
      { status: 'R', oldPath: 'before.ts', path: 'after.ts', binary: false },
      { status: 'C', oldPath: 'source.ts', path: 'copy.ts', binary: false },
    ]);
  });

  it('adds numstat counts and identifies binary and renamed files', async () => {
    const modulePath = '../../src/git/parsers/parseChangedFiles';
    const parser = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(parser, 'the changed-files parser must exist').toBeDefined();
    if (!parser) return;

    const files = [
      { status: 'M', path: 'src/app.ts', binary: false },
      { status: 'R', oldPath: 'before.ts', path: 'after.ts', binary: false },
      { status: 'A', path: 'logo.png', binary: false },
    ];
    const numstat = Buffer.from(
      '12\t3\tsrc/app.ts\0' + '2\t1\t\0before.ts\0after.ts\0' + '-\t-\tlogo.png\0',
      'utf8',
    );

    expect(parser.applyNumstat(files, numstat)).toEqual([
      { status: 'M', path: 'src/app.ts', additions: 12, deletions: 3, binary: false },
      {
        status: 'R',
        oldPath: 'before.ts',
        path: 'after.ts',
        additions: 2,
        deletions: 1,
        binary: false,
      },
      { status: 'A', path: 'logo.png', binary: true },
    ]);
  });
});
