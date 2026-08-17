import { describe, expect, it, vi } from 'vitest';

interface WorkerRequest {
  id: number;
  type: 'tokenize';
  code: string;
  path: string;
}

class FakeWorker {
  readonly requests: WorkerRequest[] = [];
  readonly terminate = vi.fn().mockResolvedValue(0);
  private readonly listeners = new Map<string, Array<(...args: never[]) => void>>();

  postMessage(request: WorkerRequest): void {
    this.requests.push(request);
  }

  on(event: string, listener: (...args: never[]) => void): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  emitMessage(message: unknown): void {
    for (const listener of this.listeners.get('message') ?? []) listener(message as never);
  }
}

interface TokenizerContract {
  tokenize(code: string, path: string, signal?: AbortSignal): Promise<unknown>;
  dispose(): void;
}

type TokenizerConstructor = new (options: {
  workerFactory: () => FakeWorker;
  timeoutMs: number;
}) => TokenizerContract;

describe('ShikiHistoryCodeTokenizer', () => {
  it('returns syntax tokens produced by the background worker', async () => {
    const modulePath = '../../src/editor/ShikiHistoryCodeTokenizer';
    const module = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(module, 'ShikiHistoryCodeTokenizer must exist').toBeDefined();
    if (!module) return;
    const worker = new FakeWorker();
    const Tokenizer = module.ShikiHistoryCodeTokenizer as unknown as TokenizerConstructor;
    const tokenizer = new Tokenizer({ workerFactory: () => worker, timeoutMs: 1_000 });

    const pending = tokenizer.tokenize('const value = 1;', 'src/app.ts');
    expect(worker.requests).toEqual([{
      id: 1,
      type: 'tokenize',
      code: 'const value = 1;',
      path: 'src/app.ts',
    }]);
    worker.emitMessage({
      id: 1,
      type: 'tokenized',
      lines: [[{ content: 'const value = 1;', light: '#111111', dark: '#eeeeee' }]],
    });

    await expect(pending).resolves.toEqual([
      [{ content: 'const value = 1;', light: '#111111', dark: '#eeeeee' }],
    ]);
    tokenizer.dispose();
  });

  it('terminates the worker and rejects pending tokenization when aborted', async () => {
    const module = await import('../../src/editor/ShikiHistoryCodeTokenizer');
    const firstWorker = new FakeWorker();
    const secondWorker = new FakeWorker();
    const workers = [firstWorker, secondWorker];
    const workerFactory = vi.fn(() => workers.shift() as FakeWorker);
    const Tokenizer = module.ShikiHistoryCodeTokenizer as unknown as TokenizerConstructor;
    const tokenizer = new Tokenizer({ workerFactory, timeoutMs: 1_000 });
    const abortController = new AbortController();

    const pending = tokenizer.tokenize('slow code', 'src/app.ts', abortController.signal);
    abortController.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(workerFactory).toHaveBeenCalledOnce();
    expect(firstWorker.terminate).toHaveBeenCalledOnce();

    const next = tokenizer.tokenize('next code', 'src/app.ts');
    expect(secondWorker.requests).toHaveLength(1);
    secondWorker.emitMessage({
      id: 2,
      type: 'tokenized',
      lines: [[{ content: 'next code', light: '#111111', dark: '#eeeeee' }]],
    });
    await expect(next).resolves.toEqual([
      [{ content: 'next code', light: '#111111', dark: '#eeeeee' }],
    ]);
    expect(workerFactory).toHaveBeenCalledTimes(2);
  });

  it('terminates a worker that exceeds the tokenization timeout', async () => {
    vi.useFakeTimers();
    try {
      const module = await import('../../src/editor/ShikiHistoryCodeTokenizer');
      const worker = new FakeWorker();
      const Tokenizer = module.ShikiHistoryCodeTokenizer as unknown as TokenizerConstructor;
      const tokenizer = new Tokenizer({ workerFactory: () => worker, timeoutMs: 50 });

      const pending = tokenizer.tokenize('slow code', 'src/app.ts');
      const rejection = expect(pending).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(50);

      await rejection;
      expect(worker.terminate).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a malformed worker response instead of rendering missing text', async () => {
    vi.useFakeTimers();
    try {
      const module = await import('../../src/editor/ShikiHistoryCodeTokenizer');
      const worker = new FakeWorker();
      const Tokenizer = module.ShikiHistoryCodeTokenizer as unknown as TokenizerConstructor;
      const tokenizer = new Tokenizer({ workerFactory: () => worker, timeoutMs: 50 });

      const pending = tokenizer.tokenize('const value = 1;', 'src/app.ts');
      const rejection = expect(pending).rejects.toThrow('invalid response');
      worker.emitMessage({ id: 1, type: 'tokenized', lines: [['bad-token']] });
      await vi.advanceTimersByTimeAsync(50);

      await rejection;
      expect(worker.terminate).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects tokens that cannot reconstruct the requested source text', async () => {
    const module = await import('../../src/editor/ShikiHistoryCodeTokenizer');
    const worker = new FakeWorker();
    const Tokenizer = module.ShikiHistoryCodeTokenizer as unknown as TokenizerConstructor;
    const tokenizer = new Tokenizer({ workerFactory: () => worker, timeoutMs: 1_000 });

    const pending = tokenizer.tokenize('const value = 1;', 'src/app.ts');
    worker.emitMessage({
      id: 1,
      type: 'tokenized',
      lines: [[{ content: 'different source', light: '#111111', dark: '#eeeeee' }]],
    });

    await expect(pending).rejects.toThrow('does not match the requested source');
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('terminates the worker after a failed tokenization response', async () => {
    const module = await import('../../src/editor/ShikiHistoryCodeTokenizer');
    const worker = new FakeWorker();
    const Tokenizer = module.ShikiHistoryCodeTokenizer as unknown as TokenizerConstructor;
    const tokenizer = new Tokenizer({ workerFactory: () => worker, timeoutMs: 1_000 });

    const pending = tokenizer.tokenize('const value = 1;', 'src/app.ts');
    worker.emitMessage({
      id: 1,
      type: 'failed',
      message: 'History highlighting produced too many syntax tokens.',
    });

    await expect(pending).rejects.toThrow('too many syntax tokens');
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
