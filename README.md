# Git Log

[English](README.md) | [简体中文](README.zh-CN.md)

[![Visual Studio Marketplace Version](https://img.shields.io/badge/Marketplace-v0.0.3-007ACC?logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=ascenx.git-log)
[![Open VSX Version](https://img.shields.io/open-vsx/v/ascenx/git-log?label=Open%20VSX)](https://open-vsx.org/extension/ascenx/git-log)

A visual Git log, commit graph, history browser, and repository operations extension for Visual Studio Code.

Git Log is designed to provide a complete Git history workflow inside VS Code rather than restyling the built-in Source Control view. It combines a refs tree, commit topology graph, changed-files tree, commit details, native diffs, and common branch and commit operations.

## Installation

Install [Git Log — Commit Graph & History](https://marketplace.visualstudio.com/items?itemName=ascenx.git-log) from the Visual Studio Marketplace, or search for `ascenx.git-log` in the VS Code Extensions view.

Git Log supports VS Code 1.85.2 and later.

You can also install it from the command line:

```bash
code --install-extension ascenx.git-log
```

## Screenshots

### Git Log Workbench

![Git Log Workbench](https://raw.githubusercontent.com/ascenx/vscode-git-log/main/images/git_log_workbench.png)

### File History

![File History](https://raw.githubusercontent.com/ascenx/vscode-git-log/main/images/file_history.png)

### Line History

![Line History](https://raw.githubusercontent.com/ascenx/vscode-git-log/main/images/line_history.png)

### Compare with Branch or Tag

![Compare with Branch or Tag](https://raw.githubusercontent.com/ascenx/vscode-git-log/main/images/branch_compare.png)

## Core principles

1. Provide a dense, clear, and efficient Git history workflow.
2. Treat the Git CLI as the source of truth for repository data and operations.
3. Reuse native VS Code editing, diff, and merge capabilities whenever possible.
4. Use pagination, bounded caches, and virtual scrolling for large repositories instead of loading the full history.
5. Show the exact target, impact, and confirmation step for every destructive operation.
6. Back every implementation milestone with automated tests and executable acceptance checks.

## Implemented Git Log features

```text
┌─────────────────────────────────────────────────────────────────────┐
│ Ref filter │ Text/hash │ Branch │ User │ Date │ Paths │ Actions   │
├─────────────┬───────────────────────────────────┬───────────────────┤
│ HEAD        │ Commit graph                      │ Changed files     │
│ Local       │ ● fix: ...        main   Alice   │ src/              │
│   main      │ │\                                │   extension.ts    │
│   feature   │ │ ● feat: ...     feature Bob    │ package.json      │
│ Remote      │ ●─┘ refactor: ...                 │                   │
│ Tags        │                                   │                   │
├─────────────┴───────────────────────────────────┴───────────────────┤
│ Commit message │ hash │ author │ date │ parents │ action toolbar    │
└─────────────────────────────────────────────────────────────────────┘
```

The current version covers Milestones 0–6 and the editor history work from Milestone 7:

- Multi-root repository discovery for standard repositories, bare repositories, linked worktrees, and detached HEAD states.
- Synchronized Refs, Commit Graph, Changed Files, and Commit Details areas.
- A dedicated Branch pane search and a recursive, collapsible reference tree that groups slash-delimited Local, Remote, and Tag names into folders. Remote names containing `/` remain distinct top-level folders.
- A dedicated `Git Log` tab in the VS Code bottom Panel alongside Problems, Output, and Terminal. `Open Log` focuses this tab directly without opening an editor page or intermediate welcome view.
- Paginated logs, bounded sliding windows, custom DAG lanes, graph continuation across windows, fixed-row virtual scrolling, and large-list performance benchmarks. Deep-page global offsets, selections, and relative scroll positions can be restored.
- Combined Text/Hash, Branch, User, Date, and Path filters with cancellation and stale-response rejection. Repository refreshes do not overwrite an active search draft. Text queries scan the full message, author name, and email in canonical `git log --date-order` order while preserving child-before-parent topology.
- Changed-file handling for root, merge, rename, copy, and binary commits, with native VS Code diffs.
- Checkout, Branch, Tag, Fetch, Pull, Push, Cherry-pick, Revert, Merge, Rebase, Reset, and branch rename/delete operations, with context menus for Local, Remote, Tag, and HEAD refs.
- Branch clicks select and display that branch's commits without checking it out; checkout remains an explicit Ref context-menu action.
- Contiguous commits can be selected with Shift+click or Shift+Arrow keys, then dropped or squashed from the Commit context menu. Squash preloads the selected full commit messages in visible top-to-bottom order. History rewrites require a clean worktree and explicit confirmation, and reject root commits, merge commits, stale selections, and changes to the active branch or HEAD during confirmation.
- Unmerged branch deletion errors offer a warning-colored Force Delete action, and error notices remain visible for five seconds before closing automatically.
- Serialized writes per common Git directory, per-repository Webview operation locks, destructive-operation confirmation dialogs, classified Git errors, redacted Output Channel diagnostics, and post-operation repository refreshes.
- Draggable panes and columns, collapsible panes, and workspace-scoped width and height persistence. Commit, Author, Date, and Refs columns are always visible, and deep-page selections and scroll positions survive reopening the panel.
- Resizable Commit and Refs table columns with persisted widths. Changed Files supports horizontal scrolling for deep paths, with additions in green and deletions in red.
- Changed Files preview, Tree/List modes, Show Diff, Open File at Revision, Open Current File, Copy Path, and Commit/Ref/File context menus. Menus close on outside clicks and after executing an enabled action.
- Compare with Current opens a dedicated file list with file status and green addition/red deletion counts. The native VS Code diff opens on the right only after selecting a file.
- A `Git Log` editor context submenu for current-line history, selection history, complete file history, and comparison of the current file with the same path in a Local Branch, Remote Branch, or Tag.
- Line history maps workspace lines back to `HEAD`. Unsaved content participates through an in-memory Extension Host snapshot without triggering a save. Purely uncommitted added lines show a clear empty state, while partial or discontinuous selections are not incorrectly assigned to a commit. File history supports renames, pagination, HEAD-scoped caching, and green/red change statistics.
- Current Line, Selection, and File History open in dedicated editor tabs. The left side lists related commits and change counts, and the divider between the commit list and diff is draggable and persisted.
- History tabs show an inline diff for the focused range or complete file. A separate Worker uses Shiki with lazily loaded grammars for syntax highlighting. `VS Code Diff` opens the current commit in the native Diff Editor with minimap, search, language support, and standard shortcuts. Switching commits cancels stale highlighting work, while timeouts, oversized patches, long lines, or excessive token budgets fall back to plain text without blocking the Extension Host.
- Complete keyboard navigation, two-stage `Escape` handling in search, `Ctrl/Cmd+C` commit hash copying, and light, dark, and high-contrast theme support.

## Local development

```text
npm install
npm run typecheck
npm run lint
npm run test:unit
npm run test:integration
npm run build
```

In VS Code, select `Run Extension` to launch the Extension Development Host, then run `Git Log: Open Log` or click the `Git Log` tab in the bottom Panel.

Build a local VSIX with:

```text
npm run package
```


## Usage tips

- Click or double-click a Local or Remote branch to display its commit history without checking it out. Use the Local branch context menu when you explicitly want to check it out.
- Use the Branch pane search to filter references locally. Slash-delimited names are grouped into folders that can be expanded or collapsed independently.
- Select a commit, then hold Shift while clicking another commit or pressing Up/Down to extend a contiguous range. Right-click the range to choose `Drop commits…` or `Squash commits…`.
- Click a Changed File to inspect its path, status, and change summary. Double-click it or choose `Show Diff` to use the native VS Code Diff Editor.
- Right-click a normal local file and open `Git Log`: with no selection it shows current-line history, with a selection it shows selection history, and it can also open complete File History in a dedicated tab. Branch/Tag comparison uses native VS Code diff capabilities, including minimap, syntax highlighting, search, and diff shortcuts.
- Use `Ctrl/Cmd+F` to focus search, `Ctrl/Cmd+L` to focus the Commit Log, and `Ctrl/Cmd+C` to copy the selected commit's full hash. Arrow keys, PageUp/PageDown, Home, and End navigate commits.
- The first `Escape` clears the search field. Pressing `Escape` again when search is empty returns focus to the Commit Graph.
- Drag pane and commit-column separators with the mouse, or focus a separator and adjust it with the arrow keys. Toolbar actions can collapse Refs and Changed Files; Commit, Author, Date, and Refs remain available.
- The User filter pins `Me (current Git user)` to the top using the repository's `git config user.name/user.email`, preferring email matching. Toolbar buttons include hover descriptions.
- Refresh reads local repository state only. Fetch, Pull, and Push access the configured remote and reuse the system credential helper or SSH Agent.

## Security and privacy

- Every Git command uses a `spawn` argument array without a shell.
- The extension never stores passwords, tokens, or SSH private keys. Remote authentication is delegated to Git.
- The Output Channel redacts URL user information and does not log file contents or complete environment variables.
- Hard Reset, Force Push with Lease, Branch Delete, and other destructive operations show the repository and exact target before confirmation.
- Force-push target resolution, confirmation, and execution occur under the same common Git directory queue lock, pin the source object ID, and reject implicit or incomplete target refspecs.
- A text-history scan is limited to 64 MiB of stdout, the rolling match cache is bounded, and the Webview commit window respects `maxCachedCommits`.
- Telemetry is disabled by default.
