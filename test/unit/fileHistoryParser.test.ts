import { describe, expect, it } from 'vitest';

describe('parseFileHistory', () => {
  it('parses machine-formatted commits, numstat, binary files, and renames', async () => {
    const modulePath = '../../src/git/parsers/parseFileHistory';
    const parserModule = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(parserModule, 'parseFileHistory must exist').toBeDefined();
    if (!parserModule) return;

    const firstHash = 'a'.repeat(40);
    const secondHash = 'b'.repeat(40);
    const firstMetadata = [
      firstHash,
      secondHash,
      'Alice',
      'alice@example.com',
      '1700000000',
      '1700000001',
      'rename file',
      '',
    ].join('\0');
    const secondMetadata = [
      secondHash,
      '',
      'Bob',
      'bob@example.com',
      '1600000000',
      '1600000001',
      'binary root',
      '',
    ].join('\0');
    const output = Buffer.from(
      `\x1e${firstMetadata}\0\n3\t2\t\0old name.ts\0new name.ts\0` +
        `\x1e${secondMetadata}\0\n-\t-\tbinary.bin\0`,
      'utf8',
    );

    expect(parserModule.parseFileHistory(output, [])).toEqual([
      expect.objectContaining({
        hash: firstHash,
        parents: [secondHash],
        subject: 'rename file',
        path: 'new name.ts',
        oldPath: 'old name.ts',
        additions: 3,
        deletions: 2,
        binary: false,
      }),
      expect.objectContaining({
        hash: secondHash,
        parents: [],
        path: 'binary.bin',
        binary: true,
      }),
    ]);
    const binaryEntry = parserModule.parseFileHistory(output, [])[1];
    expect(binaryEntry).not.toHaveProperty('additions');
    expect(binaryEntry).not.toHaveProperty('deletions');
  });

  it('preserves tabs inside a non-rename numstat path', async () => {
    const { parseFileHistory } = await import('../../src/git/parsers/parseFileHistory');
    const hash = 'c'.repeat(40);
    const metadata = [
      hash,
      '',
      'Alice',
      'alice@example.com',
      '1700000000',
      '1700000001',
      'tab path',
      '',
    ].join('\0');
    const path = 'src/tab\tname.ts';

    const entries = parseFileHistory(
      Buffer.from(`\x1e${metadata}\0\n2\t1\t${path}\0`, 'utf8'),
      [],
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ path, additions: 2, deletions: 1 });
  });

  it('ignores metadata-only records that do not contain a changed file path', async () => {
    const { parseFileHistory } = await import('../../src/git/parsers/parseFileHistory');
    const hash = 'd'.repeat(40);
    const metadata = [
      hash,
      `${'a'.repeat(40)} ${'b'.repeat(40)}`,
      'Alice',
      'alice@example.com',
      '1700000000',
      '1700000001',
      'merge metadata',
      '',
    ].join('\0');

    expect(parseFileHistory(Buffer.from(`\x1e${metadata}\0`, 'utf8'), [])).toEqual([]);
  });
});
