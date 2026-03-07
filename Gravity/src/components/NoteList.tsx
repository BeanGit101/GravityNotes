import { useEffect, useMemo, useState, type CSSProperties, type FormEvent } from "react";
import { buildFilenameSearchResults } from "../services/notesService";
import type { FileSystemItem, FolderItem, Note, TrashEntry } from "../types/notes";

interface NoteListProps {
  directoryPath: string;
  notes: FileSystemItem[];
  trashEntries: TrashEntry[];
  selectedNoteId: string | null;
  selectedFolderPath: string | null;
  onOpenVault: () => void;
  onCreateNote: (title: string) => void;
  onRenameNote: (note: Note, title: string) => void;
  onMoveNote: (note: Note, folderPath: string | null) => void;
  onCreateFolder: (name: string) => void;
  onRenameFolder: (folderPath: string, name: string) => void;
  onMoveFolder: (folderPath: string, nextFolderPath: string | null) => void;
  onDeleteFolder: (folderPath: string) => void;
  onSelectFolder: (folderPath: string | null) => void;
  onSelectNote: (note: Note) => void;
  onOpenInNewPane: (note: Note) => void;
  onDeleteNote: (note: Note) => void;
  onRestoreTrashEntry: (entry: TrashEntry) => void;
  onPermanentlyDeleteTrashEntry: (entry: TrashEntry) => void;
  errorMessage: string | null;
}

interface NotesTreeStats {
  totalNotes: number;
  folderNoteCounts: Map<string, number>;
}

interface FolderOption {
  label: string;
  path: string | null;
}

type ContextTarget = { kind: "note"; note: Note } | { kind: "folder"; folder: FolderItem };

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

function toRelativePath(basePath: string, targetPath: string): string {
  if (!targetPath.startsWith(basePath)) {
    return targetPath;
  }
  return targetPath.slice(basePath.length).replace(/^[\\/]+/, "") || targetPath;
}

function collectFolderOptions(items: FileSystemItem[], basePath: string): FolderOption[] {
  const folders: FolderOption[] = [{ label: "Vault root", path: null }];

  const visit = (entries: FileSystemItem[]) => {
    entries.forEach((entry) => {
      if (entry.type !== "folder") {
        return;
      }

      folders.push({
        label: toRelativePath(basePath, entry.path),
        path: entry.path,
      });
      visit(entry.children);
    });
  };

  visit(items);
  return folders;
}

function isPathWithin(path: string | null, ancestorPath: string): boolean {
  if (!path) {
    return false;
  }
  return (
    path === ancestorPath ||
    path.startsWith(`${ancestorPath}\\`) ||
    path.startsWith(`${ancestorPath}/`)
  );
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
  trashEntries,
  selectedNoteId,
  selectedFolderPath,
  onOpenVault,
  onCreateNote,
  onRenameNote,
  onMoveNote,
  onCreateFolder,
  onRenameFolder,
  onMoveFolder,
  onDeleteFolder,
  onSelectFolder,
  onSelectNote,
  onOpenInNewPane,
  onDeleteNote,
  onRestoreTrashEntry,
  onPermanentlyDeleteTrashEntry,
  errorMessage,
}: NoteListProps) {
  const [newTitle, setNewTitle] = useState("");
  const [newFolderName, setNewFolderName] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set());
  const [showTrash, setShowTrash] = useState(true);
  const [contextMenu, setContextMenu] = useState<{
    target: ContextTarget;
    x: number;
    y: number;
  } | null>(null);
  const lastAutoExpandedNoteIdRef = useRef<string | null>(null);
  const canCreate = Boolean(directoryPath && newTitle.trim());
  const canCreateFolder = Boolean(directoryPath && newFolderName.trim());

  const { totalNotes, folderNoteCounts } = useMemo(() => buildNotesTreeStats(notes), [notes]);
  const folderOptions = useMemo(
    () => collectFolderOptions(notes, directoryPath),
    [notes, directoryPath]
  );
  const searchResults = useMemo(
    () => buildFilenameSearchResults(notes, searchQuery, directoryPath),
    [directoryPath, notes, searchQuery]
  );
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
    const match = findFolderByPath(notes, selectedFolderPath);
    return match ? toRelativePath(directoryPath, match.path) : "Selected folder";
  }, [directoryPath, notes, selectedFolderPath]);

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

  const mergedExpandedFolders = useMemo(() => {
    const available = new Set(
      folderOptions.map((option) => option.path).filter(Boolean) as string[]
    );
    const next = new Set<string>();
    expandedFolders.forEach((path) => {
      if (available.has(path)) {
        next.add(path);
      }
    });
    autoExpandedFolders.forEach((path) => next.add(path));
    return next;
  }, [autoExpandedFolders, expandedFolders, folderOptions]);

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

  const promptForFolderDestination = (
    title: string,
    options: FolderOption[]
  ): string | null | undefined => {
    const message = [
      `${title}.`,
      "Leave the input empty to use the vault root.",
      "Available folders:",
      ...options.map((option) => `- ${option.label}`),
    ].join("\n");
    const value = window.prompt(message, "");
    if (value === null) {
      return undefined;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    const normalized = trimmed.toLowerCase();
    const match = options.find((option) => option.label.toLowerCase() === normalized);
    if (!match) {
      window.alert(
        "Choose one of the listed folder paths exactly, or leave the field empty for the vault root."
      );
      return undefined;
    }

    return match.path;
  };

  const runContextAction = (target: ContextTarget, action: string) => {
    if (target.kind === "note") {
      if (action === "split") {
        onOpenInNewPane(target.note);
        return;
      }
      if (action === "rename") {
        const nextTitle = window.prompt("Rename note", target.note.title)?.trim();
        if (nextTitle) {
          onRenameNote(target.note, nextTitle);
        }
        return;
      }
      if (action === "move") {
        const nextFolder = promptForFolderDestination("Move note to folder", folderOptions);
        if (nextFolder !== undefined) {
          onMoveNote(target.note, nextFolder);
        }
        return;
      }
      if (action === "trash") {
        onDeleteNote(target.note);
      }
      return;
    }

    if (action === "rename") {
      const nextName = window.prompt("Rename folder", target.folder.name)?.trim();
      if (nextName) {
        onRenameFolder(target.folder.path, nextName);
      }
      return;
    }
    if (action === "move") {
      const nextFolder = promptForFolderDestination(
        "Move folder to folder",
        folderOptions.filter((option) => !isPathWithin(option.path, target.folder.path))
      );
      if (nextFolder !== undefined) {
        onMoveFolder(target.folder.path, nextFolder);
      }
      return;
    }
    if (action === "trash") {
      onDeleteFolder(target.folder.path);
    }
  };

  const renderNoteRow = (note: Note, depth: number, folderLabel?: string) => {
    const depthStyle = { "--depth": depth } as CSSProperties;
    return (
      <li key={note.id} className="note-list__item">
        <div
          className={`note-list__row note-list__row--file ${
            selectedNoteId === note.id ? "note-list__row--active" : ""
          }`}
          style={depthStyle}
          onContextMenu={(event) => {
            event.preventDefault();
            setContextMenu({
              target: { kind: "note", note },
              x: event.clientX,
              y: event.clientY,
            });
          }}
        >
          <button
            className="note-list__select"
            type="button"
            onClick={() => {
              onSelectNote(note);
            }}
          >
            <span className="note-list__title-line">{note.title}</span>
            {folderLabel && <span className="note-list__subtle">{folderLabel}</span>}
          </button>
          <button
            className="note-list__split"
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onOpenInNewPane(note);
            }}
            aria-label={`Open ${note.title} in a new pane`}
          >
            Split
          </button>
          <button
            className="note-list__more"
            type="button"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setContextMenu({
                target: { kind: "note", note },
                x: rect.left,
                y: rect.bottom + 4,
              });
            }}
            aria-label={`Open actions for ${note.title}`}
          >
            ...
          </button>
        </div>
      </li>
    );
  };

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
              onContextMenu={(event) => {
                event.preventDefault();
                setContextMenu({
                  target: { kind: "folder", folder: item },
                  x: event.clientX,
                  y: event.clientY,
                });
              }}
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
              <button
                className="note-list__more"
                type="button"
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  setContextMenu({
                    target: { kind: "folder", folder: item },
                    x: rect.left,
                    y: rect.bottom + 4,
                  });
                }}
                aria-label={`Open actions for folder ${item.name}`}
              >
                ...
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
        <input
          className="input"
          placeholder="Search filenames"
          value={searchQuery}
          onChange={(event) => {
            setSearchQuery(event.target.value);
          }}
        />
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

      {directoryPath && searchQuery.trim() ? (
        <div className="note-list__results">
          <p className="note-list__section-label">Search Results</p>
          <ul className="note-list__items">
            {searchResults.length === 0 ? (
              <li className="note-list__empty">No filenames match that search.</li>
            ) : (
              searchResults.map((result) =>
                renderNoteRow(
                  result.note,
                  0,
                  result.folderLabel === "Vault root" ? undefined : result.folderLabel
                )
              )
            )}
          </ul>
        </div>
      ) : (
        directoryPath && (
          <ul className="note-list__items">
            {totalNotes === 0 && (
              <li className="note-list__empty">No notes yet. Create the first one.</li>
            )}
            {renderItems(notes)}
          </ul>
        )
      )}

      {directoryPath && (
        <section className="note-list__trash">
          <button
            className="note-list__trash-toggle"
            type="button"
            onClick={() => {
              setShowTrash((current) => !current);
            }}
          >
            <span>Trash</span>
            <span>{trashEntries.length}</span>
          </button>
          {showTrash && (
            <ul className="note-list__trash-items">
              {trashEntries.length === 0 ? (
                <li className="note-list__empty">Trash is empty.</li>
              ) : (
                trashEntries.map((entry) => (
                  <li key={entry.id} className="note-list__trash-item">
                    <div>
                      <p className="note-list__trash-name">{entry.name}</p>
                      <p className="note-list__subtle">
                        {toRelativePath(directoryPath, entry.originalPath)}
                      </p>
                    </div>
                    <div className="note-list__trash-actions">
                      <button
                        className="note-list__link"
                        type="button"
                        onClick={() => {
                          onRestoreTrashEntry(entry);
                        }}
                      >
                        Restore
                      </button>
                      <button
                        className="note-list__delete"
                        type="button"
                        onClick={() => {
                          onPermanentlyDeleteTrashEntry(entry);
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </li>
                ))
              )}
            </ul>
          )}
        </section>
      )}

      {contextMenu && (
        <div
          className="note-list__menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          role="menu"
        >
          {contextMenu.target.kind === "note" ? (
            <>
              <button
                className="note-list__menu-item"
                type="button"
                onClick={() => {
                  runContextAction(contextMenu.target, "split");
                }}
                role="menuitem"
              >
                Open in split pane
              </button>
              <button
                className="note-list__menu-item"
                type="button"
                onClick={() => {
                  runContextAction(contextMenu.target, "rename");
                }}
                role="menuitem"
              >
                Rename note
              </button>
              <button
                className="note-list__menu-item"
                type="button"
                onClick={() => {
                  runContextAction(contextMenu.target, "move");
                }}
                role="menuitem"
              >
                Move note
              </button>
              <button
                className="note-list__menu-item"
                type="button"
                onClick={() => {
                  runContextAction(contextMenu.target, "trash");
                }}
                role="menuitem"
              >
                Move to trash
              </button>
            </>
          ) : (
            <>
              <button
                className="note-list__menu-item"
                type="button"
                onClick={() => {
                  runContextAction(contextMenu.target, "rename");
                }}
                role="menuitem"
              >
                Rename folder
              </button>
              <button
                className="note-list__menu-item"
                type="button"
                onClick={() => {
                  runContextAction(contextMenu.target, "move");
                }}
                role="menuitem"
              >
                Move folder
              </button>
              <button
                className="note-list__menu-item"
                type="button"
                onClick={() => {
                  runContextAction(contextMenu.target, "trash");
                }}
                role="menuitem"
              >
                Move to trash
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
