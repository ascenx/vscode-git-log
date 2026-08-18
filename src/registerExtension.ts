export interface DisposableLike {
  dispose(): void;
}

export interface ExtensionRegistrationHost {
  registerCommand(command: string, handler: () => unknown): DisposableLike;
  openWorkbench(): void;
  showLineHistory(): Promise<void>;
  showSelectionHistory(): Promise<void>;
  showFileHistory(): Promise<void>;
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
    () => host.showFileHistory(),
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
    compareFileWithRefCommand,
  ];
}
