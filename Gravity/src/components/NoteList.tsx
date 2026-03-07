import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import type { FileSystemItem, FolderItem, Note } from "../types/notes";

interface NoteListProps {
  directoryPath: string;
  notes: FileSystemItem[];
  selectedNoteId: string | null;
  selectedFolderPath: string | null;
  onOpenVault: () => void;
  onCreateNote: (title: string) => void;
  onCreateFolder: (name: string) => void;
  onSelectFolder: (folderPath: string | null) => void;
  onSelectNote: (note: Note) => void;
  onOpenInNewPane: (note: Note) => void;
  onDeleteNote: (note: Note) => void;
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

function collectFolderPaths(items: FileSystemItem[]): Set<string> {
  const folderPaths = new Set<string>();

  const visit = (entries: FileSystemItem[]) => {
    entries.forEach((entry) => {
      if (entry.type === "folder") {
        folderPaths.add(entry.path);
        visit(entry.children);
      }
    });
  };

  visit(items);
  return folderPaths;
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

function setsEqual(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) {
    return false;
  }

  return Array.from(left).every((value) => right.has(value));
}

export function findFolderChainForNote(items: FileSystemItem[], noteId: string): string[] | null {
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

export function expandFoldersForNoteSelection(
  items: FileSystemItem[],
  expandedFolders: Set<string>,
  noteId: string | null
): Set<string> {
  if (!noteId) {
    return new Set(expandedFolders);
  }

  const chain = findFolderChainForNote(items, noteId);
  if (!chain) {
    return new Set(expandedFolders);
  }

  const next = new Set(expandedFolders);
  chain.forEach((path) => {
    next.add(path);
  });
  return next;
}

export function toggleExpandedFolder(
  expandedFolders: Set<string>,
  folderPath: string
): Set<string> {
  const next = new Set(expandedFolders);
  if (next.has(folderPath)) {
    next.delete(folderPath);
  } else {
    next.add(folderPath);
  }
  return next;
}

export function pruneExpandedFolders(
  expandedFolders: Set<string>,
  items: FileSystemItem[]
): Set<string> {
  const validPaths = collectFolderPaths(items);
  return new Set(Array.from(expandedFolders).filter((path) => validPaths.has(path)));
}

export function NoteList({
  directoryPath,
  notes,
  selectedNoteId,
  selectedFolderPath,
  onOpenVault,
  onCreateNote,
  onCreateFolder,
  onSelectFolder,
  onSelectNote,
  onOpenInNewPane,
  onDeleteNote,
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
  const lastAutoExpandedNoteIdRef = useRef<string | null>(null);
  const canCreate = Boolean(directoryPath && newTitle.trim());
  const canCreateFolder = Boolean(directoryPath && newFolderName.trim());

  const { totalNotes, folderNoteCounts } = useMemo(() => buildNotesTreeStats(notes), [notes]);
  const effectiveExpandedFolders = useMemo(
    () => pruneExpandedFolders(expandedFolders, notes),
    [expandedFolders, notes]
  );

  const selectedFolderLabel = useMemo(() => {
    if (!selectedFolderPath) {
      return "Vault root";
    }
    const match = findFolderByPath(notes, selectedFolderPath);
    return match?.name ?? "Selected folder";
  }, [notes, selectedFolderPath]);

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

  useEffect(() => {
    const prunedFolders = pruneExpandedFolders(expandedFolders, notes);
    if (setsEqual(prunedFolders, expandedFolders)) {
      return;
    }

    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        setExpandedFolders(prunedFolders);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [expandedFolders, notes]);

  useEffect(() => {
    if (!selectedNoteId) {
      lastAutoExpandedNoteIdRef.current = null;
      return;
    }

    if (lastAutoExpandedNoteIdRef.current === selectedNoteId) {
      return;
    }

    const nextExpandedFolders = expandFoldersForNoteSelection(
      notes,
      effectiveExpandedFolders,
      selectedNoteId
    );
    if (setsEqual(nextExpandedFolders, effectiveExpandedFolders)) {
      lastAutoExpandedNoteIdRef.current = selectedNoteId;
      return;
    }

    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        setExpandedFolders(nextExpandedFolders);
        lastAutoExpandedNoteIdRef.current = selectedNoteId;
      }
    });

    return () => {
      cancelled = true;
    };
  }, [effectiveExpandedFolders, notes, selectedNoteId]);

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
        const isExpanded = effectiveExpandedFolders.has(item.path);
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
                  setExpandedFolders(toggleExpandedFolder(effectiveExpandedFolders, item.path));
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
                  const next = new Set(effectiveExpandedFolders);
                  next.add(item.path);
                  setExpandedFolders(next);
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
              className="note-list__select"
              type="button"
              onClick={() => {
                const nextExpandedFolders = expandFoldersForNoteSelection(
                  notes,
                  effectiveExpandedFolders,
                  item.id
                );
                setExpandedFolders(nextExpandedFolders);
                lastAutoExpandedNoteIdRef.current = item.id;
                onSelectNote(item);
              }}
            >
              {item.title}
            </button>
            <button
              className="note-list__split"
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                const nextExpandedFolders = expandFoldersForNoteSelection(
                  notes,
                  effectiveExpandedFolders,
                  item.id
                );
                setExpandedFolders(nextExpandedFolders);
                lastAutoExpandedNoteIdRef.current = item.id;
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

      {errorMessage && <p className="note-list__error">{errorMessage}</p>}

      {directoryPath && (
        <ul className="note-list__items">
          {totalNotes === 0 && (
            <li className="note-list__empty">No notes yet. Create the first one.</li>
          )}
          {renderItems(notes)}
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
              const nextExpandedFolders = expandFoldersForNoteSelection(
                notes,
                effectiveExpandedFolders,
                contextMenu.note.id
              );
              setExpandedFolders(nextExpandedFolders);
              lastAutoExpandedNoteIdRef.current = contextMenu.note.id;
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
