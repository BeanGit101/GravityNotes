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

export type FileSystemItem = NoteItem | FolderItem;
