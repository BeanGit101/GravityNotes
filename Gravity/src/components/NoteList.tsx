import { useEffect, useMemo, useState, type CSSProperties, type FormEvent } from "react";
import type { FileSystemItem, FolderItem, Note } from "../types/notes";
import { normalizeTag } from "../utils/frontmatter";

interface NoteListProps {
  directoryPath: string;
  notes: FileSystemItem[];
  selectedNoteId: string | null;
  selectedFolderPath: string | null;
  availableTags: string[];
  selectedTags: string[];
  onOpenVault: () => void;
  onCreateNote: (title: string) => void;
  onCreateFolder: (name: string) => void;
  onSelectFolder: (folderPath: string | null) => void;
  onSelectNote: (note: Note) => void;
  onOpenInNewPane: (note: Note) => void;
  onDeleteNote: (note: Note) => void;
  onToggleTagFilter: (tag: string) => void;
  onClearTagFilters: () => void;
  errorMessage: string | null;
}

interface NotesTreeStats {
  totalNotes: number;
  folderNoteCounts: Map<string, number>;
}

function buildNotesTreeStats(items: FileSystemItem[]): NotesTreeStats {
  const folderNoteCounts = new Map<string, number>();

  const countInTree = (entries: FileSystemItem[]): number => {
    let total = 0;

    for (const item of entries) {
      if (item.type === "file") {
        total += 1;
        continue;
      }

      const childCount = countInTree(item.children);
      folderNoteCounts.set(item.path, childCount);
      total += childCount;
    }

    return total;
  };

  return {
    totalNotes: countInTree(items),
    folderNoteCounts,
  };
}

function findFolderByPath(items: FileSystemItem[], path: string): FolderItem | null {
  for (const item of items) {
    if (item.type === "folder") {
      if (item.path === path) {
        return item;
      }
      const match = findFolderByPath(item.children, path);
      if (match) {
        return match;
      }
    }
  }
  return null;
}

function findFolderChainForNote(items: FileSystemItem[], noteId: string): string[] | null {
  for (const item of items) {
    if (item.type === "file" && item.id === noteId) {
      return [];
    }
    if (item.type === "folder") {
      const chain = findFolderChainForNote(item.children, noteId);
      if (chain) {
        return [item.path, ...chain];
      }
    }
  }
  return null;
}

function noteMatchesSelectedTags(note: Note, selectedTags: string[]): boolean {
  if (selectedTags.length === 0) {
    return true;
  }

  const noteTags = new Set(note.tags.map((tag) => normalizeTag(tag).toLocaleLowerCase()));
  return selectedTags.every((tag) => noteTags.has(normalizeTag(tag).toLocaleLowerCase()));
}

function filterNotesTree(items: FileSystemItem[], selectedTags: string[]): FileSystemItem[] {
  const filtered: FileSystemItem[] = [];

  items.forEach((item) => {
    if (item.type === "file") {
      if (noteMatchesSelectedTags(item, selectedTags)) {
        filtered.push(item);
      }
      return;
    }

    const children = filterNotesTree(item.children, selectedTags);
    if (children.length > 0) {
      filtered.push({
        ...item,
        children,
      });
    }
  });

  return filtered;
}

export function NoteList({
  directoryPath,
  notes,
  selectedNoteId,
  selectedFolderPath,
  availableTags,
  selectedTags,
  onOpenVault,
  onCreateNote,
  onCreateFolder,
  onSelectFolder,
  onSelectNote,
  onOpenInNewPane,
  onDeleteNote,
  onToggleTagFilter,
  onClearTagFilters,
  errorMessage,
}: NoteListProps) {
  const [newTitle, setNewTitle] = useState("");
  const [newFolderName, setNewFolderName] = useState("");
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set());
  const [contextMenu, setContextMenu] = useState<{
    note: Note;
    x: number;
    y: number;
  } | null>(null);
  const canCreate = Boolean(directoryPath && newTitle.trim());
  const canCreateFolder = Boolean(directoryPath && newFolderName.trim());

  const filteredNotes = useMemo(() => filterNotesTree(notes, selectedTags), [notes, selectedTags]);
  const { totalNotes, folderNoteCounts } = useMemo(
    () => buildNotesTreeStats(filteredNotes),
    [filteredNotes]
  );

  const handleCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canCreate) return;
    onCreateNote(newTitle.trim());
    setNewTitle("");
  };

  const handleCreateFolder = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canCreateFolder) return;
    onCreateFolder(newFolderName.trim());
    setNewFolderName("");
  };

  const selectedFolderLabel = useMemo(() => {
    if (!selectedFolderPath) {
      return "Vault root";
    }
    const match = findFolderByPath(notes, selectedFolderPath);
    return match?.name ?? "Selected folder";
  }, [notes, selectedFolderPath]);

  const autoExpandedFolders = useMemo(() => {
    if (!selectedNoteId) {
      return new Set<string>();
    }
    const chain = findFolderChainForNote(filteredNotes, selectedNoteId);
    return new Set(chain ?? []);
  }, [filteredNotes, selectedNoteId]);

  const mergedExpandedFolders = useMemo(() => {
    const next = new Set(expandedFolders);
    autoExpandedFolders.forEach((path) => next.add(path));
    return next;
  }, [autoExpandedFolders, expandedFolders]);

  useEffect(() => {
    if (!contextMenu) return;

    const handleClick = () => {
      setContextMenu(null);
    };

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenu(null);
      }
    };

    window.addEventListener("click", handleClick);
    window.addEventListener("keydown", handleKey);

    return () => {
      window.removeEventListener("click", handleClick);
      window.removeEventListener("keydown", handleKey);
    };
  }, [contextMenu]);

  const renderItems = (items: FileSystemItem[], depth = 0) =>
    items.map((item) => {
      const depthStyle = { "--depth": depth } as CSSProperties;

      if (item.type === "folder") {
        const isExpanded = mergedExpandedFolders.has(item.path);
        const isSelected = selectedFolderPath === item.path;
        const noteCount = folderNoteCounts.get(item.path) ?? 0;
        const hasChildren = item.children.length > 0;

        return (
          <li key={item.id} className="note-list__item">
            <div
              className={`note-list__row note-list__row--folder ${
                isSelected ? "note-list__row--selected" : ""
              }`}
              style={depthStyle}
            >
              <button
                className="note-list__toggle"
                type="button"
                onClick={() => {
                  if (!hasChildren) return;
                  setExpandedFolders((prev) => {
                    const next = new Set(prev);
                    if (next.has(item.path)) {
                      next.delete(item.path);
                    } else {
                      next.add(item.path);
                    }
                    return next;
                  });
                }}
                aria-label={`${isExpanded ? "Collapse" : "Expand"} ${item.name}`}
                disabled={!hasChildren}
              >
                {isExpanded ? "\u25BE" : "\u25B8"}
              </button>
              <button
                className="note-list__select note-list__select--folder"
                type="button"
                onClick={() => {
                  onSelectFolder(item.path);
                  setExpandedFolders((prev) => {
                    const next = new Set(prev);
                    next.add(item.path);
                    return next;
                  });
                }}
              >
                <span className="note-list__label">{item.name}</span>
                <span className="note-list__count">
                  {noteCount} {noteCount === 1 ? "note" : "notes"}
                </span>
              </button>
            </div>
            {isExpanded && item.children.length > 0 && (
              <ul className="note-list__items note-list__items--nested">
                {renderItems(item.children, depth + 1)}
              </ul>
            )}
          </li>
        );
      }

      return (
        <li key={item.id} className="note-list__item">
          <div
            className={`note-list__row note-list__row--file ${
              selectedNoteId === item.id ? "note-list__row--active" : ""
            }`}
            style={depthStyle}
            onContextMenu={(event) => {
              event.preventDefault();
              setContextMenu({
                note: item,
                x: event.clientX,
                y: event.clientY,
              });
            }}
          >
            <button
              className="note-list__select note-list__select--file"
              type="button"
              onClick={() => {
                onSelectNote(item);
              }}
            >
              <span className="note-list__file-title">{item.title}</span>
              {(item.subject || item.tags.length > 0) && (
                <span className="note-list__file-meta">
                  {item.subject ?? item.tags.map((tag) => `#${tag}`).join(" ")}
                </span>
              )}
            </button>
            <button
              className="note-list__split"
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onOpenInNewPane(item);
              }}
              aria-label={`Open ${item.title} in a new pane`}
            >
              Split
            </button>
            <button
              className="note-list__delete"
              type="button"
              onClick={() => {
                onDeleteNote(item);
              }}
              aria-label={`Delete ${item.title}`}
            >
              Delete
            </button>
          </div>
        </li>
      );
    });

  return (
    <div className="note-list">
      <div className="note-list__header">
        <div>
          <p className="note-list__eyebrow">Vault</p>
          <h2 className="note-list__title">
            {directoryPath ? "Gravity Vault" : "No Vault Connected"}
          </h2>
          <p className="note-list__path">{directoryPath || "Choose a folder to start writing."}</p>
        </div>
        {!directoryPath && (
          <button className="button button--primary" type="button" onClick={onOpenVault}>
            Open Vault
          </button>
        )}
      </div>

      {directoryPath && (
        <form className="note-list__new" onSubmit={handleCreate}>
          <input
            className="input"
            placeholder="New note title"
            value={newTitle}
            onChange={(event) => {
              setNewTitle(event.target.value);
            }}
          />
          <button className="button button--secondary" type="submit" disabled={!canCreate}>
            New Note
          </button>
        </form>
      )}

      {directoryPath && (
        <form className="note-list__new note-list__new--secondary" onSubmit={handleCreateFolder}>
          <input
            className="input"
            placeholder="New folder name"
            value={newFolderName}
            onChange={(event) => {
              setNewFolderName(event.target.value);
            }}
          />
          <button className="button button--secondary" type="submit" disabled={!canCreateFolder}>
            New Folder
          </button>
        </form>
      )}

      {directoryPath && (
        <div className="note-list__selection">
          <span className="note-list__selection-label">New items in</span>
          <span className="note-list__selection-value">{selectedFolderLabel}</span>
          {selectedFolderPath && (
            <button
              className="note-list__link"
              type="button"
              onClick={() => {
                onSelectFolder(null);
              }}
            >
              Use vault root
            </button>
          )}
        </div>
      )}

      {directoryPath && (
        <div className="note-list__filters">
          <div className="note-list__filters-header">
            <div>
              <p className="note-list__selection-label">Filter Tags</p>
              <p className="note-list__filters-copy">All selected tags must match.</p>
            </div>
            {selectedTags.length > 0 && (
              <button className="note-list__link" type="button" onClick={onClearTagFilters}>
                Clear filters
              </button>
            )}
          </div>
          <div className="note-list__filter-tags">
            {availableTags.map((tag) => {
              const isActive = selectedTags.some(
                (selectedTag) =>
                  normalizeTag(selectedTag).toLocaleLowerCase() ===
                  normalizeTag(tag).toLocaleLowerCase()
              );

              return (
                <button
                  key={tag}
                  className={`note-list__tag-filter ${isActive ? "note-list__tag-filter--active" : ""}`}
                  type="button"
                  onClick={() => {
                    onToggleTagFilter(tag);
                  }}
                >
                  #{tag}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {errorMessage && <p className="note-list__error">{errorMessage}</p>}

      {directoryPath && (
        <ul className="note-list__items">
          {totalNotes === 0 && (
            <li className="note-list__empty">
              {selectedTags.length > 0
                ? "No notes match the selected tags."
                : "No notes yet. Create the first one."}
            </li>
          )}
          {renderItems(filteredNotes)}
        </ul>
      )}

      {contextMenu && (
        <div
          className="note-list__menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          role="menu"
        >
          <button
            className="note-list__menu-item"
            type="button"
            onClick={() => {
              onOpenInNewPane(contextMenu.note);
              setContextMenu(null);
            }}
            role="menuitem"
          >
            Open in split pane
          </button>
        </div>
      )}
    </div>
  );
}
