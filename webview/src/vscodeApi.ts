import type { WebviewToExtensionMessage } from '../../src/protocol/messages';

export interface VsCodeApi {
  postMessage(message: WebviewToExtensionMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
  }
}

const fallbackApi: VsCodeApi = {
  postMessage() {},
  getState() {
    return undefined;
  },
  setState() {},
};

let api: VsCodeApi | undefined;

export function getVsCodeApi(): VsCodeApi {
  api ??= window.acquireVsCodeApi?.() ?? fallbackApi;
  return api;
}
