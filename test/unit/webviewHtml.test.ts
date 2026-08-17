import { describe, expect, it } from 'vitest';

describe('createWebviewHtml', () => {
  it('creates a nonce-protected standalone workbench document', async () => {
    const htmlModule = await import('../../src/webview/createWebviewHtml').catch(() => undefined);

    expect(htmlModule, 'the webview HTML module must exist').toBeDefined();
    if (!htmlModule) return;

    const html = htmlModule.createWebviewHtml({
      cspSource: 'vscode-webview://test',
      scriptUri: 'vscode-webview://test/dist/webview.js',
      styleUri: 'vscode-webview://test/dist/webview.css',
      nonce: 'fixed-nonce',
    });

    expect(html).toContain("default-src 'none'");
    expect(html).toContain("script-src 'nonce-fixed-nonce'");
    expect(html).toContain('nonce="fixed-nonce"');
    expect(html).toContain('id="root"');
    expect(html).toContain('dist/webview.js');
    expect(html).toContain('dist/webview.css');
  });
});
