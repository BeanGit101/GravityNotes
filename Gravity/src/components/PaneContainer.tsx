import type { Note } from "../types/notes";
import { EditorPane } from "./EditorPane";

export type PaneLayout = "single" | "vertical" | "grid";

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

export function calculateLayout(paneCount: number): { columns: number; rows: number } {
  switch (paneCount) {
    case 1:
      return { columns: 1, rows: 1 };
    case 2:
      return { columns: 2, rows: 1 };
    case 3:
      return { columns: 2, rows: 2 };
    case 4:
      return { columns: 2, rows: 2 };
    default:
      return { columns: 2, rows: Math.ceil(paneCount / 2) };
  }
}

function getPanePosition(
  index: number,
  paneCount: number
): { column: number; row: number; columnSpan?: number } {
  if (paneCount === 1) {
    return { column: 1, row: 1 };
  }

  if (paneCount === 2) {
    return { column: index + 1, row: 1 };
  }

  if (paneCount === 3) {
    if (index < 2) {
      return { column: index + 1, row: 1 };
    }
    return { column: 1, row: 2, columnSpan: 2 };
  }

  const layout = calculateLayout(paneCount);
  const col = (index % layout.columns) + 1;
  const row = Math.floor(index / layout.columns) + 1;
  return { column: col, row };
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
  const layout = calculateLayout(panes.length);
  const layoutType: PaneLayout =
    panes.length === 1 ? "single" : panes.length === 2 ? "vertical" : "grid";

  return (
    <div
      className={`pane-container pane-container--${layoutType}`}
      style={{
        gridTemplateColumns: `repeat(${String(layout.columns)}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${String(layout.rows)}, minmax(0, 1fr))`,
      }}
    >
      {panes.map((pane, index) => {
        const note = getNoteById(pane.noteId);
        const hasContent = Object.prototype.hasOwnProperty.call(noteContents, pane.noteId);
        const value = noteContents[pane.noteId] ?? "";
        const isLoading = loadingNoteIds.has(pane.noteId) || !hasContent;
        const isActive = activePaneId === pane.id;
        const position = getPanePosition(index, panes.length);

        return (
          <div
            key={pane.id}
            className="pane-container__cell"
            style={{
              gridColumn: position.columnSpan
                ? `${String(position.column)} / span ${String(position.columnSpan)}`
                : String(position.column),
              gridRow: String(position.row),
            }}
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
