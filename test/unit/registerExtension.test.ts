import { describe, expect, it, vi } from 'vitest';
import { registerExtension } from '../../src/registerExtension';

describe('registerExtension', () => {
  it('registers public workbench and editor-context commands and delegates them', () => {
    const openWorkbench = vi.fn();
    const showLineHistory = vi.fn();
    const showSelectionHistory = vi.fn();
    const showFileHistory = vi.fn();
    const showFolderHistory = vi.fn();
    const compareFileWithRef = vi.fn();
    const registeredCommands = new Map<string, (...args: unknown[]) => void>();

    const result = registerExtension({
      registerCommand(command: string, handler: (...args: unknown[]) => void) {
        registeredCommands.set(command, handler);
        return { dispose: vi.fn() };
      },
      openWorkbench,
      showLineHistory,
      showSelectionHistory,
      showFileHistory,
      showFolderHistory,
      compareFileWithRef,
    });

    expect(result).toHaveLength(6);
    const fileResource = { scheme: 'file', fsPath: '/repo/src/app.ts' };
    const folderResource = { scheme: 'file', fsPath: '/repo/src' };
    registeredCommands.get('gitLogWorkbench.openLog')?.();
    registeredCommands.get('gitLogWorkbench.editor.showLineHistory')?.();
    registeredCommands.get('gitLogWorkbench.editor.showSelectionHistory')?.();
    registeredCommands.get('gitLogWorkbench.editor.showFileHistory')?.(fileResource);
    registeredCommands.get('gitLogWorkbench.explorer.showFolderHistory')?.(folderResource);
    registeredCommands.get('gitLogWorkbench.editor.compareFileWithRef')?.();
    expect(openWorkbench).toHaveBeenCalledOnce();
    expect(showLineHistory).toHaveBeenCalledOnce();
    expect(showSelectionHistory).toHaveBeenCalledOnce();
    expect(showFileHistory).toHaveBeenCalledWith(fileResource);
    expect(showFolderHistory).toHaveBeenCalledWith(folderResource);
    expect(compareFileWithRef).toHaveBeenCalledOnce();
  });
});
