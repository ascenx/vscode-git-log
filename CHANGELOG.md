# Changelog

All notable changes to Git Log are documented in this file.

## 0.0.9

### Added

- Added an Explorer `Git Log` submenu. Files can open the existing dedicated File History tab, while folders open the bottom Git Log with a temporary recursive path filter.

### Changed

- Folder History restores the repository's previous filters, selection, and scroll position when returning to the normal log.
- Current-line history now shows configurable, visually subdued logical context lines around each tracked change without broadening the requested Git history range beyond the selected line.

### Fixed

- Suppressed the extension's current-line blame annotation while VS Code's built-in `git.blame.editorDecoration.enabled` decoration is active, preventing duplicate blame text.
- Refined current-line history across formatting and large replacement commits by tracking the matching logical line, pairing old and new context, honoring zero-context mode, and filtering commits that only changed another line in Git's expanded `-L` range.

## 0.0.8

### Added

- Added an `All Changes` action to commit comparisons that opens every non-binary file in a single VS Code multi-file diff while retaining per-file diff selection.
- Added a persisted Commit Details placement control for switching between the full-width bottom area and the bottom of Changed Files.

### Fixed

- Cleared the `All Changes` active state after its multi-file diff is closed.
- Kept Commit Details visible below Changed Files when no file preview is selected and when the persisted placement is restored at narrow panel widths.

## 0.0.7

### Added

- Added a confirmed `Force Delete…` action directly to non-current Local Branch context menus.

### Changed

- `Go to HEAD` now locates the checked-out HEAD inside the currently displayed branch or filtered commit list, aligns it as the first visible row, and does not switch the active commit list.
- Improved large-repository responsiveness with isolated virtual commit rendering, frame-coalesced scrolling, debounced scroll persistence, indexed ref attachment, cached date formatting, concurrent repository discovery, and incremental file-history paging.
- Minified production Extension Host, Webview, and syntax-worker bundles.

### Fixed

- Preserved HEAD positioning across asynchronous filter replacements without snapping back when later commit pages are appended.
- Kept automatic commit pagination working when the final commits are aligned at the top of the viewport.
- Bounded Git command output, terminated cancelled command process groups more reliably, limited expensive copy detection on large changes, and reported background Webview errors without leaving unhandled rejections.

### Safety

- Force Delete uses `git branch -D` only after a modal confirmation that names the repository and exact branch and warns that the branch may be unmerged.

## 0.0.6

### Added

- Added theme-aware current-line blame annotations with author, relative time, and commit subject, plus full author, timestamp, hash, and message details on hover.
- Added edit-age tracking for uncommitted lines, retained across editor tab switches and extension restarts.
- Added complete stash management with optional untracked files, stash listing, change previews, apply, pop, and confirmed drop.
- Added HEAD amend with commit-message editing and staged-change inclusion.

### Fixed

- Improved current-line blame for unsaved and unstaged changes, modified renames, case-only renames, large edits, and Git stdin failures.
- Prevented commit and reference context menus from extending beyond the visible viewport.

### Safety

- Dropping a stash and amending HEAD require explicit confirmation.

## 0.0.5

### Changed

- Lowered the minimum supported Git version from 2.30 to 2.27 while preserving exact hash search and force-push target resolution.
- Simplified the Branch pane by hiding upstream branch names while retaining ahead and behind indicators.

## 0.0.4

### Added

- Added Ctrl/Cmd+click for non-contiguous commit selection while keeping Shift+click and Shift+Arrow keys for contiguous ranges.
- Added `Checkout Revision` to the single-commit context menu for checking out a commit in detached HEAD state.

### Changed

- Changed Files now combines the changed files from every selected commit and opens each file against the commit and parent that produced it.
- `Drop commits…` and `Squash commits…` remain available only for contiguous multi-commit selections, while `Checkout Revision` remains a single-commit action.
- Removed the redundant `Show Details` commit-menu action because selecting a commit already loads its details.

### Fixed

- Preserved valid contiguous and non-contiguous commit selections across repository refreshes.

## 0.0.3

### Added

- Added a dedicated Branch pane search that filters Local, Remote, and Tag references without querying the commit log.
- Added recursive, collapsible folders for slash-delimited references, including remote names that contain `/`.

### Changed

- Moved commit-specific Text/Hash, Branch, User, Date, and Path filters into the Commit pane and placed global Git actions in the upper-right toolbar.
- Unified pane toolbar and heading backgrounds, reduced outer spacing, and refined pane dividers while preserving wider resize hit targets.
- Kept the Commit header aligned with its rows throughout horizontal scrolling.

### Fixed

- Hex-like text that does not resolve to a commit now falls back to full commit-message and author search instead of returning no results.
- Fixed Changed Files transparency and overlap issues, and kept Branch, Commit, and Changed Files panes in their correct grid columns when sibling panes are collapsed.

## 0.0.2

### Added

- Added contiguous multi-commit selection with Shift+click and Shift+Up/Down.
- Added confirmed `Drop commits…` and `Squash commits…` actions for the current branch's linear first-parent history.
- Added an editable squash message dialog prefilled with the selected commits' complete messages in visible top-to-bottom order.
- Added a warning-colored Force Delete recovery action when a local branch cannot be deleted because it is not fully merged.
- Added Tag-triggered GitHub Actions packaging and GitHub Release publishing for VSIX files.

### Changed

- Lowered the minimum supported VS Code version to 1.85.2 and aligned Extension Host bundles with its Node 18 runtime.
- Clicking or double-clicking a branch now selects and displays its commit history without checking it out; checkout is available explicitly from the Ref context menu.
- Commit Log text is no longer natively selectable, preventing browser text highlighting from overlapping multi-row commit selection.
- Error notices remain visible for five seconds before being dismissed automatically.

### Fixed

- Fixed line-history path parsing for quoted Unicode and emoji filenames emitted by Git on Linux.
- Editor-history commands now return their asynchronous work so callers and CI wait until the requested tab is open.

### Safety

- Drop and Squash require a clean worktree and destructive confirmation.
- History rewriting is limited to a contiguous range on the checked-out branch's first-parent chain and rejects root commits, merge commits, stale plans, and branch or HEAD changes during confirmation.
- Rebase execution disables automatic stashing and reference updates so unrelated local branches are not rewritten.

## 0.0.1

- Initial public release of the Git Log workbench, commit graph, changed-file browser, repository operations, and editor line/file history tools.
