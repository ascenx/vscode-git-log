export type RepositoryId = string;
export type CommitHash = string;

export type RefKind = 'head' | 'local' | 'remote' | 'tag';
export type SignatureStatus = 'good' | 'bad' | 'unknown' | 'expired' | 'revoked' | 'error' | 'none';
export type GitOperationState = 'merge' | 'rebase' | 'cherry-pick' | 'revert';

export interface RefLabel {
  fullName: string;
  shortName: string;
  kind: RefKind;
  target: CommitHash;
  ahead: number;
  behind: number;
  isCurrent: boolean;
  remote?: string;
  upstream?: string;
}

export interface CommitSummary {
  hash: CommitHash;
  parents: CommitHash[];
  subject: string;
  authorName: string;
  authorEmail: string;
  authorTime: number;
  commitTime: number;
  refs: RefLabel[];
}

export interface CommitDetails extends CommitSummary {
  body: string;
  committerName: string;
  committerEmail: string;
  signature: SignatureStatus;
}

export interface RepositorySummary {
  id: RepositoryId;
  rootUri: string;
  gitDirUri: string;
  commonGitDirUri?: string;
  displayName: string;
  isBare: boolean;
  currentBranch?: string;
  head?: CommitHash;
  userName?: string;
  userEmail?: string;
  operationState?: GitOperationState;
}

export type ChangedFileStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U';

export interface ChangedFile {
  status: ChangedFileStatus;
  path: string;
  oldPath?: string;
  additions?: number;
  deletions?: number;
  binary: boolean;
  commitHash?: CommitHash;
  parentHash?: CommitHash;
}

export interface HistoryEntry extends CommitSummary {
  path: string;
  oldPath?: string;
  additions?: number;
  deletions?: number;
  binary: boolean;
  oldStartLine?: number;
  oldLineCount?: number;
  newStartLine?: number;
  newLineCount?: number;
}

export type EditorHistoryKind = 'line' | 'file';

export interface EditorHistoryRequest {
  kind: EditorHistoryKind;
  lineScope?: 'current' | 'selection';
  repository: RepositorySummary;
  path: string;
  startLine?: number;
  endLine?: number;
  workingContent?: string;
}
