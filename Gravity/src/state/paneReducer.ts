export interface PaneState {
  id: string;
  noteId: string;
}

export type OpenMode = "active" | "new";

export interface PaneSessionState {
  panes: PaneState[];
  activePaneId: string | null;
}

export type PaneAction =
  | { type: "reset" }
  | { type: "open-note"; noteId: string; mode: OpenMode; newPaneId: string }
  | { type: "close-pane"; paneId: string }
  | { type: "remove-note"; noteId: string }
  | { type: "remove-notes"; noteIds: string[] }
  | { type: "activate-pane"; paneId: string | null };

export const initialPaneSessionState: PaneSessionState = {
  panes: [],
  activePaneId: null,
};

function openNote(
  state: PaneSessionState,
  noteId: string,
  mode: OpenMode,
  newPaneId: string,
  maxPanes = 4
): PaneSessionState {
  const existing = state.panes.find((pane) => pane.noteId === noteId);
  if (existing) {
    return { ...state, activePaneId: existing.id };
  }

  if (mode === "new" && state.panes.length < maxPanes) {
    return {
      panes: [...state.panes, { id: newPaneId, noteId }],
      activePaneId: newPaneId,
    };
  }

  if (state.panes.length > 0) {
    const targetPaneId = state.activePaneId ?? state.panes[0]?.id ?? null;
    if (!targetPaneId) {
      return state;
    }

    return {
      panes: state.panes.map((pane) => (pane.id === targetPaneId ? { ...pane, noteId } : pane)),
      activePaneId: targetPaneId,
    };
  }

  return {
    panes: [{ id: newPaneId, noteId }],
    activePaneId: newPaneId,
  };
}

function closePane(state: PaneSessionState, paneId: string): PaneSessionState {
  const panes = state.panes.filter((pane) => pane.id !== paneId);
  if (state.activePaneId !== paneId) {
    return {
      panes,
      activePaneId: panes.some((pane) => pane.id === state.activePaneId)
        ? state.activePaneId
        : (panes[0]?.id ?? null),
    };
  }

  return {
    panes,
    activePaneId: panes[0]?.id ?? null,
  };
}

function removeNotesFromPanes(state: PaneSessionState, noteIds: string[]): PaneSessionState {
  const deletedIds = new Set(noteIds);
  const panes = state.panes.filter((pane) => !deletedIds.has(pane.noteId));
  return {
    panes,
    activePaneId: panes.some((pane) => pane.id === state.activePaneId)
      ? state.activePaneId
      : (panes[0]?.id ?? null),
  };
}

export function paneSessionReducer(state: PaneSessionState, action: PaneAction): PaneSessionState {
  switch (action.type) {
    case "reset":
      return initialPaneSessionState;
    case "open-note":
      return openNote(state, action.noteId, action.mode, action.newPaneId);
    case "close-pane":
      return closePane(state, action.paneId);
    case "remove-note":
      return removeNotesFromPanes(state, [action.noteId]);
    case "remove-notes":
      return removeNotesFromPanes(state, action.noteIds);
    case "activate-pane":
      return {
        ...state,
        activePaneId:
          action.paneId && state.panes.some((pane) => pane.id === action.paneId)
            ? action.paneId
            : action.paneId === null
              ? null
              : state.activePaneId,
      };
    default:
      return state;
  }
}
