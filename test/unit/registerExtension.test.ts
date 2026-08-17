import { describe, expect, it, vi } from 'vitest';
import { registerExtension } from '../../src/registerExtension';

describe('registerExtension', () => {
  it('registers public workbench and editor-context commands and delegates them', () => {
    const openWorkbench = vi.fn();
    const showLineHistory = vi.fn();
    const showSelectionHistory = vi.fn();
    const showFileHistory = vi.fn();
    const compareFileWithRef = vi.fn();
    const registeredCommands = new Map<string, () => void>();

    const result = registerExtension({
      registerCommand(command: string, handler: () => void) {
        registeredCommands.set(command, handler);
        return { dispose: vi.fn() };
      },
      openWorkbench,
      showLineHistory,
      showSelectionHistory,
      showFileHistory,
      compareFileWithRef,
    });

    expect(result).toHaveLength(5);
    registeredCommands.get('gitLogWorkbench.openLog')?.();
    registeredCommands.get('gitLogWorkbench.editor.showLineHistory')?.();
    registeredCommands.get('gitLogWorkbench.editor.showSelectionHistory')?.();
    registeredCommands.get('gitLogWorkbench.editor.showFileHistory')?.();
    registeredCommands.get('gitLogWorkbench.editor.compareFileWithRef')?.();
    expect(openWorkbench).toHaveBeenCalledOnce();
    expect(showLineHistory).toHaveBeenCalledOnce();
    expect(showSelectionHistory).toHaveBeenCalledOnce();
    expect(showFileHistory).toHaveBeenCalledOnce();
    expect(compareFileWithRef).toHaveBeenCalledOnce();
  });
});
