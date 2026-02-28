import type { Note } from "../types/notes";
import { EditorPane } from "./EditorPane";

export type PaneLayout = "single" | "vertical" | "horizontal" | "grid";

export interface PaneState {
  id: string;
  noteId: string;
}

interface PaneContainerProps {
  panes: PaneState[];
  activePaneId: string | null;
  getNoteById: (noteId: string) => Note | null;
  noteContents: Record<string, string>;
  loadingNoteIds: Set<string>;
  onActivatePane: (paneId: string) => void;
  onClosePane: (paneId: string) => void;
  onChangeNote: (noteId: string, value: string) => void;
  onAutoSaveNote: (noteId: string, value: string) => Promise<void>;
}

const GRID_POSITIONS = [
  { column: 1, row: 1 },
  { column: 2, row: 1 },
  { column: 2, row: 2 },
  { column: 1, row: 2 },
];

export function getPaneLayout(count: number): PaneLayout {
  if (count <= 1) return "single";
  if (count === 2) return "vertical";
  return "grid";
}

export function PaneContainer({
  panes,
  activePaneId,
  getNoteById,
  noteContents,
  loadingNoteIds,
  onActivatePane,
  onClosePane,
  onChangeNote,
  onAutoSaveNote,
}: PaneContainerProps) {
  const layout = getPaneLayout(panes.length);

  return (
    <div className={`pane-container pane-container--${layout}`}>
      {panes.map((pane, index) => {
        const note = getNoteById(pane.noteId);
        const hasContent = Object.prototype.hasOwnProperty.call(noteContents, pane.noteId);
        const value = noteContents[pane.noteId] ?? "";
        const isLoading = loadingNoteIds.has(pane.noteId) || !hasContent;
        const isActive = activePaneId === pane.id;
        const placement = layout === "grid" ? GRID_POSITIONS[index] : null;

        return (
          <div
            key={pane.id}
            className="pane-container__cell"
            style={placement ? { gridColumn: placement.column, gridRow: placement.row } : undefined}
          >
            <EditorPane
              note={note}
              value={value}
              isActive={isActive}
              isLoading={isLoading}
              onFocus={() => {
                onActivatePane(pane.id);
              }}
              onClose={() => {
                onClosePane(pane.id);
              }}
              onChange={(nextValue) => {
                onChangeNote(pane.noteId, nextValue);
              }}
              onAutoSave={(nextValue) => onAutoSaveNote(pane.noteId, nextValue)}
            />
          </div>
        );
      })}
    </div>
  );
}
