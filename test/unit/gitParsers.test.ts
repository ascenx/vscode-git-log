import { describe, expect, it } from 'vitest';

describe('Git machine-readable parsers', () => {
  it('parses refs and classifies local, remote, and tag labels', async () => {
    const modulePath = '../../src/git/parsers/parseRefs';
    const parser = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(parser, 'the refs parser must exist').toBeDefined();
    if (!parser) return;

    const output = Buffer.from(
      [
        'refs/heads/main\0aaaaaaaa\0\0refs/remotes/origin/main\0[ahead 2, behind 1]\0',
        '\nrefs/remotes/origin/main\0bbbbbbbb\0\0\0\0',
        '\nrefs/tags/v1.0.0\0tag-object\0cccccccc\0\0\0\n',
      ].join(''),
    );

    expect(parser.parseRefs(output, 'main')).toEqual([
      {
        fullName: 'refs/heads/main',
        shortName: 'main',
        kind: 'local',
        target: 'aaaaaaaa',
        upstream: 'origin/main',
        ahead: 2,
        behind: 1,
        isCurrent: true,
      },
      {
        fullName: 'refs/remotes/origin/main',
        shortName: 'origin/main',
        kind: 'remote',
        remote: 'origin',
        target: 'bbbbbbbb',
        ahead: 0,
        behind: 0,
        isCurrent: false,
      },
      {
        fullName: 'refs/tags/v1.0.0',
        shortName: 'v1.0.0',
        kind: 'tag',
        target: 'cccccccc',
        ahead: 0,
        behind: 0,
        isCurrent: false,
      },
    ]);
  });

  it('matches remote refs against a configured remote name containing a slash', async () => {
    const { parseRefs } = await import('../../src/git/parsers/parseRefs');
    const output = Buffer.from(
      `refs/remotes/team/origin/feature\0${'a'.repeat(40)}\0\0\0\0\n`,
    );

    expect(parseRefs(output, undefined, ['team/origin'])).toEqual([
      expect.objectContaining({
        fullName: 'refs/remotes/team/origin/feature',
        shortName: 'team/origin/feature',
        kind: 'remote',
        remote: 'team/origin',
      }),
    ]);
  });

  it('does not assign an owner when multiple configured remotes match one tracking ref', async () => {
    const { parseRefs } = await import('../../src/git/parsers/parseRefs');
    const output = Buffer.from(
      `refs/remotes/team/origin/feature\0${'a'.repeat(40)}\0\0\0\0\n`,
    );

    const [ref] = parseRefs(output, undefined, ['team', 'team/origin']);

    expect(ref).toMatchObject({
      fullName: 'refs/remotes/team/origin/feature',
      kind: 'remote',
    });
    expect(ref).not.toHaveProperty('remote');
  });

  it('parses paged log records without losing unicode or parent hashes', async () => {
    const modulePath = '../../src/git/parsers/parseLog';
    const parser = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(parser, 'the log parser must exist').toBeDefined();
    if (!parser) return;

    const output = Buffer.from(
      '\x1ehash2\x00hash1 side-parent\x00张三\x00dev@example.com\x001700000002\x001700000003\x00修复登录 🚀\x00' +
        '\x1ehash1\x00\x00Alice\x00alice@example.com\x001700000000\x001700000001\x00initial commit\x00',
      'utf8',
    );

    expect(parser.parseLog(output)).toEqual([
      {
        hash: 'hash2',
        parents: ['hash1', 'side-parent'],
        subject: '修复登录 🚀',
        authorName: '张三',
        authorEmail: 'dev@example.com',
        authorTime: 1_700_000_002,
        commitTime: 1_700_000_003,
        refs: [],
      },
      {
        hash: 'hash1',
        parents: [],
        subject: 'initial commit',
        authorName: 'Alice',
        authorEmail: 'alice@example.com',
        authorTime: 1_700_000_000,
        commitTime: 1_700_000_001,
        refs: [],
      },
    ]);
  });

  it('preserves multiline commit details and signature status', async () => {
    const modulePath = '../../src/git/parsers/parseCommitDetails';
    const parser = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(parser, 'the commit-details parser must exist').toBeDefined();
    if (!parser) return;

    const output = Buffer.from(
      [
        'hash2',
        'hash1',
        '张三',
        'dev@example.com',
        '1700000002',
        'CI Bot',
        'ci@example.com',
        '1700000003',
        'Subject line\n\nDetailed body with 中文.\n',
        'G',
      ].join('\0'),
      'utf8',
    );

    expect(parser.parseCommitDetails(output)).toEqual({
      hash: 'hash2',
      parents: ['hash1'],
      subject: 'Subject line',
      body: 'Subject line\n\nDetailed body with 中文.\n',
      authorName: '张三',
      authorEmail: 'dev@example.com',
      authorTime: 1_700_000_002,
      commitTime: 1_700_000_003,
      committerName: 'CI Bot',
      committerEmail: 'ci@example.com',
      refs: [],
      signature: 'good',
    });
  });
});
