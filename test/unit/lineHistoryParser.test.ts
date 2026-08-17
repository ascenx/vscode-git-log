import { describe, expect, it } from 'vitest';

describe('line history parser', () => {
  it('parses commit metadata, patch statistics, hunk positions, refs, and paths', async () => {
    const modulePath = '../../src/git/parsers/parseLineHistory';
    const parserModule = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(parserModule, 'parseLineHistory must exist').toBeDefined();
    if (!parserModule) return;

    const hash = 'a'.repeat(40);
    const parent = 'b'.repeat(40);
    const output = Buffer.from(
      `\x1e${hash}\x00${parent}\x00Alice\x00alice@example.com\x00100\x00200\x00update line\x00\n\n` +
        'diff --git a/src/old.ts b/src/app.ts\n' +
        '--- a/src/old.ts\n' +
        '+++ b/src/app.ts\n' +
        '@@ -10,2 +10,3 @@\n' +
        '-old one\n' +
        '-old two\n' +
        '+new one\n' +
        '+new two\n' +
        '+new three\n',
    );

    expect(
      parserModule.parseLineHistory(
        output,
        [
          {
            fullName: 'refs/heads/main',
            shortName: 'main',
            kind: 'local',
            target: hash,
            ahead: 0,
            behind: 0,
            isCurrent: true,
          },
        ],
        'src/app.ts',
      ),
    ).toEqual([
      expect.objectContaining({
        hash,
        parents: [parent],
        subject: 'update line',
        refs: [expect.objectContaining({ shortName: 'main' })],
        path: 'src/app.ts',
        oldPath: 'src/old.ts',
        additions: 3,
        deletions: 2,
        binary: false,
        oldStartLine: 10,
        oldLineCount: 2,
        newStartLine: 10,
        newLineCount: 3,
        linePatch: expect.stringContaining('-old one\n-old two\n+new one'),
      }),
    ]);
  });

  it('omits binary output that cannot provide a line-level diff', async () => {
    const { parseLineHistory } = await import('../../src/git/parsers/parseLineHistory');
    const hash = 'c'.repeat(40);
    const entries = parseLineHistory(
      Buffer.from(
        `\x1e${hash}\x00\x00Bob\x00bob@example.com\x00300\x00400\x00binary\x00\n\n` +
          'diff --git a/image.png b/image.png\n' +
          'Binary files a/image.png and b/image.png differ\n',
      ),
      [],
      'image.png',
    );

    expect(entries).toEqual([]);
  });

  it('counts real content lines that resemble patch headers and ignores no-newline markers', async () => {
    const { parseLineHistory } = await import('../../src/git/parsers/parseLineHistory');
    const hash = 'd'.repeat(40);
    const entry = parseLineHistory(
      Buffer.from(
        `\x1e${hash}\x00\x00Bob\x00bob@example.com\x00300\x00400\x00header-like content\x00\n\n` +
          'diff --git a/app.txt b/app.txt\n' +
          '--- a/app.txt\n' +
          '+++ b/app.txt\n' +
          '@@ -1 +1 @@\n' +
          '---old heading\n' +
          '\\ No newline at end of file\n' +
          '+++new heading\n' +
          '\\ No newline at end of file\n',
      ),
      [],
      'app.txt',
    )[0];

    expect(entry).toMatchObject({ additions: 1, deletions: 1 });
  });

  it('omits commit records that contain no line-level change', async () => {
    const { parseLineHistory } = await import('../../src/git/parsers/parseLineHistory');
    const emptyHash = 'e'.repeat(40);
    const changedHash = 'f'.repeat(40);
    const output = Buffer.from(
      `\x1e${emptyHash}\x00\x00Alice\x00alice@example.com\x001\x002\x00metadata only\x00\n` +
        `\x1e${changedHash}\x00\x00Alice\x00alice@example.com\x003\x004\x00change line\x00\n\n` +
        'diff --git a/app.txt b/app.txt\n' +
        '--- a/app.txt\n' +
        '+++ b/app.txt\n' +
        '@@ -2 +2 @@\n' +
        '-old\n' +
        '+new\n',
    );

    const entries = parseLineHistory(output, [], 'app.txt');

    expect(entries.map((entry) => entry.hash)).toEqual([changedHash]);
  });
});
