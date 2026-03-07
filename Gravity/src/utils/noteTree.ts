import type { FileSystemItem, FolderItem, NoteItem, SidebarPreferences } from "../types/notes";

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

function normalizePath(path: string): string {
  return path
    .replace(/[\\/]+/g, "/")
    .replace(/\/$/, "")
    .toLowerCase();
}

function getRuntimeTags(note: { tags?: unknown }): string[] {
  return Array.isArray(note.tags)
    ? note.tags.filter((tag): tag is string => typeof tag === "string")
    : [];
}

function getRuntimeUpdatedAt(note: { updatedAt?: unknown }): number {
  return typeof note.updatedAt === "number" && Number.isFinite(note.updatedAt) ? note.updatedAt : 0;
}

function compareFolders(left: FolderItem, right: FolderItem): number {
  const byName = collator.compare(left.name, right.name);
  if (byName !== 0) {
    return byName;
  }
  return collator.compare(left.path, right.path);
}

function compareNotes(
  left: NoteItem,
  right: NoteItem,
  preferences: Pick<SidebarPreferences, "sortDirection" | "sortMode">
): number {
  if (preferences.sortMode === "updated") {
    const direction = preferences.sortDirection === "asc" ? 1 : -1;
    const byUpdated = (getRuntimeUpdatedAt(left) - getRuntimeUpdatedAt(right)) * direction;
    if (byUpdated !== 0) {
      return byUpdated;
    }

    const byName = collator.compare(left.title, right.title);
    if (byName !== 0) {
      return byName;
    }

    return collator.compare(left.path, right.path);
  }

  const direction = preferences.sortDirection === "asc" ? 1 : -1;
  const byName = collator.compare(left.title, right.title) * direction;
  if (byName !== 0) {
    return byName;
  }

  return collator.compare(left.path, right.path) * direction;
}

function matchesSearch(note: NoteItem, searchText: string): boolean {
  if (!searchText) {
    return true;
  }

  const normalizedQuery = searchText.trim().toLowerCase();
  if (!normalizedQuery) {
    return true;
  }

  return (
    note.title.toLowerCase().includes(normalizedQuery) ||
    note.path.toLowerCase().includes(normalizedQuery)
  );
}

function matchesTags(note: NoteItem, selectedTags: string[]): boolean {
  if (selectedTags.length === 0) {
    return true;
  }

  const noteTags = new Set(getRuntimeTags(note).map((tag) => tag.toLowerCase()));
  return selectedTags.every((tag) => noteTags.has(tag.toLowerCase()));
}

function filterTree(items: FileSystemItem[], preferences: SidebarPreferences): FileSystemItem[] {
  const folders: FolderItem[] = [];
  const notes: NoteItem[] = [];

  items.forEach((item) => {
    if (item.type === "folder") {
      const children = filterTree(item.children, preferences);
      if (children.length > 0) {
        folders.push({ ...item, children });
      }
      return;
    }

    if (
      matchesSearch(item, preferences.searchText) &&
      matchesTags(item, preferences.selectedTags)
    ) {
      notes.push(item);
    }
  });

  folders.sort(compareFolders);
  notes.sort((left, right) => compareNotes(left, right, preferences));

  return [...folders, ...notes];
}

export function isPathWithinFolder(folderPath: string, entryPath: string): boolean {
  const normalizedFolder = normalizePath(folderPath);
  const normalizedEntry = normalizePath(entryPath);
  return normalizedEntry === normalizedFolder || normalizedEntry.startsWith(`${normalizedFolder}/`);
}

export function findFolderByPath(items: FileSystemItem[], path: string): FolderItem | null {
  for (const item of items) {
    if (item.type !== "folder") {
      continue;
    }

    if (item.path === path) {
      return item;
    }

    const nested = findFolderByPath(item.children, path);
    if (nested) {
      return nested;
    }
  }

  return null;
}

export function collectNotes(items: FileSystemItem[]): NoteItem[] {
  const notes: NoteItem[] = [];

  const visit = (entries: FileSystemItem[]) => {
    entries.forEach((entry) => {
      if (entry.type === "file") {
        notes.push(entry);
        return;
      }

      visit(entry.children);
    });
  };

  visit(items);
  return notes;
}

export function collectAvailableTags(items: FileSystemItem[]): string[] {
  const tagsByKey = new Map<string, string>();

  collectNotes(items).forEach((note) => {
    getRuntimeTags(note).forEach((tag) => {
      const key = tag.toLowerCase();
      if (!tagsByKey.has(key)) {
        tagsByKey.set(key, tag);
      }
    });
  });

  return [...tagsByKey.values()].sort((left, right) => collator.compare(left, right));
}

export function getVisibleNoteTree(
  items: FileSystemItem[],
  preferences: SidebarPreferences,
  selectedFolderPath: string | null
): FileSystemItem[] {
  const scopedItems = selectedFolderPath
    ? (() => {
        const folder = findFolderByPath(items, selectedFolderPath);
        return folder ? [folder] : [];
      })()
    : items;

  return filterTree(scopedItems, preferences);
}
