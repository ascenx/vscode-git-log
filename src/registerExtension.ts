export interface DisposableLike {
  dispose(): void;
}

export interface ExtensionRegistrationHost {
  registerCommand(command: string, handler: (...args: unknown[]) => unknown): DisposableLike;
  openWorkbench(): void;
  showLineHistory(): Promise<void>;
  showSelectionHistory(): Promise<void>;
  showFileHistory(resource?: unknown): Promise<void>;
  showFolderHistory(resource?: unknown): Promise<void>;
  compareFileWithRef(): void;
}

export function registerExtension(host: ExtensionRegistrationHost): DisposableLike[] {
  const openLogCommand = host.registerCommand('gitLogWorkbench.openLog', () => {
    host.openWorkbench();
  });
  const showLineHistoryCommand = host.registerCommand(
    'gitLogWorkbench.editor.showLineHistory',
    () => host.showLineHistory(),
  );
  const showSelectionHistoryCommand = host.registerCommand(
    'gitLogWorkbench.editor.showSelectionHistory',
    () => host.showSelectionHistory(),
  );
  const showFileHistoryCommand = host.registerCommand(
    'gitLogWorkbench.editor.showFileHistory',
    (resource?: unknown) => host.showFileHistory(resource),
  );
  const showFolderHistoryCommand = host.registerCommand(
    'gitLogWorkbench.explorer.showFolderHistory',
    (resource?: unknown) => host.showFolderHistory(resource),
  );
  const compareFileWithRefCommand = host.registerCommand(
    'gitLogWorkbench.editor.compareFileWithRef',
    () => host.compareFileWithRef(),
  );

  return [
    openLogCommand,
    showLineHistoryCommand,
    showSelectionHistoryCommand,
    showFileHistoryCommand,
    showFolderHistoryCommand,
    compareFileWithRefCommand,
  ];
}
