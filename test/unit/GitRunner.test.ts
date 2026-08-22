import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('GitRunner', () => {
  it('executes Git with an argument array and returns binary-safe output', async () => {
    const modulePath = '../../src/git/GitRunner';
    const runnerModule = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(runnerModule, 'GitRunner must exist').toBeDefined();
    if (!runnerModule) return;

    const cwd = await mkdtemp(join(tmpdir(), 'git-log-workbench-runner-'));
    temporaryDirectories.push(cwd);
    const runner = new runnerModule.GitRunner({ executable: 'git' });

    const result = await runner.run(['--version'], { cwd });

    expect(result.exitCode).toBe(0);
    expect(Buffer.isBuffer(result.stdout)).toBe(true);
    expect(result.stdout.toString('utf8')).toMatch(/^git version \d+/u);
    expect(result.stderr.length).toBe(0);
  });

  it('rejects with structured diagnostics when Git exits unsuccessfully', async () => {
    const modulePath = '../../src/git/GitRunner';
    const runnerModule = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(runnerModule, 'GitRunner must exist').toBeDefined();
    if (!runnerModule) return;

    const cwd = await mkdtemp(join(tmpdir(), 'git-log-workbench-runner-'));
    temporaryDirectories.push(cwd);
    const runner = new runnerModule.GitRunner({ executable: 'git' });

    await expect(runner.run(['rev-parse', '--verify', 'missing-ref'], { cwd })).rejects.toMatchObject({
      name: 'GitCommandError',
      args: ['rev-parse', '--verify', 'missing-ref'],
      cwd,
      exitCode: 128,
      cancelled: false,
    });
  });

  it('handles stdin EPIPE when the child exits before consuming a large input', async () => {
    const { GitRunner } = await import('../../src/git/GitRunner');
    const cwd = await mkdtemp(join(tmpdir(), 'git-log-workbench-runner-'));
    temporaryDirectories.push(cwd);
    const runner = new GitRunner({ executable: process.execPath });

    await expect(
      runner.run(['-e', 'process.exit(7)'], {
        cwd,
        input: 'x'.repeat(128 * 1024),
      }),
    ).rejects.toMatchObject({
      name: 'GitCommandError',
      exitCode: 7,
      cancelled: false,
    });
  });

  it('cancels an in-flight process using AbortSignal', async () => {
    const modulePath = '../../src/git/GitRunner';
    const runnerModule = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(runnerModule, 'GitRunner must exist').toBeDefined();
    if (!runnerModule) return;

    const cwd = await mkdtemp(join(tmpdir(), 'git-log-workbench-runner-'));
    temporaryDirectories.push(cwd);
    const runner = new runnerModule.GitRunner({ executable: process.execPath });
    const abortController = new AbortController();
    const operation = runner.run(['-e', 'setTimeout(() => {}, 10_000)'], {
      cwd,
      signal: abortController.signal,
    });

    abortController.abort();

    await expect(operation).rejects.toMatchObject({
      name: 'GitCommandError',
      cancelled: true,
    });
  });

  it('emits redacted command diagnostics without exposing URL credentials', async () => {
    const { GitRunner } = await import('../../src/git/GitRunner');
    const cwd = await mkdtemp(join(tmpdir(), 'git-log-workbench-runner-'));
    temporaryDirectories.push(cwd);
    const diagnostics: string[] = [];
    const runner = new GitRunner({
      executable: 'git',
      logLevel: 'debug',
      onDiagnostic: (line) => diagnostics.push(line),
    });

    await expect(
      runner.run(['ls-remote', 'https://alice:secret@127.0.0.1:1/repository.git'], {
        cwd,
        timeoutMs: 2_000,
      }),
    ).rejects.toBeDefined();

    expect(diagnostics.join('\n')).toContain('ls-remote');
    expect(diagnostics.join('\n')).toContain('exit');
    expect(diagnostics.join('\n')).not.toContain('secret');
  });

  it('stops buffering stdout after the configured byte ceiling', async () => {
    const { GitRunner } = await import('../../src/git/GitRunner');
    const cwd = await mkdtemp(join(tmpdir(), 'git-log-workbench-runner-'));
    temporaryDirectories.push(cwd);
    const runner = new GitRunner({ executable: process.execPath });

    await expect(
      runner.run(['-e', 'process.stdout.write("x".repeat(1024 * 1024))'], {
        cwd,
        maxStdoutBytes: 1024,
      }),
    ).rejects.toThrow('stdout exceeded 1024 bytes');
  });

  it('applies a bounded stdout ceiling when a call does not provide one', async () => {
    const { GitRunner } = await import('../../src/git/GitRunner');
    const cwd = await mkdtemp(join(tmpdir(), 'git-log-workbench-runner-'));
    temporaryDirectories.push(cwd);
    const runner = new GitRunner({
      executable: process.execPath,
      defaultMaxStdoutBytes: 1024,
    } as never);

    await expect(
      runner.run(['-e', 'process.stdout.write("x".repeat(4096))'], { cwd }),
    ).rejects.toThrow('stdout exceeded 1024 bytes');
  });

  it('force-kills a process that ignores the timeout termination signal', async () => {
    const { GitRunner } = await import('../../src/git/GitRunner');
    const cwd = await mkdtemp(join(tmpdir(), 'git-log-workbench-runner-'));
    temporaryDirectories.push(cwd);
    const runner = new GitRunner({
      executable: process.execPath,
      killGraceMs: 50,
    } as never);
    const startedAt = performance.now();

    await expect(
      runner.run(
        [
          '-e',
          'process.on("SIGTERM", () => {}); setInterval(() => {}, 100); setTimeout(() => process.exit(9), 1000)',
        ],
        { cwd, timeoutMs: 150 },
      ),
    ).rejects.toMatchObject({ timedOut: true });

    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  it.skipIf(process.platform === 'win32')(
    'force-kills surviving process-group descendants after the leader exits',
    async () => {
      const { GitRunner } = await import('../../src/git/GitRunner');
      const cwd = await mkdtemp(join(tmpdir(), 'git-log-workbench-runner-'));
      temporaryDirectories.push(cwd);
      const runner = new GitRunner({
        executable: process.execPath,
        killGraceMs: 50,
      } as never);
      const descendantScript =
        'process.on("SIGTERM", () => {}); setTimeout(() => process.exit(0), 700)';
      const leaderScript = [
        'const { spawn } = require("node:child_process")',
        `spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], { stdio: ["ignore", "inherit", "inherit"] })`,
        'process.on("SIGTERM", () => process.exit(0))',
        'setInterval(() => {}, 100)',
      ].join(';');
      const startedAt = performance.now();

      await expect(
        runner.run(['-e', leaderScript], { cwd, timeoutMs: 150 }),
      ).rejects.toMatchObject({ timedOut: true });

      expect(performance.now() - startedAt).toBeLessThan(500);
    },
  );

  it('stops buffering stderr after the configured byte ceiling', async () => {
    const { GitRunner } = await import('../../src/git/GitRunner');
    const cwd = await mkdtemp(join(tmpdir(), 'git-log-workbench-runner-'));
    temporaryDirectories.push(cwd);
    const diagnostics: string[] = [];
    const runner = new GitRunner({
      executable: process.execPath,
      onDiagnostic: (line) => diagnostics.push(line),
    });

    const operation = runner.run(['-e', 'process.stderr.write("secret=" + "x".repeat(1024 * 1024))'], {
      cwd,
      maxStderrBytes: 1024,
    });

    await expect(operation).rejects.toMatchObject({
      name: 'GitCommandError',
      stderr: expect.objectContaining({ length: 1024 }),
    });
    await expect(operation).rejects.toThrow('stderr exceeded 1024 bytes');
    expect(diagnostics.join('\n')).toContain('stderr-limit=1024');
  });

  it('honors log level and does not log cwd or raw command arguments', async () => {
    const { GitRunner } = await import('../../src/git/GitRunner');
    const cwd = await mkdtemp(join(tmpdir(), 'git-log-workbench-private-path-'));
    temporaryDirectories.push(cwd);
    const offDiagnostics: string[] = [];
    const debugDiagnostics: string[] = [];
    await new GitRunner({
      executable: 'git',
      logLevel: 'off',
      onDiagnostic: (line) => offDiagnostics.push(line),
    }).run(['--version'], { cwd });
    await new GitRunner({
      executable: 'git',
      logLevel: 'debug',
      onDiagnostic: (line) => debugDiagnostics.push(line),
    }).run(['--version', 'private-search-term'], { cwd }).catch(() => undefined);

    expect(offDiagnostics).toEqual([]);
    expect(debugDiagnostics.join('\n')).toContain('command=--version');
    expect(debugDiagnostics.join('\n')).not.toContain(cwd);
    expect(debugDiagnostics.join('\n')).not.toContain('private-search-term');
  });

  it('always emits a redacted failure diagnostic even when log level is off', async () => {
    const { GitRunner } = await import('../../src/git/GitRunner');
    const cwd = await mkdtemp(join(tmpdir(), 'git-log-workbench-private-failure-'));
    temporaryDirectories.push(cwd);
    const diagnostics: string[] = [];
    const runner = new GitRunner({
      executable: process.execPath,
      logLevel: 'off',
      onDiagnostic: (line) => diagnostics.push(line),
    });

    await expect(
      runner.run(
        [
          '-e',
          `process.stderr.write(${JSON.stringify(`fatal in ${cwd}: https://alice:secret@example.com/repository.git`)}); process.exit(7)`,
        ],
        { cwd },
      ),
    ).rejects.toMatchObject({ exitCode: 7 });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain('exit=7');
    expect(diagnostics[0]).toContain('<repository>');
    expect(diagnostics[0]).not.toContain(cwd);
    expect(diagnostics[0]).not.toContain('secret');
  });
});
