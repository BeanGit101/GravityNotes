import type { MouseEvent } from "react";
import type { NoteViewMode } from "../types/editor";
import type { Note, NoteDocument, NoteMetadata } from "../types/notes";
import { NoteEditor } from "./NoteEditor";

interface EditorPaneProps {
  note: Note | null;
  value: string;
  isActive: boolean;
  isLoading: boolean;
  viewMode: NoteViewMode;
  availableTags: string[];
  onFocus: () => void;
  onClose: () => void;
  onToggleViewMode: () => void;
  onCreateTemplateFromNote: (note: Note, value: string) => void;
  onChange: (value: string) => void;
  onMetadataChange: (metadata: NoteMetadata) => void;
  onAutoSave: (value: NoteDocument) => Promise<void>;
}

export function EditorPane({
  note,
  value,
  isActive,
  isLoading,
  viewMode,
  availableTags,
  onFocus,
  onClose,
  onToggleViewMode,
  onCreateTemplateFromNote,
  onChange,
  onMetadataChange,
  onAutoSave,
}: EditorPaneProps) {
  const handleClose = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onClose();
  };

  const handleToggleViewMode = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onToggleViewMode();
  };

  const handleCreateTemplate = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!note || isLoading) {
      return;
    }
    onCreateTemplateFromNote(note, value);
  };

  return (
    <div
      className={`editor-pane ${isActive ? "editor-pane--active" : ""}`}
      onPointerDown={onFocus}
      role="presentation"
    >
      <NoteEditor
        note={note ? { id: note.id, title: note.title, path: note.path } : null}
        metadata={
          note
            ? {
                subject: note.subject,
                tags: note.tags,
              }
            : undefined
        }
        value={value}
        availableTags={availableTags}
        onChange={onChange}
        onMetadataChange={onMetadataChange}
        onAutoSave={onAutoSave}
        isActive={isActive}
        isLoading={isLoading}
        viewMode={viewMode}
        toolbarActions={
          <>
            <button
              className="button button--secondary editor-pane__mode"
              type="button"
              onClick={handleToggleViewMode}
            >
              {viewMode === "preview" ? "Switch to Edit" : "Switch to Preview"}
            </button>
            <button
              className="button button--secondary editor-pane__template"
              type="button"
              onClick={handleCreateTemplate}
              disabled={!note || isLoading}
            >
              Create Template
            </button>
            <button
              className="editor-pane__close"
              type="button"
              onClick={handleClose}
              aria-label="Close pane"
            >
              Close
            </button>
          </>
        }
      />
    </div>
  );
}
