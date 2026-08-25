import type { ChangedFile } from '../shared/models';

interface ComparisonFile {
  file: ChangedFile;
  index: number;
  name: string;
}

interface ComparisonDirectory {
  directories: Map<string, ComparisonDirectory>;
  files: ComparisonFile[];
}

type FileIconKind =
  | 'archive'
  | 'binary'
  | 'c'
  | 'config'
  | 'cpp'
  | 'csharp'
  | 'css'
  | 'dart'
  | 'document'
  | 'file'
  | 'go'
  | 'html'
  | 'image'
  | 'java'
  | 'javascript'
  | 'json'
  | 'kotlin'
  | 'markdown'
  | 'php'
  | 'python'
  | 'react'
  | 'ruby'
  | 'rust'
  | 'shell'
  | 'sql'
  | 'swift'
  | 'typescript'
  | 'xml'
  | 'yaml';

const iconLabels: Readonly<Record<FileIconKind, string>> = {
  archive: 'ZIP',
  binary: '01',
  c: 'C',
  config: '⚙',
  cpp: 'C+',
  csharp: 'C#',
  css: '#',
  dart: 'D',
  document: 'TXT',
  file: '',
  go: 'GO',
  html: '<>',
  image: '▧',
  java: 'J',
  javascript: 'JS',
  json: '{}',
  kotlin: 'K',
  markdown: 'M',
  php: 'P',
  python: 'PY',
  react: '⚛',
  ruby: 'RB',
  rust: 'RS',
  shell: '$_',
  sql: 'DB',
  swift: 'S',
  typescript: 'TS',
  xml: '<>',
  yaml: 'Y',
};

const extensionIconKinds: Readonly<Record<string, FileIconKind>> = {
  '7z': 'archive',
  aac: 'binary',
  avi: 'binary',
  bmp: 'image',
  bz2: 'archive',
  c: 'c',
  cc: 'cpp',
  cfg: 'config',
  conf: 'config',
  cpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  csv: 'document',
  cxx: 'cpp',
  dart: 'dart',
  doc: 'document',
  docx: 'document',
  env: 'config',
  flac: 'binary',
  gif: 'image',
  go: 'go',
  gradle: 'config',
  gz: 'archive',
  h: 'c',
  hpp: 'cpp',
  htm: 'html',
  html: 'html',
  ico: 'image',
  ini: 'config',
  java: 'java',
  jpeg: 'image',
  jpg: 'image',
  js: 'javascript',
  json: 'json',
  jsonc: 'json',
  jsx: 'react',
  kt: 'kotlin',
  kts: 'kotlin',
  lock: 'config',
  m: 'c',
  md: 'markdown',
  mdx: 'markdown',
  mk: 'config',
  mov: 'binary',
  mp3: 'binary',
  mp4: 'binary',
  pdf: 'document',
  php: 'php',
  plist: 'config',
  png: 'image',
  properties: 'config',
  ps1: 'shell',
  py: 'python',
  rar: 'archive',
  rb: 'ruby',
  rs: 'rust',
  sass: 'css',
  scss: 'css',
  sh: 'shell',
  sql: 'sql',
  svg: 'image',
  swift: 'swift',
  tar: 'archive',
  toml: 'config',
  ts: 'typescript',
  tsx: 'react',
  txt: 'document',
  wav: 'binary',
  webp: 'image',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zip: 'archive',
  zsh: 'shell',
};

const specialIconBodies: Readonly<Partial<Record<FileIconKind, string>>> = {
  archive: `<path fill="currentColor" d="M3 1.5h7l3 3v10H3z"/><path fill="#fff" fill-opacity=".9" d="M7.1 2h1.8v1.6H7.1zm0 2.2h1.8v1.6H7.1zm0 2.2h1.8V8H7.1zm-.4 2.2h2.6v3.8H6.7z"/>`,
  binary: `<path fill="currentColor" fill-opacity=".2" stroke="currentColor" stroke-linejoin="round" d="M3 1.5h6.5L13 5v9.5H3z"/><path fill="none" stroke="currentColor" stroke-linecap="round" d="M9.5 1.5V5H13"/><circle cx="6" cy="8" r="1" fill="currentColor"/><path stroke="currentColor" stroke-width="1.3" d="M9.5 7v2m-4 2v2m4-2v2"/>`,
  config: `<path fill="currentColor" d="M7 1h2l.5 1.7 1.4.6 1.6-.8 1.4 1.4-.8 1.6.6 1.4 1.7.6v2l-1.7.5-.6 1.4.8 1.6-1.4 1.4-1.6-.8-1.4.6L9 15H7l-.5-1.7-1.4-.6-1.6.8-1.4-1.4.8-1.6-.6-1.4-1.7-.6v-2l1.7-.6.6-1.4-.8-1.6 1.4-1.4 1.6.8 1.4-.6z"/><circle cx="8" cy="8" r="2.3" fill="var(--vscode-editor-background)"/>`,
  dart: `<path fill="currentColor" d="M2 3.3 5.2 1h5.1L15 5.7v4.8L11.5 15H6.3L2 10.7z"/><path fill="#fff" fill-opacity=".82" d="m5.2 3.2 4.2.1 3.2 3H7.3z"/><path fill="#075b80" fill-opacity=".65" d="M7.3 6.3h5.3l-2.1 3.2H6z"/><path fill="#fff" fill-opacity=".68" d="m6 9.5 4.5.1-1.3 2.1H7.8z"/>`,
  document: `<path fill="currentColor" d="M3 1.5h6.5L13 5v9.5H3z"/><path fill="#fff" fill-opacity=".88" d="M9.5 1.5V5H13zM5 7h6v1H5zm0 2.2h6v1H5zm0 2.2h4.5v1H5z"/>`,
  file: `<path fill="currentColor" fill-opacity=".18" stroke="currentColor" stroke-linejoin="round" d="M3 1.5h6.5L13 5v9.5H3z"/><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="M9.5 1.5V5H13"/>`,
  image: `<rect x="1.5" y="2" width="13" height="12" rx="1.5" fill="currentColor"/><circle cx="5" cy="5.5" r="1.4" fill="#fff" fill-opacity=".9"/><path fill="#fff" fill-opacity=".88" d="m3 12 3.4-3.5 2.1 2 1.8-2.2L13 12z"/>`,
  json: `<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.8" d="M6.2 2.2H5c-1 0-1.5.6-1.5 1.6v2.1c0 1-.5 1.7-1.5 2.1 1 .4 1.5 1.1 1.5 2.1v2.1c0 1 .5 1.6 1.5 1.6h1.2m3.6-11.6H11c1 0 1.5.6 1.5 1.6v2.1c0 1 .5 1.7 1.5 2.1-1 .4-1.5 1.1-1.5 2.1v2.1c0 1-.5 1.6-1.5 1.6H9.8"/>`,
  markdown: `<rect x="1" y="2.5" width="14" height="11" rx="1.5" fill="currentColor"/><path fill="#fff" d="M3 10.8V5.2h1.4L6 7.3l1.6-2.1H9v5.6H7.6V7.3L6 9.2 4.4 7.3v3.5zm8-5.6h1.4v3h1.4L11.7 11 9.6 8.2H11z"/>`,
  react: `<g fill="none" stroke="currentColor" stroke-width="1"><ellipse cx="8" cy="8" rx="6.8" ry="2.5"/><ellipse cx="8" cy="8" rx="6.8" ry="2.5" transform="rotate(60 8 8)"/><ellipse cx="8" cy="8" rx="6.8" ry="2.5" transform="rotate(120 8 8)"/></g><circle cx="8" cy="8" r="1.5" fill="currentColor"/>`,
};

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function createDirectory(): ComparisonDirectory {
  return { directories: new Map(), files: [] };
}

function fileIconKind(name: string, binary: boolean): FileIconKind {
  const lowerName = name.toLowerCase();
  if (lowerName === 'dockerfile' || lowerName === 'makefile' || lowerName === 'podfile') {
    return 'config';
  }
  if (lowerName === '.gitignore' || lowerName === '.gitattributes' || lowerName === '.editorconfig') {
    return 'config';
  }
  const extension = lowerName.includes('.') ? lowerName.slice(lowerName.lastIndexOf('.') + 1) : '';
  return extensionIconKinds[extension] ?? (binary ? 'binary' : 'file');
}

function renderFileIconDefinitions(): string {
  const definitions = (Object.entries(iconLabels) as Array<[FileIconKind, string]>)
    .map(([kind, label]) => {
      const specialBody = specialIconBodies[kind];
      const labelSize = label.length > 2 ? '4.2' : label.length > 1 ? '5.2' : '7';
      const labelColor = kind === 'javascript' ? '#252525' : '#fff';
      const body =
        specialBody ??
        `<rect x="1.5" y="1.5" width="13" height="13" rx="2" fill="currentColor"/><text x="8" y="10.6" text-anchor="middle" fill="${labelColor}" font-family="Arial, sans-serif" font-size="${labelSize}" font-weight="700">${escapeHtml(label)}</text>`;
      return `<symbol id="file-icon-${kind}" viewBox="0 0 16 16">${body}</symbol>`;
    })
    .join('');

  return `<svg class="file-icon-definitions" aria-hidden="true">${definitions}</svg>`;
}

function renderFileIcon(name: string, binary: boolean): string {
  const kind = fileIconKind(name, binary);

  return `<svg class="file-type-icon file-type-${kind}" data-file-icon="${kind}" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <use href="#file-icon-${kind}" />
  </svg>`;
}

function buildFileTree(files: readonly ChangedFile[]): ComparisonDirectory {
  const root = createDirectory();

  files.forEach((file, index) => {
    const pathParts = file.path.split('/');
    const name = pathParts.pop() ?? file.path;
    let directory = root;

    for (const part of pathParts) {
      let child = directory.directories.get(part);
      if (!child) {
        child = createDirectory();
        directory.directories.set(part, child);
      }
      directory = child;
    }

    directory.files.push({ file, index, name });
  });

  return root;
}

function renderFileRow({ file, index, name }: ComparisonFile): string {
  const additions =
    file.additions === undefined
      ? ''
      : `<span class="file-stat-additions">+${String(file.additions)}</span>`;
  const deletions =
    file.deletions === undefined
      ? ''
      : `<span class="file-stat-deletions">-${String(file.deletions)}</span>`;
  const binary = file.binary ? '<span class="file-binary">Binary</span>' : '';

  return `<button class="file-row" type="button" data-file-index="${String(index)}" title="${escapeHtml(file.path)}"${file.binary ? ' disabled' : ''}>
    <span class="file-status status-${escapeHtml(file.status)}">${escapeHtml(file.status)}</span>
    ${renderFileIcon(name, file.binary)}
    <span class="file-name">${escapeHtml(name)}</span>
    <span class="file-stats">${additions}${deletions}${binary}</span>
  </button>`;
}

function renderDirectory(directory: ComparisonDirectory): string {
  const directories = [...directory.directories.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([name, child]) => `<details class="file-directory" open>
        <summary>${escapeHtml(name)}</summary>
        <div class="file-directory-children">${renderDirectory(child)}</div>
      </details>`,
    )
    .join('');
  const files = [...directory.files]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(renderFileRow)
    .join('');

  return directories + files;
}

export function createComparisonHtml(options: {
  title: string;
  files: readonly ChangedFile[];
  nonce: string;
}): string {
  const rows = renderDirectory(buildFileTree(options.files));
  const textFileCount = options.files.filter((file) => !file.binary).length;
  const binaryFileCount = options.files.length - textFileCount;
  const binarySummary = binaryFileCount > 0 ? ` · ${String(binaryFileCount)} binary omitted` : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${options.nonce}'; script-src 'nonce-${options.nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(options.title)}</title>
  <style nonce="${options.nonce}">
    :root { --explorer-row-height: 22px; }
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; }
    body { overflow: hidden; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
    .comparison-shell { display: grid; grid-template-rows: auto minmax(0, 1fr); height: 100%; }
    .comparison-header { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; padding: 10px 12px; gap: 8px; border-bottom: 1px solid var(--vscode-panel-border); }
    .comparison-heading { min-width: 0; }
    .comparison-title { overflow: hidden; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
    .comparison-summary { margin-top: 3px; color: var(--vscode-descriptionForeground); font-size: 0.9em; }
    .comparison-mode-button { display: inline-flex; align-items: center; justify-content: center; height: 26px; padding: 0 8px; gap: 5px; border: 0; border-radius: 3px; color: var(--vscode-icon-foreground, currentColor); background: transparent; font: inherit; cursor: pointer; }
    .comparison-mode-button:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground); }
    .comparison-mode-button.selected { color: var(--vscode-list-activeSelectionForeground); background: var(--vscode-list-activeSelectionBackground); }
    .comparison-mode-button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    .comparison-mode-button:disabled { opacity: 0.45; cursor: default; }
    .comparison-mode-button svg { width: 16px; height: 16px; fill: currentColor; }
    .file-list { min-height: 0; overflow: auto; }
    .file-directory > summary { display: flex; align-items: center; height: var(--explorer-row-height); padding: 0 8px 0 0; overflow: hidden; font-weight: 400; white-space: nowrap; cursor: pointer; user-select: none; }
    .file-directory > summary::-webkit-details-marker { display: none; }
    .file-directory > summary::marker { content: ''; }
    .file-directory > summary::before { width: 7px; height: 7px; margin: 0 7px 0 3px; flex: 0 0 auto; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; content: ''; transform: rotate(-45deg); transform-origin: center; }
    .file-directory[open] > summary::before { transform: rotate(45deg); }
    .file-directory > summary:hover { background: var(--vscode-list-hoverBackground); }
    .file-directory > summary:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    .file-directory-children { margin-left: 10px; padding-left: 10px; border-left: 1px solid var(--vscode-tree-indentGuidesStroke, transparent); }
    .file-row { display: grid; grid-template-columns: 16px 16px minmax(0, 1fr) auto; align-items: center; width: 100%; height: var(--explorer-row-height); padding: 0 8px; gap: 5px; border: 0; color: inherit; background: transparent; font: inherit; text-align: left; cursor: pointer; }
    .file-row:hover { background: var(--vscode-list-hoverBackground); }
    .file-row.selected { color: var(--vscode-list-activeSelectionForeground); background: var(--vscode-list-activeSelectionBackground); }
    .file-row:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    .file-row:disabled { cursor: default; opacity: 0.7; }
    .file-status { font-weight: 700; text-align: center; }
    .file-icon-definitions { position: absolute; width: 0; height: 0; overflow: hidden; }
    .file-type-icon { display: block; width: 16px; height: 16px; overflow: visible; color: var(--vscode-descriptionForeground); }
    .file-type-dart { color: #40c4ff; }
    .file-type-typescript { color: #3178c6; }
    .file-type-javascript { color: #d6ba32; }
    .file-type-react { color: #61dafb; }
    .file-type-html { color: #e44d26; }
    .file-type-css { color: #42a5f5; }
    .file-type-json, .file-type-yaml, .file-type-config { color: var(--vscode-symbolIcon-objectForeground, #d7ba7d); }
    .file-type-markdown, .file-type-document { color: #519aba; }
    .file-type-image { color: #b180d7; }
    .file-type-archive { color: #cca700; }
    .file-type-shell { color: #89e051; }
    .file-type-python { color: #3572a5; }
    .file-type-java { color: #b07219; }
    .file-type-kotlin { color: #a97bff; }
    .file-type-swift { color: #f05138; }
    .file-type-go { color: #00add8; }
    .file-type-rust { color: #dea584; }
    .file-type-c, .file-type-cpp, .file-type-csharp { color: var(--vscode-symbolIcon-methodForeground, #b180d7); }
    .file-type-php { color: #777bb4; }
    .file-type-ruby { color: #cc342d; }
    .file-type-sql { color: #e38c00; }
    .file-type-xml { color: #e37933; }
    .file-type-binary { color: var(--vscode-disabledForeground); }
    .file-name { overflow: hidden; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
    .file-stats { display: flex; align-items: center; gap: 7px; font-variant-numeric: tabular-nums; }
    .file-stat-additions { color: var(--vscode-gitDecoration-addedResourceForeground); }
    .file-stat-deletions { color: var(--vscode-gitDecoration-deletedResourceForeground); }
    .file-binary { color: var(--vscode-descriptionForeground); }
    .empty { padding: 24px; color: var(--vscode-descriptionForeground); text-align: center; }
  </style>
</head>
<body>
  ${renderFileIconDefinitions()}
  <main class="comparison-shell">
    <header class="comparison-header">
      <div class="comparison-heading">
        <div class="comparison-title">${escapeHtml(options.title)}</div>
        <div class="comparison-summary">${String(options.files.length)} changed files${binarySummary} · Select a file or show all changes</div>
      </div>
      <button class="comparison-mode-button" type="button" data-open-all-comparisons aria-label="Show all changes" title="Show all text changes"${textFileCount > 0 ? '' : ' disabled'}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 2h5v5H2V2Zm1 1v3h3V3H3Zm6-1h5v5H9V2Zm1 1v3h3V3h-3ZM2 9h5v5H2V9Zm1 1v3h3v-3H3Zm6-1h5v5H9V9Zm1 1v3h3v-3h-3Z"/></svg>
        <span>All Changes</span>
      </button>
    </header>
    <section class="file-list" aria-label="Changed files">${rows || '<div class="empty">No changed files</div>'}</section>
  </main>
  <script nonce="${options.nonce}">
    const vscode = acquireVsCodeApi();
    document.addEventListener('click', (event) => {
      const allChanges = event.target instanceof Element ? event.target.closest('[data-open-all-comparisons]') : null;
      if (allChanges instanceof HTMLButtonElement && !allChanges.disabled) {
        document.querySelectorAll('.file-row.selected').forEach((row) => row.classList.remove('selected'));
        allChanges.classList.add('selected');
        vscode.postMessage({ type: 'openAllComparisonFiles' });
        return;
      }
      const target = event.target instanceof Element ? event.target.closest('[data-file-index]') : null;
      if (!(target instanceof HTMLButtonElement) || target.disabled) return;
      document.querySelectorAll('.file-row.selected').forEach((row) => row.classList.remove('selected'));
      document.querySelector('[data-open-all-comparisons]')?.classList.remove('selected');
      target.classList.add('selected');
      vscode.postMessage({ type: 'openComparisonFile', index: Number(target.dataset.fileIndex) });
    });
    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message?.type === 'comparisonAllClosed') {
        document.querySelector('[data-open-all-comparisons]')?.classList.remove('selected');
      }
    });
  </script>
</body>
</html>`;
}
