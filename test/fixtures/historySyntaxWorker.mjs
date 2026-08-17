import { parentPort } from 'node:worker_threads';

parentPort.on('message', (request) => {
  const deadline = Date.now() + 250;
  while (Date.now() < deadline) {
    // Simulate synchronous tokenizer work inside the worker thread.
  }
  parentPort.postMessage({
    id: request.id,
    type: 'tokenized',
    lines: [[{ content: request.code, light: '#111111', dark: '#eeeeee' }]],
  });
});
