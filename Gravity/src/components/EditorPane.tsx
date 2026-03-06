import type { MouseEvent } from "react";
import { NoteEditor } from "./NoteEditor";
import type { Note } from "../types/notes";

interface EditorPaneProps {
  note: Note | null;
  value: string;
  isActive: boolean;
  isLoading: boolean;
  isPreviewMode: boolean;
  onFocus: () => void;
  onClose: () => void;
  onChange: (value: string) => void;
  onAutoSave: (value: string) => Promise<void>;
}

export function EditorPane({
  note,
  value,
  isActive,
  isLoading,
  isPreviewMode,
  onFocus,
  onClose,
  onChange,
  onAutoSave,
}: EditorPaneProps) {
  const handleClose = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onClose();
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
        isPreviewMode={isPreviewMode}
        toolbarActions={
          <button
            className="editor-pane__close"
            type="button"
            onClick={handleClose}
            aria-label="Close pane"
          >
            Close
          </button>
        }
      />
    </div>
  );
}
