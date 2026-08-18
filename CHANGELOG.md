# Changelog

All notable changes to Git Log are documented in this file.

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

### Safety

- Drop and Squash require a clean worktree and destructive confirmation.
- History rewriting is limited to a contiguous range on the checked-out branch's first-parent chain and rejects root commits, merge commits, stale plans, and branch or HEAD changes during confirmation.
- Rebase execution disables automatic stashing and reference updates so unrelated local branches are not rewritten.

## 0.0.1

- Initial public release of the Git Log workbench, commit graph, changed-file browser, repository operations, and editor line/file history tools.
