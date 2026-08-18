import { spawn } from 'node:child_process';
import { redactGitDiagnostic } from './classifyGitError';

export interface GitRunOptions {
  cwd: string;
  input?: string | Buffer;
  signal?: AbortSignal;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

export interface GitRunResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
  durationMs: number;
}

export interface GitRunnerOptions {
  executable?: string;
  logLevel?: 'off' | 'error' | 'debug';
  onDiagnostic?(line: string): void;
}

export class GitCommandError extends Error {
  override readonly name = 'GitCommandError';

  constructor(
    message: string,
    readonly args: readonly string[],
    readonly cwd: string,
    readonly exitCode: number | null,
    readonly stdout: Buffer,
    readonly stderr: Buffer,
    readonly cancelled: boolean,
    readonly timedOut: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class GitRunner {
  private static readonly DEFAULT_MAX_STDERR_BYTES = 4 * 1024 * 1024;
  private readonly executable: string;
  private readonly logLevel: 'off' | 'error' | 'debug';
  private readonly onDiagnostic: ((line: string) => void) | undefined;

  constructor(options: GitRunnerOptions = {}) {
    this.executable = options.executable ?? 'git';
    this.logLevel = options.logLevel ?? 'off';
    this.onDiagnostic = options.onDiagnostic;
  }

  run(args: readonly string[], options: GitRunOptions): Promise<GitRunResult> {
    return new Promise((resolve, reject) => {
      const startedAt = performance.now();
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let cancelled = options.signal?.aborted ?? false;
      let timedOut = false;
      let settled = false;
      let stdoutBytes = 0;
      let stdoutLimitExceeded = false;
      let stderrBytes = 0;
      let stderrLimitExceeded = false;
      const command = args[0] ?? 'unknown';
      if (this.logLevel === 'debug') this.onDiagnostic?.(`[git] start command=${command}`);

      const child = spawn(this.executable, [...args], {
        cwd: options.cwd,
        shell: false,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_PAGER: 'cat',
          PAGER: 'cat',
          ...options.env,
        },
        stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });

      if (options.input !== undefined) child.stdin?.end(options.input);

      const stop = (): void => {
        if (!child.killed) child.kill();
      };

      const abortListener = (): void => {
        cancelled = true;
        stop();
      };

      options.signal?.addEventListener('abort', abortListener, { once: true });
      if (cancelled) stop();

      const timeout = options.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            stop();
          }, options.timeoutMs)
        : undefined;

      child.stdout?.on('data', (chunk: Buffer | string) => {
        if (stdoutLimitExceeded) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const maximumBytes = options.maxStdoutBytes;
        if (maximumBytes !== undefined && stdoutBytes + buffer.length > maximumBytes) {
          const remaining = Math.max(0, maximumBytes - stdoutBytes);
          if (remaining > 0) stdout.push(buffer.subarray(0, remaining));
          stdoutBytes += remaining;
          stdoutLimitExceeded = true;
          stop();
          return;
        }
        stdout.push(buffer);
        stdoutBytes += buffer.length;
      });
      child.stderr?.on('data', (chunk: Buffer | string) => {
        if (stderrLimitExceeded) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const maximumBytes = options.maxStderrBytes ?? GitRunner.DEFAULT_MAX_STDERR_BYTES;
        if (stderrBytes + buffer.length > maximumBytes) {
          const remaining = Math.max(0, maximumBytes - stderrBytes);
          if (remaining > 0) stderr.push(buffer.subarray(0, remaining));
          stderrBytes += remaining;
          stderrLimitExceeded = true;
          stop();
          return;
        }
        stderr.push(buffer);
        stderrBytes += buffer.length;
      });

      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        options.signal?.removeEventListener('abort', abortListener);
        const safeMessage = redactGitDiagnostic(error.message)
          .split(options.cwd)
          .join('<repository>')
          .split(this.executable)
          .join('<git>');
        this.onDiagnostic?.(`[git] command=${command} start-failed=${safeMessage}`);
        reject(
          new GitCommandError(
            `Unable to start ${this.executable}: ${error.message}`,
            args,
            options.cwd,
            null,
            Buffer.concat(stdout),
            Buffer.concat(stderr),
            cancelled,
            timedOut,
            { cause: error },
          ),
        );
      });

      child.once('close', (code) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        options.signal?.removeEventListener('abort', abortListener);

        const stdoutBuffer = Buffer.concat(stdout);
        const stderrBuffer = Buffer.concat(stderr);
        const durationMs = performance.now() - startedAt;
        const stderrText = redactGitDiagnostic(stderrBuffer.toString('utf8').trim())
          .split(options.cwd)
          .join('<repository>');
        if (
          this.logLevel === 'debug' ||
          code !== 0 ||
          cancelled ||
          timedOut ||
          stdoutLimitExceeded ||
          stderrLimitExceeded
        ) {
          this.onDiagnostic?.(
            `[git] command=${command} exit=${String(code)} duration=${durationMs.toFixed(1)}ms${stderrLimitExceeded ? ` stderr-limit=${String(options.maxStderrBytes ?? GitRunner.DEFAULT_MAX_STDERR_BYTES)}` : ''}${stderrText ? ` stderr=${stderrText.slice(0, 2000)}` : ''}`,
          );
        }

        if (stdoutLimitExceeded) {
          reject(
            new GitCommandError(
              `Git stdout exceeded ${String(options.maxStdoutBytes)} bytes.`,
              args,
              options.cwd,
              code,
              stdoutBuffer,
              stderrBuffer,
              cancelled,
              timedOut,
            ),
          );
          return;
        }

        if (stderrLimitExceeded) {
          reject(
            new GitCommandError(
              `Git stderr exceeded ${String(options.maxStderrBytes ?? GitRunner.DEFAULT_MAX_STDERR_BYTES)} bytes.`,
              args,
              options.cwd,
              code,
              stdoutBuffer,
              stderrBuffer,
              cancelled,
              timedOut,
            ),
          );
          return;
        }

        if (code === 0 && !cancelled && !timedOut) {
          resolve({ stdout: stdoutBuffer, stderr: stderrBuffer, exitCode: code, durationMs });
          return;
        }

        const reason = cancelled
          ? 'Git command was cancelled.'
          : timedOut
            ? 'Git command timed out.'
            : `Git command exited with code ${String(code)}.`;
        reject(
          new GitCommandError(
            reason,
            args,
            options.cwd,
            code,
            stdoutBuffer,
            stderrBuffer,
            cancelled,
            timedOut,
          ),
        );
      });
    });
  }
}
