import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { HistorySyntaxToken } from './HistoryDiffSupport';
import type { HistoryCodeTokenizer } from './HistoryPatchSyntaxHighlighter';
import {
  isHistorySyntaxWorkerResponse,
  type HistorySyntaxTokenizeRequest,
} from './HistorySyntaxWorkerProtocol';

const DEFAULT_TIMEOUT_MS = 3_000;

interface HistorySyntaxWorkerLike {
  postMessage(message: HistorySyntaxTokenizeRequest): void;
  on(event: 'message', listener: (value: unknown) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  terminate(): Promise<number>;
}

interface PendingTokenization {
  resolve: (lines: readonly (readonly HistorySyntaxToken[])[]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  sourceLines: readonly string[];
  signal?: AbortSignal;
  abortListener?: () => void;
}

export interface ShikiHistoryCodeTokenizerOptions {
  workerScriptPath?: string;
  workerFactory?: () => HistorySyntaxWorkerLike;
  timeoutMs?: number;
}

function abortError(): DOMException {
  return new DOMException('History syntax highlighting was cancelled.', 'AbortError');
}

function tokensMatchSource(
  lines: readonly (readonly HistorySyntaxToken[])[],
  sourceLines: readonly string[],
): boolean {
  if (lines.length !== sourceLines.length) return false;
  return lines.every(
    (tokens, index) => tokens.map((token) => token.content).join('') === sourceLines[index],
  );
}

export class ShikiHistoryCodeTokenizer implements HistoryCodeTokenizer {
  private readonly workerFactory: () => HistorySyntaxWorkerLike;
  private readonly timeoutMs: number;
  private readonly pending = new Map<number, PendingTokenization>();
  private worker: HistorySyntaxWorkerLike | undefined;
  private nextRequestId = 0;
  private disposed = false;

  constructor(options: ShikiHistoryCodeTokenizerOptions = {}) {
    const workerScriptPath = options.workerScriptPath ?? join(__dirname, 'history-syntax-worker.js');
    this.workerFactory = options.workerFactory ?? (() => new Worker(workerScriptPath));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new Error('History syntax worker timeout must be a positive integer.');
    }
  }

  tokenize(
    code: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<readonly (readonly HistorySyntaxToken[])[]> {
    signal?.throwIfAborted();
    if (this.disposed) return Promise.reject(new Error('History syntax tokenizer is disposed.'));
    const worker = this.ensureWorker();
    const id = ++this.nextRequestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failWorker(new Error(`History syntax highlighting timed out after ${String(this.timeoutMs)} ms.`));
      }, this.timeoutMs);
      const pending: PendingTokenization = {
        resolve,
        reject,
        timer,
        sourceLines: code.split('\n'),
        ...(signal ? { signal } : {}),
      };
      if (signal) {
        pending.abortListener = () => this.failWorker(abortError());
        signal.addEventListener('abort', pending.abortListener, { once: true });
      }
      this.pending.set(id, pending);
      if (signal?.aborted) {
        this.failWorker(abortError());
        return;
      }
      try {
        worker.postMessage({ id, type: 'tokenize', code, path });
      } catch (error) {
        this.failWorker(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.failWorker(new Error('History syntax tokenizer was disposed.'));
  }

  private ensureWorker(): HistorySyntaxWorkerLike {
    if (this.worker) return this.worker;
    const worker = this.workerFactory();
    this.worker = worker;
    worker.on('message', (value) => {
      if (this.worker !== worker) return;
      if (!isHistorySyntaxWorkerResponse(value)) {
        this.failWorker(new Error('History syntax worker returned an invalid response.'));
        return;
      }
      const current = this.pending.get(value.id);
      if (!current) return;
      if (value.type === 'failed') {
        this.failWorker(new Error(value.message));
        return;
      }
      if (!tokensMatchSource(value.lines, current.sourceLines)) {
        this.failWorker(new Error('History syntax worker response does not match the requested source.'));
        return;
      }
      const pending = this.takePending(value.id);
      if (!pending) return;
      pending.resolve(value.lines);
    });
    worker.on('error', (error) => {
      if (this.worker === worker) this.failWorker(error);
    });
    worker.on('exit', (code) => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      if (code !== 0 || this.pending.size > 0) {
        this.rejectPending(new Error(`History syntax worker exited with code ${String(code)}.`));
      }
    });
    return worker;
  }

  private takePending(id: number): PendingTokenization | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener('abort', pending.abortListener);
    }
    return pending;
  }

  private failWorker(error: Error): void {
    const worker = this.worker;
    this.worker = undefined;
    if (worker) void worker.terminate().catch(() => undefined);
    this.rejectPending(error);
  }

  private rejectPending(error: Error): void {
    for (const id of [...this.pending.keys()]) {
      this.takePending(id)?.reject(error);
    }
  }
}
