import { basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { ChangedFile, ChangedFileStatus } from '../shared/models';
import {
  buildDiffSides,
  buildRevisionFileTarget,
  encodeRevisionQuery,
  type DiffSide,
} from './diffModel';
import { REVISION_SCHEME } from './RevisionContentProvider';
import { createComparisonHtml } from './createComparisonHtml';

export interface OpenDiffRequest {
  hash: string;
  parent?: string;
  path: string;
  oldPath?: string;
  status: ChangedFileStatus;
  revealLine?: number;
  onWillOpen?: (originalUri: vscode.Uri, modifiedUri: vscode.Uri) => void;
}

export interface OpenWorkingFileComparisonRequest {
  revision: string;
  revisionLabel: string;
  path: string;
  workingFileUri: vscode.Uri;
  revisionExists: boolean;
  forceInline?: boolean;
  isCurrent?: () => boolean;
  onWillOpen?: (originalUri: vscode.Uri) => void;
}

function sideUri(repositoryId: string, side: DiffSide): vscode.Uri {
  const query = encodeRevisionQuery({
    repositoryId,
    revision: side.kind === 'revision' ? side.revision : '',
    path: side.path,
    empty: side.kind === 'empty',
  });
  return vscode.Uri.from({
    scheme: REVISION_SCHEME,
    path: `/${basename(side.path)}`,
    query,
  });
}

export class DiffManager {
  private comparisonPanel: vscode.WebviewPanel | undefined;

  async open(
    repositoryId: string,
    request: OpenDiffRequest,
    viewColumn?: vscode.ViewColumn,
  ): Promise<void> {
    const sides = buildDiffSides(request);
    const title = `${basename(request.path)} (${request.parent?.slice(0, 8) ?? 'empty'} ↔ ${request.hash.slice(0, 8)})`;
    const left = sideUri(repositoryId, sides.left);
    const right = sideUri(repositoryId, sides.right);
    request.onWillOpen?.(left, right);
    await vscode.commands.executeCommand(
      'vscode.diff',
      left,
      right,
      title,
      { preview: true, ...(viewColumn === undefined ? {} : { viewColumn }) },
    );
    if (request.revealLine !== undefined && request.revealLine > 0) {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const line = Math.min(request.revealLine - 1, Math.max(0, editor.document.lineCount - 1));
        editor.revealRange(
          new vscode.Range(line, 0, line, 0),
          vscode.TextEditorRevealType.InCenterIfOutsideViewport,
        );
      }
    }
  }

  async openFile(
    repositoryId: string,
    repositoryRoot: vscode.Uri,
    request: OpenDiffRequest & { mode: 'revision' | 'current' },
  ): Promise<void> {
    if (request.mode === 'current') {
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.joinPath(repositoryRoot, request.path), {
        preview: true,
      });
      return;
    }
    const target = buildRevisionFileTarget(request);
    if (!target) throw new Error('This file does not exist at the selected revision.');
    await vscode.commands.executeCommand(
      'vscode.open',
      sideUri(repositoryId, { kind: 'revision', revision: target.revision, path: target.path }),
      { preview: true },
    );
  }

  async openWorkingFileAgainstRevision(
    repositoryId: string,
    request: OpenWorkingFileComparisonRequest,
  ): Promise<void> {
    const left = request.revisionExists
      ? sideUri(repositoryId, {
          kind: 'revision',
          revision: request.revision,
          path: request.path,
        })
      : sideUri(repositoryId, { kind: 'empty', path: request.path });
    request.onWillOpen?.(left);
    await vscode.commands.executeCommand(
      'vscode.diff',
      left,
      request.workingFileUri,
      `Compare: ${basename(request.path)} (${request.revisionLabel} ↔ Working Tree)`,
      { preview: true },
    );
    if (request.isCurrent && !request.isCurrent()) return;
    if (
      request.forceInline === true &&
      vscode.workspace
        .getConfiguration('diffEditor', request.workingFileUri)
        .get<boolean>('renderSideBySide', true)
    ) {
      await vscode.commands.executeCommand(
        'toggle.diff.renderSideBySide',
        request.workingFileUri,
      );
    }
  }

  async openCommit(
    repositoryId: string,
    request: { hash: string; parent: string },
    files: readonly ChangedFile[],
  ): Promise<void> {
    if (!files.length) throw new Error('This comparison has no changed files.');
    this.comparisonPanel?.dispose();
    const title = `Git Changes (${request.parent.slice(0, 8)} ↔ ${request.hash.slice(0, 8)})`;
    const panel = vscode.window.createWebviewPanel('gitLog.compare', title, vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.comparisonPanel = panel;
    panel.webview.html = createComparisonHtml({
      title,
      files,
      nonce: randomBytes(18).toString('base64url'),
    });
    const messageSubscription = panel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (
        typeof message !== 'object' ||
        message === null ||
        !('type' in message) ||
        message.type !== 'openComparisonFile' ||
        !('index' in message) ||
        !Number.isInteger(message.index)
      ) {
        return;
      }
      const file = files[message.index as number];
      if (!file || file.binary) return;
      await this.open(
        repositoryId,
        {
          hash: request.hash,
          parent: request.parent,
          path: file.path,
          ...(file.oldPath ? { oldPath: file.oldPath } : {}),
          status: file.status,
        },
        vscode.ViewColumn.Two,
      );
    });
    panel.onDidDispose(() => {
      messageSubscription.dispose();
      if (this.comparisonPanel === panel) this.comparisonPanel = undefined;
    });
  }
}
