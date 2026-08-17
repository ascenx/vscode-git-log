import { describe, expect, it } from 'vitest';
// @ts-expect-error jsdom does not provide declarations in this project's dependency set.
import { JSDOM } from 'jsdom';
import { createFileHistoryHtml } from '../../src/editor/createFileHistoryHtml';
import type { HistoryEntry } from '../../src/shared/models';

const entry: HistoryEntry = {
  hash: 'a'.repeat(40),
  parents: ['b'.repeat(40)],
  subject: 'update app',
  authorName: 'Alice',
  authorEmail: 'alice@example.com',
  authorTime: 1,
  commitTime: 2,
  refs: [],
  path: 'src/app.ts',
  additions: 2,
  deletions: 1,
  binary: false,
};

function render(overrides: Record<string, unknown> = {}): string {
  return createFileHistoryHtml({
    nonce: 'test-nonce',
    path: 'src/app.ts',
    entries: [entry],
    hasMore: false,
    ...overrides,
  } as Parameters<typeof createFileHistoryHtml>[0]);
}

function mountFileHistory(
  overrides: Record<string, unknown> = {},
  options: { manualAnimationFrames?: boolean } = {},
): {
  dom: { window: Window & typeof globalThis };
  scrollCalls: ScrollToOptions[];
  postedMessages: unknown[];
  pendingAnimationFrames(): number;
  runAnimationFrame(timestamp: number): void;
} {
  const scrollCalls: ScrollToOptions[] = [];
  const postedMessages: unknown[] = [];
  const animationFrames = new Map<number, FrameRequestCallback>();
  let nextAnimationFrameId = 0;
  const dom = new JSDOM(render(overrides), {
    pretendToBeVisual: true,
    runScripts: 'dangerously',
    beforeParse(window: Window & typeof globalThis) {
      Object.assign(window, {
        acquireVsCodeApi: () => ({
          getState: () => undefined,
          postMessage: (message: unknown) => postedMessages.push(message),
          setState: () => undefined,
        }),
        requestAnimationFrame: (callback: FrameRequestCallback) => {
          if (options.manualAnimationFrames) {
            const id = ++nextAnimationFrameId;
            animationFrames.set(id, callback);
            return id;
          }
          callback(0);
          return 1;
        },
        cancelAnimationFrame: (id: number) => animationFrames.delete(id),
      });
      Object.defineProperty(window.HTMLElement.prototype, 'scrollTo', {
        configurable: true,
        value(scrollOptions: ScrollToOptions) {
          scrollCalls.push(scrollOptions);
          if (typeof scrollOptions.top === 'number') this.scrollTop = scrollOptions.top;
        },
      });
    },
  });
  return {
    dom,
    scrollCalls,
    postedMessages,
    pendingAnimationFrames: () => animationFrames.size,
    runAnimationFrame(timestamp) {
      const frame = animationFrames.entries().next().value as
        | [number, FrameRequestCallback]
        | undefined;
      if (!frame) throw new Error('No animation frame is pending.');
      animationFrames.delete(frame[0]);
      frame[1](timestamp);
    },
  };
}

describe('createFileHistoryHtml', () => {
  it('starts the commit list at the top without a duplicate file-history header', () => {
    const html = render();

    expect(html).not.toContain('class="history-header"');
    expect(html).not.toContain('class="history-title"');
    expect(html).not.toContain('class="history-path"');
  });

  it('adds an accessible draggable separator and persists the commit-list width', () => {
    const html = render();

    expect(html).toContain('class="history-resizer"');
    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-label="Resize commit list"');
    expect(html).toContain('--history-pane-width');
    expect(html).toContain('body { overflow-x: auto; overflow-y: hidden;');
    expect(html).toContain('min-width: 505px');
    expect(html).toContain("resizer.addEventListener('pointerdown'");
    expect(html).toContain('if (resizePointerId !== undefined) return;');
    expect(html).toContain('setPointerCapture');
    expect(html).toContain("resizer.addEventListener('lostpointercapture'");
    expect(html).toContain("window.addEventListener('blur'");
    expect(html).toContain('vscode.setState');
  });

  it('keeps both panes independently scrollable and navigates between diff changes', () => {
    const html = render();

    expect(html).toContain('overflow-x: auto; overflow-y: hidden;');
    expect(html).toContain('.history-list { min-height: 0; overflow: auto; overscroll-behavior: contain; }');
    expect(html).toContain('.diff-body { min-height: 0; overflow: auto; overscroll-behavior: contain;');
    expect(html).toContain('class="diff-body" role="region" aria-label="File diff content" tabindex="0"');
    expect(html).toContain('class="diff-nav-button diff-previous-change"');
    expect(html).toContain('aria-label="Previous change"');
    expect(html).toContain('class="diff-nav-button diff-next-change"');
    expect(html).toContain('aria-label="Next change"');
    expect(html).toContain("document.querySelectorAll('.diff-row.add, .diff-row.delete')");
    expect(html).toContain('requestAnimationFrame(() => navigateToChange(0, false))');
    expect(html).toContain('diffBody.scrollTo');
    expect(html).toContain("previousChange.addEventListener('click'");
    expect(html).toContain("nextChange.addEventListener('click'");
  });

  it('opens the selected commit in the native VS Code diff', () => {
    const { dom, postedMessages } = mountFileHistory();
    const openNativeDiff = dom.window.document.querySelector<HTMLButtonElement>(
      '.open-native-diff',
    );

    expect(openNativeDiff?.title).toBe('Open in VS Code Diff');
    openNativeDiff?.click();

    expect(postedMessages).toContainEqual({
      type: 'openFileHistoryNativeDiff',
      hash: entry.hash,
      parent: entry.parents[0],
    });
    dom.window.close();
  });

  it('renders syntax tokens without injecting token content as HTML', () => {
    const { dom } = mountFileHistory();

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: {
        type: 'fileHistoryDiffLoaded',
        hash: entry.hash,
        subject: entry.subject,
        subtitle: entry.path,
        binary: false,
        patch: '@@ -1 +1 @@\n-const oldValue = 1;\n+const newValue = 2;',
        highlightedLines: [
          undefined,
          [
            { content: '-', light: '#24292f', dark: '#c9d1d9' },
            { content: '<script>', light: '#cf222e', dark: '#ff7b72' },
          ],
          [
            { content: '+', light: '#24292f', dark: '#c9d1d9' },
            { content: 'const newValue = 2;', light: '#cf222e', dark: '#ff7b72' },
          ],
        ],
      },
    }));

    const deletedCode = dom.window.document.querySelector('.diff-row.delete .diff-code');
    const token = deletedCode?.querySelector<HTMLElement>('.syntax-token');
    expect(deletedCode?.textContent).toBe('-<script>');
    expect(deletedCode?.querySelector('script')).toBeNull();
    expect(token?.style.getPropertyValue('--history-token-light')).toBe('#24292f');
    expect(token?.style.getPropertyValue('--history-token-dark')).toBe('#c9d1d9');
    dom.window.close();
  });

  it('navigates real diff blocks and keeps a no-newline replacement together', () => {
    const { dom, scrollCalls } = mountFileHistory();
    const previous = dom.window.document.querySelector<HTMLButtonElement>('.diff-previous-change');
    const next = dom.window.document.querySelector<HTMLButtonElement>('.diff-next-change');

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: {
        type: 'fileHistoryDiffLoaded',
        hash: entry.hash,
        subject: entry.subject,
        subtitle: entry.path,
        binary: false,
        patch: '@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file',
      },
    }));

    expect(scrollCalls).toHaveLength(1);
    expect(scrollCalls[0]?.behavior).toBe('auto');
    expect(previous?.disabled).toBe(true);
    expect(next?.disabled).toBe(true);

    dom.window.close();
  });

  it('moves between separated change blocks and disables navigation while loading', () => {
    const { dom, scrollCalls } = mountFileHistory();
    const previous = dom.window.document.querySelector<HTMLButtonElement>('.diff-previous-change');
    const next = dom.window.document.querySelector<HTMLButtonElement>('.diff-next-change');

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: {
        type: 'fileHistoryDiffLoaded',
        hash: entry.hash,
        subject: entry.subject,
        subtitle: entry.path,
        binary: false,
        patch: '@@ -1,3 +1,3 @@\n-old one\n+new one\n unchanged\n-old two\n+new two',
      },
    }));

    expect(scrollCalls).toHaveLength(1);
    expect(previous?.disabled).toBe(true);
    expect(next?.disabled).toBe(false);

    next?.click();
    expect(scrollCalls).toHaveLength(2);
    expect(scrollCalls[1]?.behavior).toBe('auto');
    expect(previous?.disabled).toBe(false);
    expect(next?.disabled).toBe(true);

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'fileHistoryDiffLoading', hash: entry.hash },
    }));
    expect(previous?.disabled).toBe(true);
    expect(next?.disabled).toBe(true);

    dom.window.close();
  });

  it('uses a short fixed-duration animation when changes are far apart', () => {
    const {
      dom,
      scrollCalls,
      pendingAnimationFrames,
      runAnimationFrame,
    } = mountFileHistory({}, { manualAnimationFrames: true });
    const diffBody = dom.window.document.querySelector<HTMLElement>('.diff-body');
    const next = dom.window.document.querySelector<HTMLButtonElement>('.diff-next-change');

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: {
        type: 'fileHistoryDiffLoaded',
        hash: entry.hash,
        subject: entry.subject,
        subtitle: entry.path,
        binary: false,
        patch: '@@ -1,3 +1,3 @@\n-old one\n+new one\n unchanged\n-old two\n+new two',
      },
    }));
    runAnimationFrame(0);

    const secondChange = dom.window.document.querySelectorAll<HTMLElement>('.diff-row.delete')[1];
    Object.defineProperty(diffBody, 'clientHeight', { configurable: true, value: 300 });
    if (diffBody) diffBody.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
    if (secondChange) secondChange.getBoundingClientRect = () => ({ top: 9_000 }) as DOMRect;

    next?.click();
    expect(pendingAnimationFrames()).toBe(1);
    runAnimationFrame(0);
    runAnimationFrame(60);
    expect(diffBody?.scrollTop).toBeGreaterThan(0);
    expect(diffBody?.scrollTop).toBeLessThan(8_900);
    runAnimationFrame(120);
    expect(diffBody?.scrollTop).toBeLessThan(8_900);
    runAnimationFrame(200);

    expect(diffBody?.scrollTop).toBe(8_900);
    expect(pendingAnimationFrames()).toBe(0);
    expect(scrollCalls.every((call) => call.behavior === 'auto')).toBe(true);
    dom.window.close();
  });

  it('can render only changed lines for current-line history', () => {
    const { dom } = mountFileHistory({ changesOnly: true });

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: {
        type: 'fileHistoryDiffLoaded',
        hash: entry.hash,
        subject: entry.subject,
        subtitle: entry.path,
        binary: false,
        patch: '@@ -7,2 +7,2 @@\n---old heading\n+++new heading\n unchanged context',
      },
    }));

    expect(dom.window.document.querySelectorAll('.diff-row.delete')).toHaveLength(1);
    expect(dom.window.document.querySelectorAll('.diff-row.add')).toHaveLength(1);
    expect(dom.window.document.querySelectorAll('.diff-row.context')).toHaveLength(0);
    expect(dom.window.document.querySelectorAll('.diff-row.hunk')).toHaveLength(0);
    expect(dom.window.document.querySelector('.diff-row.delete .diff-code')?.textContent).toBe(
      '---old heading',
    );
    expect(dom.window.document.querySelector('.diff-row.add .diff-code')?.textContent).toBe(
      '+++new heading',
    );

    dom.window.close();
  });

  it('keeps every line in the commit-specific tracked range without structural patch rows', () => {
    const { dom } = mountFileHistory({
      contentOnly: true,
    });
    const context = Array.from({ length: 19 }, (_, index) => {
      const line = index + 17;
      if (line === 25) return '-old selected\n+new selected';
      return ` line ${String(line)}`;
    }).join('\n');

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: {
        type: 'fileHistoryDiffLoaded',
        hash: entry.hash,
        subject: entry.subject,
        subtitle: entry.path,
        binary: false,
        patch: `diff --git a/app.ts b/app.ts\n--- a/app.ts\n+++ b/app.ts\n@@ -17,19 +17,19 @@\n${context}`,
      },
    }));

    const code = [...dom.window.document.querySelectorAll('.diff-code')]
      .map((node) => node.textContent);
    expect(code).toContain(' line 17');
    expect(code).toContain(' line 35');
    expect(code).toContain('-old selected');
    expect(code).toContain('+new selected');
    expect(dom.window.document.querySelectorAll('.diff-row.hunk')).toHaveLength(0);
    expect(dom.window.document.querySelectorAll('.diff-row.meta')).toHaveLength(0);

    dom.window.close();
  });
});
