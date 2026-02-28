export interface Note {
  id: string;
  title: string;
  path: string;
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
