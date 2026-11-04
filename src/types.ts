export type Sequence = string | number;
export type Content = string | ArrayBuffer;
export interface Attachment { stub: true; content_type: string; length: number }
export interface FileDocument { _id: string; _rev?: string; schema: 1 | 2 | 3; path: string; content?: string; mtime: number; deleted: boolean; size?: number; hash?: string; _attachments?: {content: Attachment}; encrypted?: import('./encrypted-protocol').EncryptedRecord }
export interface Baseline { rev: string; hash: string | null }
export interface Incoming { doc: FileDocument; expected: string | null }
export interface LocalSyncState {
  version: 1; clientId: string; binding: string; initialized: boolean;
  setup?: 'upload' | 'download'; lastSequence: Sequence;
  files: Record<string, Baseline>; incoming: Record<string, Incoming>;
  rejected?: Record<string, unknown>;
}
export interface RemoteChanges { results: {seq: Sequence; id: string; doc?: unknown; deleted?: boolean}[]; last_seq: Sequence; pending?: number; sourceRows?: number }
export interface Remote {
  /** Internal protocol boundary, not user-selectable sync modes. */
  stateBinding?: string;
  ownsRecord?(id: string): boolean;
  identity?(path: string): Promise<string>;
  validateIncoming?(value: unknown): Promise<FileDocument>;
  readContent?(doc: FileDocument): Promise<Content | null>;
  writeContent?(path: string, content: Content | null, rev?: string, mtime?: number): Promise<FileDocument>;
  getAttachment(doc: FileDocument): Promise<ArrayBuffer>;
  testConnection(): Promise<void>;
  getDocument(path: string): Promise<FileDocument | null>;
  putDocument(doc: FileDocument, bytes?: ArrayBuffer): Promise<FileDocument>;
  deleteDocument(doc: FileDocument): Promise<FileDocument>;
  getChanges(since: Sequence): Promise<RemoteChanges>;
}
export interface VaultClient {
  /** Recover an interrupted binary replacement before inspecting local contents. */
  recoverIncoming?(path:string, expectedHash:string|null, preserve:(content:Content)=>Promise<void>):Promise<void>;
  listFiles(): string[] | Promise<string[]>;
  scanChanges?(): Promise<string[]>;
  modificationTime?(path: string): Promise<number | undefined>;
  read(path: string): Promise<Content | null>;
  /** A mismatch must retain changed contents, at the path or in recoverIncoming's journaled recovery file. */
  compareAndSet(path: string, expectedHash: string | null, content: Content | null, mtime?: number): Promise<boolean>;
  create(path: string, content: Content): Promise<void>;
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
