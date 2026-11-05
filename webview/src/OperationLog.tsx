import { useLayoutEffect, useRef } from 'react';

export interface OperationLogState {
  requestId: string;
  output: string;
  status: 'Running' | 'Completed' | 'Failed' | 'Cancelled';
  hidden: boolean;
  showOnFailureOnly?: boolean;
}

export function OperationLog({ log, maxHeight, onClose }: {
  log: OperationLogState;
  maxHeight: number;
  onClose(): void;
}) {
  const body = useRef<HTMLPreElement>(null);
  const following = useRef(true);
  useLayoutEffect(() => {
    if (following.current && body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [log.output]);

  return (
    <section
      className="operation-log"
      aria-label="Git command log"
      style={{ maxHeight: `min(${String(maxHeight)}px, calc(100vh - 24px))` }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <header className="operation-log-header">
        <strong>Git command log</strong>
        <span className={`operation-log-status ${log.status.toLowerCase()}`} role="status">{log.status}</span>
        <button type="button" aria-label="Close Git command log" title="Close Git command log" onClick={onClose}>×</button>
      </header>
      <pre
        ref={body}
        className="operation-log-output"
        role="log"
        aria-label="Git command output"
        aria-live="off"
        tabIndex={0}
        onScroll={(event) => {
          const element = event.currentTarget;
          following.current = element.scrollHeight - element.clientHeight - element.scrollTop <= 8;
        }}
      >{log.output || 'Waiting for command output…'}</pre>
    </section>
  );
}
