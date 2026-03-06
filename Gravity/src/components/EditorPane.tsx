import type { MouseEvent } from "react";
import type { NoteViewMode } from "../types/editor";
import type { Note } from "../types/notes";
import { NoteEditor } from "./NoteEditor";

interface EditorPaneProps {
  note: Note | null;
  value: string;
  isActive: boolean;
  isLoading: boolean;
  viewMode: NoteViewMode;
  onFocus: () => void;
  onClose: () => void;
  onToggleViewMode: () => void;
  onChange: (value: string) => void;
  onAutoSave: (value: string) => Promise<void>;
}

export function EditorPane({
  note,
  value,
  isActive,
  isLoading,
  viewMode,
  onFocus,
  onClose,
  onToggleViewMode,
  onChange,
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

  return (
    <div
      className={`editor-pane ${isActive ? "editor-pane--active" : ""}`}
      onPointerDown={onFocus}
      role="presentation"
    >
      <NoteEditor
        note={note}
        value={value}
        onChange={onChange}
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
