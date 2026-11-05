// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OperationLog } from '../../webview/src/OperationLog';

afterEach(cleanup);

describe('OperationLog', () => {
  it('follows new output only while the user is at the bottom', () => {
    const log = { requestId: 'one', output: '$ git fetch\n', status: 'Running' as const, hidden: false };
    const { rerender } = render(<OperationLog log={log} maxHeight={156} onClose={vi.fn()} />);
    const body = screen.getByRole('log');
    Object.defineProperties(body, {
      scrollHeight: { configurable: true, value: 600 },
      clientHeight: { configurable: true, value: 100 },
    });
    rerender(<OperationLog log={{ ...log, output: `${log.output}progress\n` }} maxHeight={156} onClose={vi.fn()} />);
    expect(body.scrollTop).toBe(600);
    body.scrollTop = 100;
    fireEvent.scroll(body);
    rerender(<OperationLog log={{ ...log, output: `${log.output}more progress\n` }} maxHeight={156} onClose={vi.fn()} />);
    expect(body.scrollTop).toBe(100);
    body.scrollTop = 500;
    fireEvent.scroll(body);
    rerender(<OperationLog log={{ ...log, output: `${log.output}finished\n` }} maxHeight={156} onClose={vi.fn()} />);
    expect(body.scrollTop).toBe(600);
  });

  it('caps its height to the bottom pane and renders output as text', () => {
    const onClose = vi.fn();
    render(<OperationLog log={{ requestId: 'one', output: '<script>test</script>', status: 'Failed', hidden: false }} maxHeight={120} onClose={onClose} />);
    expect(screen.getByRole('region', { name: 'Git command log' })).toHaveStyle({ maxHeight: 'min(120px, calc(100vh - 24px))' });
    expect(screen.getByRole('log')).toHaveTextContent('<script>test</script>');
    expect(document.querySelector('script')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close Git command log' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
