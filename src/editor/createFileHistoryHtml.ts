import type { HistoryEntry } from '../shared/models';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/gu, (character) => {
    switch (character) {
      case '<':
        return '\\u003c';
      case '>':
        return '\\u003e';
      case '&':
        return '\\u0026';
      case '\u2028':
        return '\\u2028';
      default:
        return '\\u2029';
    }
  });
}

function renderStats(entry: HistoryEntry): string {
  if (entry.binary) return '<span class="history-binary">Binary</span>';
  const additions =
    entry.additions === undefined
      ? ''
      : `<span class="history-additions">+${String(entry.additions)}</span>`;
  const deletions =
    entry.deletions === undefined
      ? ''
      : `<span class="history-deletions">−${String(entry.deletions)}</span>`;
  return additions + deletions;
}

function renderEntry(entry: HistoryEntry, selected: boolean): string {
  const timestamp = entry.commitTime > 0 ? new Date(entry.commitTime * 1000).toLocaleString() : '';
  const rename = entry.oldPath && entry.oldPath !== entry.path
    ? `<div class="history-rename">${escapeHtml(entry.oldPath)} → ${escapeHtml(entry.path)}</div>`
    : '';
  return `<button class="history-commit${selected ? ' selected' : ''}" type="button" data-history-hash="${escapeHtml(entry.hash)}" title="${escapeHtml(entry.subject)}">
    <span class="history-subject">${escapeHtml(entry.subject || '(no subject)')}</span>
    <span class="history-stats">${renderStats(entry)}</span>
    <span class="history-meta">${escapeHtml(entry.authorName)} · ${escapeHtml(timestamp)} · ${escapeHtml(entry.hash.slice(0, 8))}</span>
    ${rename}
  </button>`;
}

export function createFileHistoryHtml(options: {
  nonce: string;
  path: string;
  entries: readonly HistoryEntry[];
  hasMore: boolean;
  changesOnly?: boolean;
  contentOnly?: boolean;
  lineHistoryContextLines?: number;
  emptyMessage?: string;
  notice?: string;
}): string {
  const rows = options.entries.map((entry, index) => renderEntry(entry, index === 0)).join('');
  const initialState = safeJson({ entries: options.entries, hasMore: options.hasMore });
  const emptyMessage = options.emptyMessage ?? 'No commits found for this file.';
  const notice = options.notice ? `<div class="history-notice">${escapeHtml(options.notice)}</div>` : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${options.nonce}'; script-src 'nonce-${options.nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>File History: ${escapeHtml(options.path)}</title>
  <style nonce="${options.nonce}">
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; }
    body { overflow-x: auto; overflow-y: hidden; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
    body.resizing-history { cursor: col-resize; user-select: none; }
    button, select { color: inherit; font: inherit; }
    .file-history-shell { --history-pane-width: 340px; display: grid; grid-template-columns: minmax(220px, var(--history-pane-width)) 5px minmax(0, 1fr); width: 100%; min-width: 505px; height: 100%; min-height: 0; }
    .history-pane { display: grid; grid-template-rows: minmax(0, 1fr) auto; min-width: 0; min-height: 0; background: var(--vscode-sideBar-background, var(--vscode-editor-background)); }
    .history-resizer { position: relative; z-index: 2; width: 5px; min-width: 5px; cursor: col-resize; outline: none; touch-action: none; }
    .history-resizer::after { position: absolute; top: 0; bottom: 0; left: 2px; width: 1px; background: var(--vscode-panel-border); content: ''; }
    .history-resizer:hover::after, .history-resizer:focus-visible::after, body.resizing-history .history-resizer::after { left: 1px; width: 3px; background: var(--vscode-focusBorder); }
    .diff-header { min-height: 54px; padding: 9px 12px; border-bottom: 1px solid var(--vscode-panel-border); }
    .diff-title { overflow: hidden; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
    .diff-subtitle { margin-top: 3px; overflow: hidden; color: var(--vscode-descriptionForeground); font-size: 0.9em; text-overflow: ellipsis; white-space: nowrap; }
    .history-list { min-height: 0; overflow: auto; overscroll-behavior: contain; }
    .history-commit { display: grid; grid-template-columns: minmax(0, 1fr) auto; width: 100%; min-height: 56px; padding: 7px 10px; gap: 3px 8px; border: 0; border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 55%, transparent); background: transparent; text-align: left; cursor: pointer; }
    .history-commit:hover { background: var(--vscode-list-hoverBackground); }
    .history-commit.selected { color: var(--vscode-list-activeSelectionForeground); background: var(--vscode-list-activeSelectionBackground); }
    .history-commit:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    .history-subject { overflow: hidden; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
    .history-stats { display: flex; align-items: center; gap: 6px; font-variant-numeric: tabular-nums; }
    .history-additions { color: var(--vscode-gitDecoration-addedResourceForeground, #2ea043); }
    .history-deletions { color: var(--vscode-gitDecoration-deletedResourceForeground, #f85149); }
    .history-binary, .history-meta, .history-rename { color: var(--vscode-descriptionForeground); font-size: 0.88em; }
    .history-meta, .history-rename { grid-column: 1 / -1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .history-footer { min-height: 34px; padding: 5px 8px; border-top: 1px solid var(--vscode-panel-border); }
    .history-notice { padding: 3px 2px; color: var(--vscode-descriptionForeground); font-size: 0.9em; line-height: 1.35; }
    .load-more { width: 100%; height: 24px; border: 1px solid var(--vscode-button-border, transparent); color: var(--vscode-button-foreground); background: var(--vscode-button-secondaryBackground); cursor: pointer; }
    .load-more:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .load-more[hidden] { display: none; }
    .diff-pane { display: grid; grid-template-rows: auto minmax(0, 1fr); min-width: 0; min-height: 0; }
    .diff-header { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px 14px; align-items: center; }
    .diff-heading { min-width: 0; }
    .diff-actions { display: flex; align-items: center; gap: 4px; }
    .parent-picker { min-width: 180px; max-width: 320px; height: 26px; border: 1px solid var(--vscode-dropdown-border); color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); }
    .parent-picker[hidden] { display: none; }
    .diff-nav-button { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 3px; color: var(--vscode-icon-foreground, currentColor); background: transparent; cursor: pointer; }
    .diff-nav-button:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground); }
    .diff-nav-button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    .diff-nav-button:disabled { opacity: 0.45; cursor: default; }
    .diff-nav-button svg { width: 16px; height: 16px; fill: currentColor; }
    .open-native-diff { width: auto; padding: 0 6px; gap: 4px; }
    .open-native-diff span { white-space: nowrap; }
    .diff-body { min-height: 0; overflow: auto; overscroll-behavior: contain; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); line-height: 1.45; }
    .diff-body:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    .diff-status { padding: 24px; color: var(--vscode-descriptionForeground); font-family: var(--vscode-font-family); text-align: center; }
    .diff-surface { display: grid; width: max-content; min-width: 100%; }
    .diff-row { display: grid; grid-template-columns: 58px 58px minmax(max-content, 1fr); min-height: 21px; white-space: pre; }
    .diff-row.add { background: var(--vscode-diffEditor-insertedLineBackground, rgba(46, 160, 67, 0.18)); }
    .diff-row.delete { background: var(--vscode-diffEditor-removedLineBackground, rgba(248, 81, 73, 0.18)); }
    .diff-row.context { color: var(--vscode-descriptionForeground); }
    .diff-row.context .syntax-token { color: inherit; }
    .diff-row.hunk { color: var(--vscode-editorInfo-foreground); background: var(--vscode-diffEditor-unchangedRegionBackground, rgba(64, 128, 255, 0.09)); }
    .diff-row.meta { color: var(--vscode-descriptionForeground); }
    .diff-line-number { padding: 1px 8px 1px 4px; color: var(--vscode-editorLineNumber-foreground); border-right: 1px solid var(--vscode-panel-border); text-align: right; user-select: none; }
    .diff-code { min-width: 100%; padding: 1px 10px; }
    .syntax-token { color: var(--history-token-dark, inherit); }
    body.vscode-light .syntax-token, body.vscode-high-contrast-light .syntax-token { color: var(--history-token-light, inherit); }
    .empty-history { padding: 24px 12px; color: var(--vscode-descriptionForeground); text-align: center; }
    @media (max-width: 720px) { .history-meta { display: none; } }
  </style>
</head>
<body>
  <main class="file-history-shell">
    <aside class="history-pane">
      <section class="history-list" aria-label="File commits">${rows || `<div class="empty-history">${escapeHtml(emptyMessage)}</div>`}</section>
      <footer class="history-footer">${notice}<button class="load-more" type="button"${options.hasMore ? '' : ' hidden'}>Load more commits</button></footer>
    </aside>
    <div class="history-resizer" role="separator" aria-label="Resize commit list" aria-orientation="vertical" aria-valuemin="220" aria-valuenow="340" tabindex="0" title="Drag to resize commit list"></div>
    <section class="diff-pane" aria-label="Inline file diff">
      <header class="diff-header">
        <div class="diff-heading"><div class="diff-title">Inline Diff</div><div class="diff-subtitle">Select a commit to view this file's changes.</div></div>
        <div class="diff-actions">
          <button class="diff-nav-button open-native-diff" type="button" aria-label="Open in VS Code Diff" title="Open in VS Code Diff"${options.entries.length > 0 ? '' : ' disabled'}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 2h5v1H3v10h10V9h1v5H2V2Zm7 0h5v5h-1V3.7L7.4 9.3l-.7-.7L12.3 3H9V2Z"/></svg><span>VS Code Diff</span>
          </button>
          <select class="parent-picker" aria-label="Compare parent" hidden></select>
          <button class="diff-nav-button diff-previous-change" type="button" aria-label="Previous change" title="Previous change" disabled>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.7 10.7 8 6.4l4.3 4.3 1-1L8 4.4 2.7 9.7l1 1Z"/></svg>
          </button>
          <button class="diff-nav-button diff-next-change" type="button" aria-label="Next change" title="Next change" disabled>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.7 5.3-1 1L8 11.6l5.3-5.3-1-1L8 9.6 3.7 5.3Z"/></svg>
          </button>
        </div>
      </header>
      <div class="diff-body" role="region" aria-label="File diff content" tabindex="0"><div class="diff-status">${options.entries.length > 0 ? 'Loading diff…' : escapeHtml(emptyMessage)}</div></div>
    </section>
  </main>
  <script nonce="${options.nonce}">
    const vscode = acquireVsCodeApi();
    const state = ${initialState};
    const changesOnly = ${options.changesOnly === true ? 'true' : 'false'};
    const contentOnly = ${options.contentOnly === true ? 'true' : 'false'};
    const lineHistoryContextLines = ${Number.isSafeInteger(options.lineHistoryContextLines) && (options.lineHistoryContextLines ?? -1) >= 0
      ? String(options.lineHistoryContextLines)
      : 'undefined'};
    const shell = document.querySelector('.file-history-shell');
    const historyPane = document.querySelector('.history-pane');
    const resizer = document.querySelector('.history-resizer');
    const list = document.querySelector('.history-list');
    const loadMore = document.querySelector('.load-more');
    const diffBody = document.querySelector('.diff-body');
    const diffTitle = document.querySelector('.diff-title');
    const diffSubtitle = document.querySelector('.diff-subtitle');
    const parentPicker = document.querySelector('.parent-picker');
    const openNativeDiff = document.querySelector('.open-native-diff');
    const previousChange = document.querySelector('.diff-previous-change');
    const nextChange = document.querySelector('.diff-next-change');
    let selectedHash = state.entries[0]?.hash;
    let loadingMore = false;
    let changeTargets = [];
    let currentChangeIndex = -1;
    let changeNavigationFrame;
    const changeNavigationDuration = 200;
    let resizePointerId;
    let resizeStartX = 0;
    let resizeStartWidth = 340;
    let historyPaneWidth = 340;

    function clampHistoryWidth(width) {
      const minimumHistoryWidth = 220;
      const minimumDiffWidth = 280;
      const maximumHistoryWidth = shell.clientWidth > 0
        ? Math.max(minimumHistoryWidth, shell.clientWidth - minimumDiffWidth - resizer.offsetWidth)
        : Math.max(minimumHistoryWidth, width);
      return Math.round(Math.min(maximumHistoryWidth, Math.max(minimumHistoryWidth, width)));
    }
    function setHistoryWidth(width, persist) {
      historyPaneWidth = clampHistoryWidth(width);
      shell.style.setProperty('--history-pane-width', historyPaneWidth + 'px');
      resizer.setAttribute('aria-valuenow', String(historyPaneWidth));
      resizer.setAttribute('aria-valuemax', String(Math.max(220, shell.clientWidth - 280 - resizer.offsetWidth)));
      if (persist) {
        vscode.setState({ ...(vscode.getState() || {}), historyPaneWidth });
      }
    }
    function finishResize(pointerId, releaseCapture) {
      if (resizePointerId === undefined || pointerId !== resizePointerId) return;
      resizePointerId = undefined;
      document.body.classList.remove('resizing-history');
      setHistoryWidth(historyPaneWidth, true);
      if (releaseCapture && resizer.hasPointerCapture(pointerId)) resizer.releasePointerCapture(pointerId);
    }

    function entryByHash(hash) { return state.entries.find((entry) => entry.hash === hash); }
    function updateChangeButtons() {
      previousChange.disabled = currentChangeIndex <= 0;
      nextChange.disabled = changeTargets.length === 0 || currentChangeIndex >= changeTargets.length - 1;
    }
    function previousMeaningfulRow(row) {
      let sibling = row.previousElementSibling;
      while (
        sibling?.classList.contains('meta') &&
        sibling.querySelector('.diff-code')?.textContent?.endsWith('No newline at end of file')
      ) {
        sibling = sibling.previousElementSibling;
      }
      return sibling;
    }
    function updateChangeTargets() {
      const changedRows = [...document.querySelectorAll('.diff-row.add, .diff-row.delete')];
      changeTargets = changedRows.filter((row, index) => index === 0 || previousMeaningfulRow(row) !== changedRows[index - 1]);
      currentChangeIndex = -1;
      updateChangeButtons();
    }
    function stopChangeNavigation() {
      if (changeNavigationFrame === undefined) return;
      cancelAnimationFrame(changeNavigationFrame);
      changeNavigationFrame = undefined;
    }
    function scrollToChange(top, animate) {
      const targetTop = Math.max(0, top);
      stopChangeNavigation();
      if (!animate) {
        diffBody.scrollTo({ top: targetTop, behavior: 'auto' });
        return;
      }
      const startTop = diffBody.scrollTop;
      const distance = targetTop - startTop;
      if (Math.abs(distance) < 1) {
        diffBody.scrollTo({ top: targetTop, behavior: 'auto' });
        return;
      }
      let startTime;
      const animateFrame = (timestamp) => {
        startTime ??= timestamp;
        const progress = Math.min(1, Math.max(0, (timestamp - startTime) / changeNavigationDuration));
        const easedProgress = 1 - Math.pow(1 - progress, 3);
        diffBody.scrollTo({ top: startTop + distance * easedProgress, behavior: 'auto' });
        if (progress < 1) changeNavigationFrame = requestAnimationFrame(animateFrame);
        else changeNavigationFrame = undefined;
      };
      changeNavigationFrame = requestAnimationFrame(animateFrame);
    }
    function navigateToChange(index, animate = true) {
      const target = changeTargets[index];
      if (!target) return;
      currentChangeIndex = index;
      const bodyRect = diffBody.getBoundingClientRect();
      const rowRect = target.getBoundingClientRect();
      const top = diffBody.scrollTop + rowRect.top - bodyRect.top - Math.max(0, diffBody.clientHeight / 3);
      scrollToChange(top, animate);
      updateChangeButtons();
    }
    function setStatus(message) {
      stopChangeNavigation();
      diffBody.replaceChildren(Object.assign(document.createElement('div'), { className: 'diff-status', textContent: message }));
      changeTargets = [];
      currentChangeIndex = -1;
      updateChangeButtons();
    }
    function lineCell(value) { const cell = document.createElement('span'); cell.className = 'diff-line-number'; cell.textContent = value === undefined ? '' : String(value); return cell; }
    function validTokenColor(value) { return typeof value === 'string' && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(value); }
    function codeCell(value, tokens) {
      const cell = document.createElement('span');
      cell.className = 'diff-code';
      if (!Array.isArray(tokens)) { cell.textContent = value; return cell; }
      for (const token of tokens) {
        if (!token || typeof token.content !== 'string') continue;
        const span = document.createElement('span');
        span.className = 'syntax-token';
        span.textContent = token.content;
        if (validTokenColor(token.light)) span.style.setProperty('--history-token-light', token.light);
        if (validTokenColor(token.dark)) span.style.setProperty('--history-token-dark', token.dark);
        cell.append(span);
      }
      return cell;
    }
    function containsLine(line, start, count) {
      return Number.isSafeInteger(line) && Number.isSafeInteger(start) && Number.isSafeInteger(count) &&
        count > 0 && line >= start && line < start + count;
    }
    function withinLineContext(line, start, count) {
      return Number.isSafeInteger(lineHistoryContextLines) && Number.isSafeInteger(line) &&
        Number.isSafeInteger(start) && Number.isSafeInteger(count) && count > 0 &&
        line >= start - lineHistoryContextLines && line < start + count + lineHistoryContextLines;
    }
    function pairedContextCode(row) {
      const value = row?.querySelector('.diff-code')?.textContent ?? '';
      return value.startsWith('+') || value.startsWith('-') ? ' ' + value.slice(1) : value;
    }
    function pairLineHistoryContext(fragment, target) {
      if (!target || !contentOnly || !Number.isSafeInteger(lineHistoryContextLines)) return fragment;
      const rows = [...fragment.querySelectorAll('.diff-row')];
      const oldRows = new Map();
      const newRows = new Map();
      for (const row of rows) {
        const oldValue = Number(row.dataset.oldLine);
        const newValue = Number(row.dataset.newLine);
        if (Number.isSafeInteger(oldValue)) oldRows.set(oldValue, row);
        if (Number.isSafeInteger(newValue)) newRows.set(newValue, row);
      }
      const paired = document.createDocumentFragment();
      for (let offset = -lineHistoryContextLines; offset <= lineHistoryContextLines; offset += 1) {
        const oldValue = target.oldLineCount > 0 ? target.oldStartLine + offset : undefined;
        const newValue = target.newLineCount > 0 ? target.newStartLine + offset : undefined;
        const oldRow = oldValue > 0 ? oldRows.get(oldValue) : undefined;
        const newRow = newValue > 0 ? newRows.get(newValue) : undefined;
        if (offset === 0) {
          const targetRows = rows.filter((row) =>
            (row.classList.contains('delete') && row === oldRow) ||
            (row.classList.contains('add') && row === newRow));
          if (targetRows.length) {
            paired.append(...targetRows);
            continue;
          }
        }
        const source = newRow ?? oldRow;
        if (!source) continue;
        const row = document.createElement('div');
        row.className = 'diff-row context';
        row.append(
          lineCell(oldRow ? oldValue : undefined),
          lineCell(newRow ? newValue : undefined),
          codeCell(pairedContextCode(source)),
        );
        paired.append(row);
      }
      return paired;
    }
    function renderPatch(patch, highlightedLines, lineHistoryTarget) {
      if (!patch) { setStatus('This commit changed file metadata without line-level text changes.'); return; }
      const fragment = document.createDocumentFragment();
      let oldLine;
      let newLine;
      let inHunk = false;
      const patchLines = patch.split(/\\r?\\n/);
      for (let lineIndex = 0; lineIndex < patchLines.length; lineIndex += 1) {
        const line = patchLines[lineIndex];
        if (!line && fragment.childNodes.length && patch.endsWith('\\n')) continue;
        const hunk = /^@@ -(\\d+)(?:,(\\d+))? \\+(\\d+)(?:,(\\d+))? @@/.exec(line);
        let kind = 'meta';
        let oldValue;
        let newValue;
        if (hunk) {
          kind = 'hunk';
          inHunk = true;
          oldLine = Number(hunk[1]);
          newLine = Number(hunk[3]);
        } else if (line.startsWith('diff --git ')) {
          inHunk = false;
        } else if (line.startsWith('+') && (inHunk || !line.startsWith('+++'))) {
          kind = 'add';
          newValue = newLine;
          newLine = (newLine ?? 0) + 1;
        } else if (line.startsWith('-') && (inHunk || !line.startsWith('---'))) {
          kind = 'delete';
          oldValue = oldLine;
          oldLine = (oldLine ?? 0) + 1;
        } else if (line.startsWith(' ')) {
          kind = 'context';
          oldValue = oldLine;
          newValue = newLine;
          oldLine = (oldLine ?? 0) + 1;
          newLine = (newLine ?? 0) + 1;
        }
        if (lineHistoryTarget && kind === 'add' && !containsLine(
          newValue,
          lineHistoryTarget.newStartLine,
          lineHistoryTarget.newLineCount,
        )) kind = 'context';
        if (lineHistoryTarget && kind === 'delete' && !containsLine(
          oldValue,
          lineHistoryTarget.oldStartLine,
          lineHistoryTarget.oldLineCount,
        )) kind = 'context';
        if (lineHistoryTarget && kind === 'context' && Number.isSafeInteger(lineHistoryContextLines) &&
          !withinLineContext(oldValue, lineHistoryTarget.oldStartLine, lineHistoryTarget.oldLineCount) &&
          !withinLineContext(newValue, lineHistoryTarget.newStartLine, lineHistoryTarget.newLineCount)) continue;
        if (changesOnly && kind !== 'add' && kind !== 'delete') continue;
        if (contentOnly) {
          const noNewlineMarker = inHunk && kind === 'meta' && line.endsWith('No newline at end of file');
          if (kind !== 'add' && kind !== 'delete' && kind !== 'context' && !noNewlineMarker) continue;
        }
        const row = document.createElement('div');
        row.className = 'diff-row ' + kind;
        if (oldValue !== undefined) row.dataset.oldLine = String(oldValue);
        if (newValue !== undefined) row.dataset.newLine = String(newValue);
        row.append(lineCell(oldValue), lineCell(newValue), codeCell(line, highlightedLines?.[lineIndex]));
        fragment.append(row);
      }
      const surface = document.createElement('div');
      surface.className = 'diff-surface';
      surface.append(pairLineHistoryContext(fragment, lineHistoryTarget));
      diffBody.replaceChildren(surface);
      updateChangeTargets();
      requestAnimationFrame(() => navigateToChange(0, false));
    }
    function configureParentPicker(entry) {
      parentPicker.replaceChildren();
      if (entry?.parents?.length > 1) {
        for (const parent of entry.parents) {
          const option = document.createElement('option');
          option.value = parent;
          option.textContent = 'Parent ' + parent.slice(0, 8);
          parentPicker.append(option);
        }
        parentPicker.hidden = false;
      } else {
        parentPicker.hidden = true;
      }
    }
    function setSelected(hash) {
      selectedHash = hash;
      document.querySelectorAll('.history-commit.selected').forEach((row) => row.classList.remove('selected'));
      document.querySelector('[data-history-hash="' + CSS.escape(hash) + '"]')?.classList.add('selected');
      const entry = entryByHash(hash);
      configureParentPicker(entry);
      vscode.postMessage({ type: 'selectFileHistoryCommit', hash, parent: entry?.parents?.[0] });
    }
    function appendEntry(entry) {
      const button = document.createElement('button');
      button.className = 'history-commit';
      button.type = 'button';
      button.dataset.historyHash = entry.hash;
      button.title = entry.subject;
      const subject = document.createElement('span'); subject.className = 'history-subject'; subject.textContent = entry.subject || '(no subject)';
      const stats = document.createElement('span'); stats.className = 'history-stats';
      if (entry.binary) { const binary = document.createElement('span'); binary.className = 'history-binary'; binary.textContent = 'Binary'; stats.append(binary); }
      else {
        if (entry.additions !== undefined) { const add = document.createElement('span'); add.className = 'history-additions'; add.textContent = '+' + entry.additions; stats.append(add); }
        if (entry.deletions !== undefined) { const del = document.createElement('span'); del.className = 'history-deletions'; del.textContent = '−' + entry.deletions; stats.append(del); }
      }
      const meta = document.createElement('span'); meta.className = 'history-meta'; meta.textContent = entry.authorName + ' · ' + new Date(entry.commitTime * 1000).toLocaleString() + ' · ' + entry.hash.slice(0, 8);
      button.append(subject, stats, meta);
      if (entry.oldPath && entry.oldPath !== entry.path) {
        const rename = document.createElement('span'); rename.className = 'history-rename'; rename.textContent = entry.oldPath + ' → ' + entry.path; button.append(rename);
      }
      list.append(button);
    }
    function requestMore() {
      if (!state.hasMore || loadingMore) return;
      loadingMore = true;
      loadMore.disabled = true;
      loadMore.textContent = 'Loading…';
      vscode.postMessage({ type: 'requestMoreFileHistory' });
    }
    list.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target.closest('[data-history-hash]') : null;
      if (!(target instanceof HTMLButtonElement)) return;
      setSelected(target.dataset.historyHash);
    });
    list.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      const rows = [...document.querySelectorAll('.history-commit')];
      const current = rows.findIndex((row) => row.dataset.historyHash === selectedHash);
      const next = event.key === 'ArrowDown' ? Math.min(rows.length - 1, current + 1) : Math.max(0, current - 1);
      if (rows[next]) { event.preventDefault(); rows[next].focus(); setSelected(rows[next].dataset.historyHash); }
    });
    list.addEventListener('scroll', () => { if (list.scrollTop + list.clientHeight >= list.scrollHeight - 80) requestMore(); });
    loadMore.addEventListener('click', requestMore);
    previousChange.addEventListener('click', () => {
      if (currentChangeIndex > 0) navigateToChange(currentChangeIndex - 1);
    });
    nextChange.addEventListener('click', () => {
      if (currentChangeIndex < changeTargets.length - 1) navigateToChange(currentChangeIndex + 1);
    });
    openNativeDiff.addEventListener('click', () => {
      const entry = selectedHash ? entryByHash(selectedHash) : undefined;
      if (!entry) return;
      vscode.postMessage({
        type: 'openFileHistoryNativeDiff',
        hash: entry.hash,
        parent: parentPicker.hidden ? entry.parents?.[0] : parentPicker.value,
      });
    });
    resizer.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      if (resizePointerId !== undefined) return;
      resizePointerId = event.pointerId;
      resizeStartX = event.clientX;
      resizeStartWidth = historyPane.getBoundingClientRect().width;
      resizer.setPointerCapture(event.pointerId);
      document.body.classList.add('resizing-history');
      event.preventDefault();
    });
    resizer.addEventListener('pointermove', (event) => {
      if (event.pointerId !== resizePointerId) return;
      setHistoryWidth(resizeStartWidth + event.clientX - resizeStartX, false);
    });
    resizer.addEventListener('pointerup', (event) => finishResize(event.pointerId, true));
    resizer.addEventListener('pointercancel', (event) => finishResize(event.pointerId, true));
    resizer.addEventListener('lostpointercapture', (event) => finishResize(event.pointerId, false));
    resizer.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      setHistoryWidth(historyPaneWidth + (event.key === 'ArrowRight' ? 16 : -16), true);
    });
    parentPicker.addEventListener('change', () => { if (selectedHash) vscode.postMessage({ type: 'selectFileHistoryCommit', hash: selectedHash, parent: parentPicker.value }); });
    window.addEventListener('message', (event) => {
      const message = event.data;
      if (!message || typeof message !== 'object') return;
      if (message.type === 'fileHistoryDiffLoading' && message.hash === selectedHash) setStatus('Loading diff…');
      if (message.type === 'fileHistoryDiffLoaded' && message.hash === selectedHash) {
        diffTitle.textContent = message.subject || 'Inline Diff';
        diffSubtitle.textContent = message.subtitle || '';
        if (message.binary) setStatus('Binary files cannot be rendered as an inline text diff.'); else renderPatch(message.patch, message.highlightedLines, message.lineHistoryTarget);
      }
      if (message.type === 'fileHistoryError' && (message.hash === undefined || message.hash === selectedHash)) {
        setStatus(message.message || 'Unable to load file history.');
      }
      if (message.type === 'fileHistoryEntriesAppended') {
        document.querySelector('.empty-history')?.remove();
        for (const entry of message.entries) { state.entries.push(entry); appendEntry(entry); }
        state.hasMore = message.hasMore;
        loadingMore = false;
        loadMore.disabled = false;
        loadMore.textContent = 'Load more commits';
        loadMore.hidden = !state.hasMore;
      }
      if (message.type === 'fileHistoryEntriesLoadFailed') {
        loadingMore = false;
        loadMore.disabled = false;
        loadMore.textContent = 'Retry loading commits';
        loadMore.title = message.message || 'Unable to load more commits.';
      }
    });
    const savedHistoryWidth = vscode.getState()?.historyPaneWidth;
    setHistoryWidth(typeof savedHistoryWidth === 'number' ? savedHistoryWidth : historyPaneWidth, false);
    window.addEventListener('resize', () => setHistoryWidth(historyPaneWidth, false));
    window.addEventListener('blur', () => {
      if (resizePointerId === undefined) return;
      finishResize(resizePointerId, true);
    });
    if (selectedHash) configureParentPicker(entryByHash(selectedHash));
    vscode.postMessage({ type: 'fileHistoryReady' });
  </script>
</body>
</html>`;
}
