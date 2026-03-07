export type NoteUpdatedSource = "frontmatter" | "filesystem";

export type NoteSortMode = "name" | "updated";

export type SortDirection = "asc" | "desc";

export type TrashItemType = "note" | "folder";

export interface Note {
  id: string;
  title: string;
  path: string;
  tags: string[];
  updatedAt: number;
  updatedAtSource: NoteUpdatedSource;
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

export interface TrashRecord {
  originalPath: string;
  trashPath: string;
  itemType: TrashItemType;
  deletedAt: number;
}

export interface SidebarPreferences {
  searchText: string;
  selectedTags: string[];
  sortMode: NoteSortMode;
  sortDirection: SortDirection;
}
