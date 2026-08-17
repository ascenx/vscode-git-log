import type { GitCommandError } from './GitRunner';

export interface ClassifiedGitError {
  category: 'conflict' | 'authentication' | 'hook' | 'repository' | 'unknown';
  message: string;
  detail: string;
}

export function redactGitDiagnostic(value: string): string {
  return value.replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/@]+)@/giu, '$1***@');
}

export function classifyGitError(error: GitCommandError): ClassifiedGitError {
  const detail = redactGitDiagnostic(error.stderr.toString('utf8').trim() || error.message);
  const lower = detail.toLowerCase();

  if (error.timedOut) {
    return {
      category: 'unknown',
      message: 'Git query timed out. Try a smaller selection or a narrower history request.',
      detail,
    };
  }

  if (/stdout exceeded \d+ bytes/u.test(lower)) {
    return {
      category: 'unknown',
      message: 'Git output exceeded the safety limit. Try a smaller selection or history request.',
      detail,
    };
  }

  if (/\b(?:file .* is binary|binary file)\b/u.test(lower)) {
    return {
      category: 'unknown',
      message: 'Binary files do not support line history.',
      detail,
    };
  }

  if (error.exitCode === null || /unable to start|enoent|not found/u.test(lower)) {
    return {
      category: 'repository',
      message:
        'Git executable is unavailable. Install Git 2.30 or newer, or configure gitLogWorkbench.git.path.',
      detail,
    };
  }

  if (/\bconflict\b|could not apply|automatic merge failed/u.test(lower)) {
    return { category: 'conflict', message: 'Git stopped because of conflicts.', detail };
  }
  if (/authentication failed|permission denied|could not read username|publickey/u.test(lower)) {
    return {
      category: 'authentication',
      message: 'Git authentication failed. Check your credential helper or SSH agent.',
      detail,
    };
  }
  if (/\bhook\b.*(?:declined|failed)|(?:pre|post)-(?:commit|push|merge|rebase)/u.test(lower)) {
    return { category: 'hook', message: 'A Git hook rejected the operation.', detail };
  }
  if (/not a git repository|unknown revision|bad revision|invalid object name/u.test(lower)) {
    return { category: 'repository', message: 'Git could not resolve the repository or revision.', detail };
  }
  return { category: 'unknown', message: detail.split(/\r?\n/u)[0] || error.message, detail };
}
