import { useEffect, useMemo, useState, type CSSProperties, type FormEvent } from "react";
import type { FileSystemItem, FolderItem, Note } from "../types/notes";
import type { TemplateSummary } from "../types/templates";

interface NoteListProps {
  directoryPath: string;
  notes: FileSystemItem[];
  templates: TemplateSummary[];
  selectedNoteId: string | null;
  selectedFolderPath: string | null;
  onOpenVault: () => void;
  onCreateNote: (title: string, templatePath: string | null) => void;
  onCreateFolder: (name: string) => void;
  onCreateTemplate: (name: string) => void;
  onRenameTemplate: (template: TemplateSummary, nextName: string) => void;
  onDeleteTemplate: (template: TemplateSummary) => void;
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

function formatTemplateUpdatedAt(updatedAt: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(updatedAt);
}

export function NoteList({
  directoryPath,
  notes,
  templates,
  selectedNoteId,
  selectedFolderPath,
  onOpenVault,
  onCreateNote,
  onCreateFolder,
  onCreateTemplate,
  onRenameTemplate,
  onDeleteTemplate,
  onSelectFolder,
  onSelectNote,
  onOpenInNewPane,
  onDeleteNote,
  errorMessage,
}: NoteListProps) {
  const [newTitle, setNewTitle] = useState("");
  const [selectedTemplatePath, setSelectedTemplatePath] = useState<string>("");
  const [newFolderName, setNewFolderName] = useState("");
  const [newTemplateName, setNewTemplateName] = useState("");
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set());
  const [editingTemplatePath, setEditingTemplatePath] = useState<string | null>(null);
  const [editingTemplateName, setEditingTemplateName] = useState("");
  const [contextMenu, setContextMenu] = useState<{
    note: Note;
    x: number;
    y: number;
  } | null>(null);
  const canCreate = Boolean(directoryPath && newTitle.trim());
  const canCreateFolder = Boolean(directoryPath && newFolderName.trim());
  const canCreateTemplate = Boolean(directoryPath && newTemplateName.trim());
  const canSaveTemplateRename = Boolean(editingTemplatePath && editingTemplateName.trim());

  const { totalNotes, folderNoteCounts } = useMemo(() => buildNotesTreeStats(notes), [notes]);
  const activeTemplatePath = templates.some((template) => template.path === selectedTemplatePath)
    ? selectedTemplatePath
    : "";

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
    const chain = findFolderChainForNote(notes, selectedNoteId);
    return new Set(chain ?? []);
  }, [notes, selectedNoteId]);

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
              className="note-list__select"
              type="button"
              onClick={() => {
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
