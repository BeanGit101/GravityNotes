export type NoteUpdatedSource = "frontmatter" | "filesystem";

export type NoteSortMode = "name" | "updated";

export type SortDirection = "asc" | "desc";

export type TrashItemType = "file" | "folder";

export interface Note {
  id: string;
  title: string;
  path: string;
  subject?: string;
  tags: string[];
  updatedAt: number;
  updatedAtSource: NoteUpdatedSource;
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
  type: TrashItemType;
  deletedAt: number;
}

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

export interface SidebarPreferences {
  searchText: string;
  selectedTags: string[];
  sortMode: NoteSortMode;
  sortDirection: SortDirection;
}
