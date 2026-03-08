import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type FormEvent,
  type SetStateAction,
} from "react";
import { buildFilenameSearchResults } from "../services/notesService";
import { recordStartupEvent } from "../state/startupDiagnostics";
import type {
  FileSystemItem,
  FolderItem,
  Note,
  SidebarPreferences,
  TrashEntry,
} from "../types/notes";
import type { TemplateSummary } from "../types/templates";
import { normalizeNoteMetadata, normalizeTag } from "../utils/frontmatter";

const DEFAULT_SIDEBAR_PREFERENCES: SidebarPreferences = {
  searchText: "",
  selectedTags: [],
  sortMode: "updated",
  sortDirection: "desc",
};

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

interface NoteListProps {
  directoryPath: string;
  notes: FileSystemItem[];
  templates?: TemplateSummary[];
  trashEntries?: TrashEntry[];
  selectedNoteId: string | null;
  selectedFolderPath: string | null;
  sidebarPreferences?: SidebarPreferences;
  availableTags?: string[];
  selectedTags?: string[];
  onSidebarPreferencesChange?: Dispatch<SetStateAction<SidebarPreferences>>;
  onOpenVault: () => void;
  onCreateNote: (title: string, templatePath: string | null) => void;
  onRenameNote: (note: Note, title: string) => void;
  onMoveNote: (note: Note, folderPath: string | null) => void;
  onCreateFolder: (name: string) => void;
  onCreateTemplate?: (name: string) => void;
  onRenameTemplate?: (template: TemplateSummary, nextName: string) => void;
  onDeleteTemplate?: (template: TemplateSummary) => void;
  onRenameFolder: (folderPath: string, name: string) => void;
  onMoveFolder: (folderPath: string, nextFolderPath: string | null) => void;
  onDeleteFolder: (folderPath: string) => void;
  onSelectFolder: (folderPath: string | null) => void;
  onSelectNote: (note: Note) => void;
  onOpenInNewPane: (note: Note) => void;
  onDeleteNote: (note: Note) => void;
  onToggleTagFilter?: (tag: string) => void;
  onClearTagFilters?: () => void;
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

function findFolderByPath(items: FileSystemItem[], path: string | null): FolderItem | null {
  if (!path) return null;
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

function formatTemplateUpdatedAt(updatedAt: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(updatedAt);
}

function compareFolders(left: FolderItem, right: FolderItem): number {
  const byName = collator.compare(left.name, right.name);
  if (byName !== 0) {
    return byName;
  }
  return collator.compare(left.path, right.path);
}

function compareNotes(
  left: Note,
  right: Note,
  preferences: Pick<SidebarPreferences, "sortMode" | "sortDirection">
): number {
  if (preferences.sortMode === "updated") {
    const direction = preferences.sortDirection === "asc" ? 1 : -1;
    const byUpdated = (left.updatedAt - right.updatedAt) * direction;
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

function sortNotesTree(
  items: FileSystemItem[],
  preferences: Pick<SidebarPreferences, "sortMode" | "sortDirection">
): FileSystemItem[] {
  const folders: FolderItem[] = [];
  const notes: Extract<FileSystemItem, { type: "file" }>[] = [];

  items.forEach((item) => {
    if (item.type === "folder") {
      folders.push({
        ...item,
        children: sortNotesTree(item.children, preferences),
      });
    } else {
      notes.push(item);
    }
  });

  folders.sort(compareFolders);
  notes.sort((left, right) => compareNotes(left, right, preferences));

  return [...folders, ...notes];
}

function metadataFromNote(note: Pick<Note, "subject" | "tags">) {
  return normalizeNoteMetadata({
    subject: note.subject,
    tags: note.tags,
  });
}
function noteMatchesSelectedTags(note: Note, selectedTags: string[]): boolean {
  if (selectedTags.length === 0) {
    return true;
  }

  const noteTags = new Set(
    metadataFromNote(note).tags.map((tag) => normalizeTag(tag).toLocaleLowerCase())
  );
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

function toRelativePath(
  basePath: string | null | undefined,
  targetPath: string | null | undefined
): string {
  if (!targetPath) {
    return "";
  }
  if (!basePath) {
    return targetPath;
  }
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
  templates = [],
  trashEntries = [],
  selectedNoteId,
  selectedFolderPath,
  sidebarPreferences,
  availableTags = [],
  selectedTags = [],
  onSidebarPreferencesChange,
  onOpenVault,
  onCreateNote,
  onRenameNote,
  onMoveNote,
  onCreateFolder,
  onCreateTemplate = () => {},
  onRenameTemplate = () => {},
  onDeleteTemplate = () => {},
  onRenameFolder,
  onMoveFolder,
  onDeleteFolder,
  onSelectFolder,
  onSelectNote,
  onOpenInNewPane,
  onDeleteNote,
  onToggleTagFilter = () => {},
  onClearTagFilters = () => {},
  onRestoreTrashEntry,
  onPermanentlyDeleteTrashEntry,
  errorMessage,
}: NoteListProps) {
  const renderCountRef = useRef(0);
  const [newTitle, setNewTitle] = useState("");
  const [selectedTemplatePath, setSelectedTemplatePath] = useState("");
  const [newFolderName, setNewFolderName] = useState("");
  const [newTemplateName, setNewTemplateName] = useState("");
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set());
  const [editingTemplatePath, setEditingTemplatePath] = useState<string | null>(null);
  const [editingTemplateName, setEditingTemplateName] = useState("");
  const [showTrash, setShowTrash] = useState(true);
  const [contextMenu, setContextMenu] = useState<{
    target: ContextTarget;
    x: number;
    y: number;
  } | null>(null);

  const effectiveSidebarPreferences = useMemo<SidebarPreferences>(() => {
    const base = sidebarPreferences ?? {
      ...DEFAULT_SIDEBAR_PREFERENCES,
      selectedTags,
    };

    return {
      searchText: base.searchText,
      selectedTags: normalizeNoteMetadata({ tags: base.selectedTags }).tags,
      sortMode: base.sortMode,
      sortDirection: base.sortDirection,
    };
  }, [selectedTags, sidebarPreferences]);

  const updateSidebarPreferences = useCallback(
    (updater: SetStateAction<SidebarPreferences>) => {
      if (onSidebarPreferencesChange) {
        onSidebarPreferencesChange(updater);
      }
    },
    [onSidebarPreferencesChange]
  );

  const normalizedAvailableTags = useMemo(
    () => normalizeNoteMetadata({ tags: availableTags }).tags,
    [availableTags]
  );
  const normalizedSelectedTags = effectiveSidebarPreferences.selectedTags;
  const canCreate = Boolean(directoryPath && newTitle.trim());
  const canCreateFolder = Boolean(directoryPath && newFolderName.trim());
  const canCreateTemplate = Boolean(directoryPath && newTemplateName.trim());
  const canSaveTemplateRename = Boolean(editingTemplatePath && editingTemplateName.trim());
  const activeTemplatePath = templates.some((template) => template.path === selectedTemplatePath)
    ? selectedTemplatePath
    : "";
  const isContextMenuOpen = contextMenu !== null;

  const scopedNotes = useMemo(() => {
    if (!selectedFolderPath) {
      return notes;
    }

    const folder = findFolderByPath(notes, selectedFolderPath);
    return folder ? [folder] : [];
  }, [notes, selectedFolderPath]);

  const filteredNotes = useMemo(
    () => filterNotesTree(scopedNotes, normalizedSelectedTags),
    [normalizedSelectedTags, scopedNotes]
  );

  const sortedNotes = useMemo(
    () => sortNotesTree(filteredNotes, effectiveSidebarPreferences),
    [effectiveSidebarPreferences, filteredNotes]
  );

  const { totalNotes, folderNoteCounts } = useMemo(
    () => buildNotesTreeStats(sortedNotes),
    [sortedNotes]
  );

  const folderOptions = useMemo(
    () => collectFolderOptions(notes, directoryPath),
    [notes, directoryPath]
  );

  const searchResults = useMemo(
    () =>
      buildFilenameSearchResults(
        sortedNotes,
        effectiveSidebarPreferences.searchText,
        directoryPath
      ),
    [directoryPath, effectiveSidebarPreferences.searchText, sortedNotes]
  );

  const prunedExpandedFolders = useMemo(
    () => pruneExpandedFolders(expandedFolders, sortedNotes),
    [expandedFolders, sortedNotes]
  );

  const effectiveExpandedFolders = useMemo(
    () => expandFoldersForNoteSelection(sortedNotes, prunedExpandedFolders, selectedNoteId),
    [sortedNotes, prunedExpandedFolders, selectedNoteId]
  );

  const selectedFolderLabel = useMemo(() => {
    if (!selectedFolderPath) {
      return "Vault root";
    }
    const match = findFolderByPath(notes, selectedFolderPath);
    return match?.name ?? "Selected folder";
  }, [notes, selectedFolderPath]);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const handleWindowKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeContextMenu();
      }
    },
    [closeContextMenu]
  );

  const handleCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canCreate) return;
    onCreateNote(newTitle.trim(), activeTemplatePath || null);
    setNewTitle("");
  };

  const handleCreateFolder = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canCreateFolder) return;
    onCreateFolder(newFolderName.trim());
    setNewFolderName("");
  };

  const handleCreateTemplate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canCreateTemplate) return;
    onCreateTemplate(newTemplateName.trim());
    setNewTemplateName("");
  };

  useEffect(() => {
    if (!import.meta.env.DEV || import.meta.env.MODE === "test") {
      return;
    }

    renderCountRef.current += 1;
    if (renderCountRef.current > 20) {
      recordStartupEvent("notelist.render.loop.detected", {
        renderCount: renderCountRef.current,
        noteCount: notes.length,
        hasSelectedFolder: Boolean(selectedFolderPath),
        hasSelectedNote: Boolean(selectedNoteId),
      });
      console.error("NoteList render loop detected", {
        directoryPath,
        renderCount: renderCountRef.current,
        noteCount: notes.length,
        selectedFolderPath,
        selectedNoteId,
      });
    }
  });

  useEffect(() => {
    if (!isContextMenuOpen) {
      return;
    }

    window.addEventListener("click", closeContextMenu);
    window.addEventListener("keydown", handleWindowKeyDown);

    return () => {
      window.removeEventListener("click", closeContextMenu);
      window.removeEventListener("keydown", handleWindowKeyDown);
    };
  }, [closeContextMenu, handleWindowKeyDown, isContextMenuOpen]);

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

  const openNoteInSplitPane = (note: Note) => {
    onOpenInNewPane(note);
  };

  const runContextAction = (target: ContextTarget, action: string) => {
    if (target.kind === "note") {
      if (action === "split") {
        openNoteInSplitPane(target.note);
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

  const handleContextAction = (target: ContextTarget, action: string) => {
    closeContextMenu();
    window.setTimeout(() => {
      runContextAction(target, action);
    }, 0);
  };

  const handleTagToggle = (tag: string) => {
    if (onSidebarPreferencesChange) {
      updateSidebarPreferences((current) => {
        const normalized = normalizeTag(tag).toLocaleLowerCase();
        return {
          ...current,
          selectedTags: current.selectedTags.some(
            (entry) => normalizeTag(entry).toLocaleLowerCase() === normalized
          )
            ? current.selectedTags.filter(
                (entry) => normalizeTag(entry).toLocaleLowerCase() !== normalized
              )
            : [...current.selectedTags, tag],
        };
      });
      return;
    }

    onToggleTagFilter(tag);
  };

  const handleClearTagFilters = () => {
    if (onSidebarPreferencesChange) {
      updateSidebarPreferences((current) => ({
        ...current,
        selectedTags: [],
      }));
      return;
    }

    onClearTagFilters();
  };

  const handleSearchChange = (searchText: string) => {
    updateSidebarPreferences((current) => ({
      ...current,
      searchText,
    }));
  };

  const handleSortModeChange = (sortMode: SidebarPreferences["sortMode"]) => {
    updateSidebarPreferences((current) => ({
      ...current,
      sortMode,
    }));
  };

  const handleSortDirectionChange = (sortDirection: SidebarPreferences["sortDirection"]) => {
    updateSidebarPreferences((current) => ({
      ...current,
      sortDirection,
    }));
  };

  const renderNoteRow = (note: Note, depth: number, folderLabel?: string) => {
    const depthStyle = { "--depth": depth } as CSSProperties;
    const metadata = metadataFromNote(note);
    const metadataLine =
      metadata.subject || metadata.tags.length > 0
        ? [metadata.subject, metadata.tags.map((tag) => `#${tag}`).join(" ")]
            .filter(Boolean)
            .join(" | ")
        : folderLabel;

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
            className="note-list__select note-list__select--file"
            type="button"
            onClick={() => {
              onSelectNote(note);
            }}
          >
            <span className="note-list__file-title">{note.title}</span>
            {metadataLine && <span className="note-list__file-meta">{metadataLine}</span>}
          </button>
          <button
            className="note-list__split"
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              openNoteInSplitPane(note);
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
                  setExpandedFolders((current) =>
                    toggleExpandedFolder(pruneExpandedFolders(current, sortedNotes), item.path)
                  );
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
                  setExpandedFolders((current) => {
                    const prunedCurrent = pruneExpandedFolders(current, sortedNotes);
                    if (prunedCurrent.has(item.path)) {
                      return prunedCurrent;
                    }
                    const next = new Set(prunedCurrent);
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

      return renderNoteRow(item, depth);
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
          value={effectiveSidebarPreferences.searchText}
          onChange={(event) => {
            handleSearchChange(event.target.value);
          }}
        />
      )}

      {directoryPath && (
        <form className="note-list__new note-list__new--templated" onSubmit={handleCreate}>
          <input
            className="input"
            placeholder="New note title"
            value={newTitle}
            onChange={(event) => {
              setNewTitle(event.target.value);
            }}
          />
          <select
            className="input select"
            aria-label="Select template"
            value={activeTemplatePath}
            onChange={(event) => {
              setSelectedTemplatePath(event.target.value);
            }}
          >
            <option value="">No template</option>
            {templates.map((template) => (
              <option key={template.id} value={template.path}>
                {template.name}
              </option>
            ))}
          </select>
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
            {normalizedSelectedTags.length > 0 && (
              <button className="note-list__link" type="button" onClick={handleClearTagFilters}>
                Clear filters
              </button>
            )}
          </div>
          <div className="note-list__filter-tags">
            {normalizedAvailableTags.map((tag) => {
              const isActive = normalizedSelectedTags.some(
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
                    handleTagToggle(tag);
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
        <div className="note-list__filters note-list__filters--sorting">
          <div className="note-list__filters-header">
            <div>
              <p className="note-list__selection-label">Sort Notes</p>
              <p className="note-list__filters-copy">
                Folders stay alphabetical; notes use your selected order.
              </p>
            </div>
          </div>
          <div className="note-list__sort-controls">
            <label className="note-list__sort-field">
              <span className="note-list__selection-label">Sort by</span>
              <select
                className="input select"
                value={effectiveSidebarPreferences.sortMode}
                onChange={(event) => {
                  handleSortModeChange(event.target.value as SidebarPreferences["sortMode"]);
                }}
              >
                <option value="updated">Updated</option>
                <option value="name">Name</option>
              </select>
            </label>
            <label className="note-list__sort-field">
              <span className="note-list__selection-label">Direction</span>
              <select
                className="input select"
                value={effectiveSidebarPreferences.sortDirection}
                onChange={(event) => {
                  handleSortDirectionChange(
                    event.target.value as SidebarPreferences["sortDirection"]
                  );
                }}
              >
                <option value="desc">
                  {effectiveSidebarPreferences.sortMode === "updated" ? "Newest first" : "Z to A"}
                </option>
                <option value="asc">
                  {effectiveSidebarPreferences.sortMode === "updated" ? "Oldest first" : "A to Z"}
                </option>
              </select>
            </label>
          </div>
        </div>
      )}

      {directoryPath && (
        <section className="template-list">
          <div className="template-list__header">
            <div>
              <p className="note-list__eyebrow">Templates</p>
              <h3 className="note-list__title template-list__title">Reusable starts</h3>
            </div>
          </div>
          <form
            className="note-list__new note-list__new--secondary"
            onSubmit={handleCreateTemplate}
          >
            <input
              className="input"
              placeholder="New template name"
              value={newTemplateName}
              onChange={(event) => {
                setNewTemplateName(event.target.value);
              }}
            />
            <button
              className="button button--secondary"
              type="submit"
              disabled={!canCreateTemplate}
            >
              New Template
            </button>
          </form>
          {templates.length === 0 ? (
            <p className="note-list__empty">
              No templates yet. Save one from a note or create a blank starter.
            </p>
          ) : (
            <ul className="template-list__items">
              {templates.map((template) => {
                const isEditing = editingTemplatePath === template.path;
                return (
                  <li key={template.id} className="template-list__item">
                    {isEditing ? (
                      <form
                        className="template-list__editor"
                        onSubmit={(event) => {
                          event.preventDefault();
                          if (!canSaveTemplateRename) return;
                          onRenameTemplate(template, editingTemplateName.trim());
                          setEditingTemplatePath(null);
                          setEditingTemplateName("");
                        }}
                      >
                        <input
                          className="input"
                          value={editingTemplateName}
                          onChange={(event) => {
                            setEditingTemplateName(event.target.value);
                          }}
                        />
                        <button
                          className="button button--secondary"
                          type="submit"
                          disabled={!canSaveTemplateRename}
                        >
                          Save
                        </button>
                        <button
                          className="button button--secondary"
                          type="button"
                          onClick={() => {
                            setEditingTemplatePath(null);
                            setEditingTemplateName("");
                          }}
                        >
                          Cancel
                        </button>
                      </form>
                    ) : (
                      <div className="template-list__row">
                        <div>
                          <p className="template-list__name">{template.name}</p>
                          <p className="template-list__meta">
                            Updated {formatTemplateUpdatedAt(template.updatedAt)}
                          </p>
                        </div>
                        <div className="template-list__actions">
                          <button
                            className="note-list__link"
                            type="button"
                            onClick={() => {
                              setEditingTemplatePath(template.path);
                              setEditingTemplateName(template.name);
                            }}
                          >
                            Rename
                          </button>
                          <button
                            className="note-list__delete"
                            type="button"
                            onClick={() => {
                              onDeleteTemplate(template);
                              if (activeTemplatePath === template.path) {
                                setSelectedTemplatePath("");
                              }
                            }}
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {errorMessage && <p className="note-list__error">{errorMessage}</p>}

      {directoryPath && effectiveSidebarPreferences.searchText.trim() ? (
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
          <ul className="note-list__items note-list__items--scrollable">
            {totalNotes === 0 && (
              <li className="note-list__empty">
                {normalizedSelectedTags.length > 0
                  ? "No notes match the current filters."
                  : notes.length === 0
                    ? "No notes yet. Create the first one."
                    : "No notes match the current filters."}
              </li>
            )}
            {renderItems(sortedNotes)}
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
                        {toRelativePath(directoryPath, entry.originalPath) ||
                          "Original path unavailable"}
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
                  handleContextAction(contextMenu.target, "split");
                }}
                role="menuitem"
              >
                Open in split pane
              </button>
              <button
                className="note-list__menu-item"
                type="button"
                onClick={() => {
                  handleContextAction(contextMenu.target, "rename");
                }}
                role="menuitem"
              >
                Rename note
              </button>
              <button
                className="note-list__menu-item"
                type="button"
                onClick={() => {
                  handleContextAction(contextMenu.target, "move");
                }}
                role="menuitem"
              >
                Move note
              </button>
              <button
                className="note-list__menu-item"
                type="button"
                onClick={() => {
                  handleContextAction(contextMenu.target, "trash");
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
                  handleContextAction(contextMenu.target, "rename");
                }}
                role="menuitem"
              >
                Rename folder
              </button>
              <button
                className="note-list__menu-item"
                type="button"
                onClick={() => {
                  handleContextAction(contextMenu.target, "move");
                }}
                role="menuitem"
              >
                Move folder
              </button>
              <button
                className="note-list__menu-item"
                type="button"
                onClick={() => {
                  handleContextAction(contextMenu.target, "trash");
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
