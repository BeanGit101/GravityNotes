export interface Note {
  id: string;
  title: string;
  path: string;
  subject?: string;
  tags: string[];
  updatedAt?: string;
}

export interface NoteMetadata {
  subject?: string;
  tags: string[];
  updatedAt?: string;
}

export interface NoteDocument {
  body: string;
  metadata: NoteMetadata;
}

export interface NoteItem extends Note {
  type: "file";
}

export interface FolderItem {
  id: string;
  name: string;
  path: string;
  type: "folder";
  children: FileSystemItem[];
}

export interface TrashEntry {
  id: string;
  name: string;
  originalPath: string;
  type: "file" | "folder";
  deletedAt: number;
}

export type NoteMetadataValue =
  | string
  | number
  | boolean
  | null
  | NoteMetadataValue[]
  | { [key: string]: NoteMetadataValue };

export type NoteMetadata = Record<string, NoteMetadataValue>;

export interface TemplateItem {
  id: string;
  name: string;
  path: string;
  content: string;
}

export type TemplateApplyMode = "replace" | "prepend" | "append";

export interface NoteSearchResult {
  note: Note;
  folderPath: string | null;
  folderLabel: string;
  relativePath: string;
}

export type FileSystemItem = NoteItem | FolderItem;
