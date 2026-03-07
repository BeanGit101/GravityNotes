import {
  useMemo,
  useState,
  type CSSProperties,
  type Dispatch,
  type FormEvent,
  type SetStateAction,
} from "react";
import type { FileSystemItem, SidebarPreferences, TrashRecord } from "../types/notes";
import {
  collectAvailableTags,
  collectNotes,
  findFolderByPath,
  getVisibleNoteTree,
} from "../utils/noteTree";

const DEFAULT_SIDEBAR_PREFERENCES: SidebarPreferences = {
  searchText: "",
  selectedTags: [],
  sortMode: "updated",
  sortDirection: "desc",
};

interface NoteListProps {
  directoryPath: string;
  notes: FileSystemItem[];
  trashItems?: TrashRecord[];
  selectedNoteId: string | null;
  selectedFolderPath: string | null;
  sidebarPreferences?: SidebarPreferences;
  onSidebarPreferencesChange?: Dispatch<SetStateAction<SidebarPreferences>>;
  onOpenVault: () => void;
  onCreateNote: (title: string) => void;
  onCreateFolder: (name: string) => void;
  onSelectFolder: (folderPath: string | null) => void;
  onSelectNote: (note: Extract<FileSystemItem, { type: "file" }>) => void;
  onOpenInNewPane: (note: Extract<FileSystemItem, { type: "file" }>) => void;
  onTrashNote?: (note: Extract<FileSystemItem, { type: "file" }>) => void;
  onTrashFolder?: (folderPath: string) => void;
  onRestoreTrashItem?: (record: TrashRecord) => void;
  onPermanentlyDeleteTrashItem?: (record: TrashRecord) => void;
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

function getPathLabel(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function formatDeletedAt(value: number): string {
  if (!Number.isFinite(value)) {
    return "Unknown time";
  }
  return new Date(value).toLocaleString();
}

export function NoteList({
  directoryPath,
  notes,
  trashItems = [],
  selectedNoteId,
  selectedFolderPath,
  sidebarPreferences = DEFAULT_SIDEBAR_PREFERENCES,
  onSidebarPreferencesChange = (() => undefined) as Dispatch<SetStateAction<SidebarPreferences>>,
  onOpenVault,
  onCreateNote,
  onCreateFolder,
  onSelectFolder,
  onSelectNote,
  onOpenInNewPane,
  onTrashNote = () => undefined,
  onTrashFolder = () => undefined,
  onRestoreTrashItem = () => undefined,
  onPermanentlyDeleteTrashItem = () => undefined,
  errorMessage,
}: NoteListProps) {
  const [newTitle, setNewTitle] = useState("");
  const [newFolderName, setNewFolderName] = useState("");
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set());
  const canCreate = Boolean(directoryPath && newTitle.trim());
  const canCreateFolder = Boolean(directoryPath && newFolderName.trim());
  const availableTags = useMemo(() => collectAvailableTags(notes), [notes]);
  const visibleItems = useMemo(
    () => getVisibleNoteTree(notes, sidebarPreferences, selectedFolderPath),
    [notes, selectedFolderPath, sidebarPreferences]
  );
  const visibleNotes = useMemo(() => collectNotes(visibleItems), [visibleItems]);
  const { totalNotes, folderNoteCounts } = useMemo(
    () => buildNotesTreeStats(visibleItems),
    [visibleItems]
  );

  const handleCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canCreate) {
      return;
    }
    onCreateNote(newTitle.trim());
    setNewTitle("");
  };

  const handleCreateFolder = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canCreateFolder) {
      return;
    }
    onCreateFolder(newFolderName.trim());
    setNewFolderName("");
  };

  const handleSearchSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const firstVisibleNote = visibleNotes[0];
    if (firstVisibleNote) {
      onSelectNote(firstVisibleNote);
    }
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
    const chain = findFolderChainForNote(visibleItems, selectedNoteId);
    return new Set(chain ?? []);
  }, [selectedNoteId, visibleItems]);

  const mergedExpandedFolders = useMemo(() => {
    const next = new Set(expandedFolders);
    autoExpandedFolders.forEach((path) => next.add(path));
    return next;
  }, [autoExpandedFolders, expandedFolders]);

  const sortDirectionLabel =
    sidebarPreferences.sortMode === "updated"
      ? sidebarPreferences.sortDirection === "desc"
        ? "Newest first"
        : "Oldest first"
      : sidebarPreferences.sortDirection === "asc"
        ? "A to Z"
        : "Z to A";

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
                  if (!hasChildren) {
                    return;
                  }
                  setExpandedFolders((previous) => {
                    const next = new Set(previous);
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
                  setExpandedFolders((previous) => {
                    const next = new Set(previous);
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
              <button
                className="note-list__action note-list__action--danger"
                type="button"
                onClick={() => {
                  onTrashFolder(item.path);
                }}
              >
                Trash
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
          >
            <button
              className="note-list__select"
              type="button"
              onClick={() => {
                onSelectNote(item);
              }}
            >
              <span className="note-list__note-title">{item.title}</span>
              <span className="note-list__note-meta">
                {Number.isFinite(item.updatedAt)
                  ? new Date(item.updatedAt).toLocaleString()
                  : "Unknown update"}
              </span>
            </button>
            <button
              className="note-list__action"
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
              className="note-list__action note-list__action--danger"
              type="button"
              onClick={() => {
                onTrashNote(item);
              }}
              aria-label={`Move ${item.title} to trash`}
            >
              Trash
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
        <form className="note-list__search" onSubmit={handleSearchSubmit}>
          <input
            className="input"
            placeholder="Search filenames"
            value={sidebarPreferences.searchText}
            onChange={(event) => {
              const searchText = event.target.value;
              onSidebarPreferencesChange((current) => ({ ...current, searchText }));
            }}
          />
          <button
            className="button button--secondary"
            type="submit"
            disabled={visibleNotes.length === 0}
          >
            Open Match
          </button>
        </form>
      )}

      {directoryPath && (
        <div className="note-list__controls">
          <label className="note-list__sort">
            <span className="note-list__control-label">Sort</span>
            <select
              className="input note-list__select-input"
              value={sidebarPreferences.sortMode}
              onChange={(event) => {
                const sortMode = event.target.value as SidebarPreferences["sortMode"];
                onSidebarPreferencesChange((current) => ({ ...current, sortMode }));
              }}
            >
              <option value="updated">Updated</option>
              <option value="name">Name</option>
            </select>
          </label>
          <button
            className="button button--secondary note-list__direction"
            type="button"
            onClick={() => {
              onSidebarPreferencesChange((current) => ({
                ...current,
                sortDirection: current.sortDirection === "asc" ? "desc" : "asc",
              }));
            }}
          >
            {sortDirectionLabel}
          </button>
          {(sidebarPreferences.searchText || sidebarPreferences.selectedTags.length > 0) && (
            <button
              className="note-list__link"
              type="button"
              onClick={() => {
                onSidebarPreferencesChange((current) => ({
                  ...current,
                  searchText: "",
                  selectedTags: [],
                }));
              }}
            >
              Clear filters
            </button>
          )}
        </div>
      )}

      {directoryPath && availableTags.length > 0 && (
        <div className="note-list__tags">
          <span className="note-list__control-label">Tags</span>
          <div className="note-list__tag-chips">
            {availableTags.map((tag) => {
              const isSelected = sidebarPreferences.selectedTags.some(
                (selectedTag) => selectedTag.toLowerCase() === tag.toLowerCase()
              );
              return (
                <button
                  key={tag}
                  className={`note-list__tag ${isSelected ? "note-list__tag--selected" : ""}`}
                  type="button"
                  onClick={() => {
                    onSidebarPreferencesChange((current) => ({
                      ...current,
                      selectedTags: isSelected
                        ? current.selectedTags.filter(
                            (selectedTag) => selectedTag.toLowerCase() !== tag.toLowerCase()
                          )
                        : [...current.selectedTags, tag],
                    }));
                  }}
                >
                  #{tag}
                </button>
              );
            })}
          </div>
        </div>
      )}

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
          <span className="note-list__selection-label">Browsing</span>
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

      {errorMessage && <p className="note-list__error">{errorMessage}</p>}

      {directoryPath && (
        <ul className="note-list__items note-list__items--scrollable">
          {totalNotes === 0 && (
            <li className="note-list__empty">
              {notes.length === 0
                ? "No notes yet. Create the first one."
                : "No notes match the current filters."}
            </li>
          )}
          {renderItems(visibleItems)}
        </ul>
      )}

      {directoryPath && (
        <section className="note-list__trash">
          <div className="note-list__section-header">
            <div>
              <p className="note-list__eyebrow">Trash</p>
              <h3 className="note-list__section-title">Deleted Items</h3>
            </div>
            <span className="note-list__count">{trashItems.length}</span>
          </div>
          {trashItems.length === 0 ? (
            <p className="note-list__empty">Trash is empty.</p>
          ) : (
            <ul className="note-list__trash-items">
              {trashItems.map((record) => (
                <li key={record.trashPath} className="note-list__trash-item">
                  <div>
                    <p className="note-list__trash-name">{getPathLabel(record.originalPath)}</p>
                    <p className="note-list__trash-meta">
                      {record.itemType} � deleted {formatDeletedAt(record.deletedAt)}
                    </p>
                  </div>
                  <div className="note-list__trash-actions">
                    <button
                      className="note-list__action"
                      type="button"
                      onClick={() => {
                        onRestoreTrashItem(record);
                      }}
                    >
                      Restore
                    </button>
                    <button
                      className="note-list__action note-list__action--danger"
                      type="button"
                      onClick={() => {
                        onPermanentlyDeleteTrashItem(record);
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
