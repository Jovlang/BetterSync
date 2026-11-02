export type Sequence = string | number;
export interface FileDocument { _id: string; _rev?: string; schema: 1 | 2; path: string; content: string; mtime: number; deleted: boolean }
export interface Baseline { rev: string; hash: string | null }
export interface Incoming { doc: FileDocument; expected: string | null }
export interface LocalSyncState {
  version: 1; clientId: string; binding: string; initialized: boolean;
  setup?: 'upload' | 'download'; lastSequence: Sequence;
  files: Record<string, Baseline>; incoming: Record<string, Incoming>;
  rejected?: Record<string, unknown>;
}
export interface RemoteChanges { results: {seq: Sequence; id: string; doc?: unknown; deleted?: boolean}[]; last_seq: Sequence; pending?: number }
export interface Remote {
  testConnection(): Promise<void>;
  getDocument(path: string): Promise<FileDocument | null>;
  putDocument(doc: FileDocument): Promise<FileDocument>;
  deleteDocument(doc: FileDocument): Promise<FileDocument>;
  getChanges(since: Sequence): Promise<RemoteChanges>;
}
export interface VaultClient {
  /** Recover an interrupted binary replacement before inspecting local contents. */
  recoverIncoming?(path:string, expectedHash:string|null, preserve:(content:string)=>Promise<void>):Promise<void>;
  listFiles(): string[] | Promise<string[]>;
  scanChanges?(): Promise<string[]>;
  read(path: string): Promise<string | null>;
  /** A mismatch must retain changed contents, at the path or in recoverIncoming's journaled recovery file. */
  compareAndSet(path: string, expectedHash: string | null, content: string | null): Promise<boolean>;
  create(path: string, content: string): Promise<void>;
}
export type SyncStatus = 'Synced' | 'Syncing…' | 'Offline' | 'Conflict' | 'Sync error';
export type SetupChoice = 'upload' | 'download' | 'cancel';
export interface EngineUI {
  status(status: SyncStatus): void;
  notice(message: string): void;
  confirm(direction: 'upload' | 'download'): Promise<SetupChoice>;
  log(event: string, path?: string): void;
}
export class SyncFailure extends Error {
  constructor(public kind: 'temporary' | 'configuration' | 'conflict' | 'data', message: string) { super(message); }
}
