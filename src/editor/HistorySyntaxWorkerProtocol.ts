import type { HistorySyntaxToken } from './HistoryDiffSupport';

const MAX_HISTORY_SYNTAX_TOKENS = 25_000;
const MAX_HISTORY_SYNTAX_LINES = 10_000;
const TOKEN_COLOR_PATTERN = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu;

export interface HistorySyntaxTokenizeRequest {
  id: number;
  type: 'tokenize';
  code: string;
  path: string;
}

export interface HistorySyntaxTokenizedResponse {
  id: number;
  type: 'tokenized';
  lines: readonly (readonly HistorySyntaxToken[])[];
}

export interface HistorySyntaxFailedResponse {
  id: number;
  type: 'failed';
  message: string;
}

export type HistorySyntaxWorkerResponse =
  | HistorySyntaxTokenizedResponse
  | HistorySyntaxFailedResponse;

export function enforceHistorySyntaxTokenBudget(
  lines: readonly (readonly HistorySyntaxToken[])[],
): void {
  let tokenCount = 0;
  for (const line of lines) {
    tokenCount += line.length;
    if (tokenCount > MAX_HISTORY_SYNTAX_TOKENS) {
      throw new Error('History highlighting produced too many syntax tokens.');
    }
  }
}

export function isHistorySyntaxTokenizeRequest(
  value: unknown,
): value is HistorySyntaxTokenizeRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Record<string, unknown>;
  return (
    request.type === 'tokenize' &&
    Number.isSafeInteger(request.id) &&
    (request.id as number) > 0 &&
    typeof request.code === 'string' &&
    typeof request.path === 'string'
  );
}

export function isHistorySyntaxWorkerResponse(
  value: unknown,
): value is HistorySyntaxWorkerResponse {
  if (!value || typeof value !== 'object') return false;
  const response = value as Record<string, unknown>;
  if (!Number.isSafeInteger(response.id) || (response.id as number) <= 0) return false;
  if (response.type === 'failed') return typeof response.message === 'string';
  if (response.type !== 'tokenized' || !Array.isArray(response.lines)) return false;
  if (response.lines.length > MAX_HISTORY_SYNTAX_LINES) return false;
  let tokenCount = 0;
  for (const line of response.lines) {
    if (!Array.isArray(line)) return false;
    tokenCount += line.length;
    if (tokenCount > MAX_HISTORY_SYNTAX_TOKENS) return false;
    for (const value of line) {
      if (!value || typeof value !== 'object') return false;
      const token = value as Record<string, unknown>;
      if (
        typeof token.content !== 'string' ||
        typeof token.light !== 'string' ||
        !TOKEN_COLOR_PATTERN.test(token.light) ||
        typeof token.dark !== 'string' ||
        !TOKEN_COLOR_PATTERN.test(token.dark)
      ) {
        return false;
      }
    }
  }
  return true;
}
