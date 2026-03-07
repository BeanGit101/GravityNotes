import { describe, expect, it } from "vitest";
import {
  initialPaneSessionState,
  paneSessionReducer,
  type PaneSessionState,
} from "../src/state/paneReducer";

function reduce(state: PaneSessionState, action: Parameters<typeof paneSessionReducer>[1]) {
  return paneSessionReducer(state, action);
}

describe("paneSessionReducer", () => {
  it("opens in active pane by replacing when panes already exist", () => {
    const first = reduce(initialPaneSessionState, {
      type: "open-note",
      noteId: "note-1",
      mode: "active",
      newPaneId: "pane-1",
    });

    const replaced = reduce(first, {
      type: "open-note",
      noteId: "note-2",
      mode: "active",
      newPaneId: "pane-unused",
    });

    expect(replaced.panes).toEqual([{ id: "pane-1", noteId: "note-2" }]);
    expect(replaced.activePaneId).toBe("pane-1");
  });

  it("keeps one pane instance when opening the same note again", () => {
    const first = reduce(initialPaneSessionState, {
      type: "open-note",
      noteId: "note-1",
      mode: "active",
      newPaneId: "pane-1",
    });

    const second = reduce(first, {
      type: "open-note",
      noteId: "note-1",
      mode: "new",
      newPaneId: "pane-2",
    });

    expect(second.panes).toEqual([{ id: "pane-1", noteId: "note-1" }]);
    expect(second.activePaneId).toBe("pane-1");
  });

  it("opens in new pane and closes with active pane fallback", () => {
    const first = reduce(initialPaneSessionState, {
      type: "open-note",
      noteId: "note-1",
      mode: "active",
      newPaneId: "pane-1",
    });

    const second = reduce(first, {
      type: "open-note",
      noteId: "note-2",
      mode: "new",
      newPaneId: "pane-2",
    });

    expect(second.panes).toEqual([
      { id: "pane-1", noteId: "note-1" },
      { id: "pane-2", noteId: "note-2" },
    ]);
    expect(second.activePaneId).toBe("pane-2");

    const closed = reduce(second, { type: "close-pane", paneId: "pane-2" });
    expect(closed.panes).toEqual([{ id: "pane-1", noteId: "note-1" }]);
    expect(closed.activePaneId).toBe("pane-1");
  });

  it("removes deleted-note panes and keeps active pane valid", () => {
    const state: PaneSessionState = {
      panes: [
        { id: "pane-1", noteId: "note-1" },
        { id: "pane-2", noteId: "note-2" },
      ],
      activePaneId: "pane-2",
    };

    const result = reduce(state, { type: "remove-note", noteId: "note-2" });

    expect(result.panes).toEqual([{ id: "pane-1", noteId: "note-1" }]);
    expect(result.activePaneId).toBe("pane-1");
  });

  it("remaps note ids across open panes", () => {
    const state: PaneSessionState = {
      panes: [
        { id: "pane-1", noteId: "note-1" },
        { id: "pane-2", noteId: "note-2" },
      ],
      activePaneId: "pane-2",
    };

    const result = reduce(state, {
      type: "remap-note-ids",
      noteIds: { "note-2": "note-2-renamed" },
    });

    expect(result.panes).toEqual([
      { id: "pane-1", noteId: "note-1" },
      { id: "pane-2", noteId: "note-2-renamed" },
    ]);
    expect(result.activePaneId).toBe("pane-2");
  });

  it("removes multiple deleted notes at once", () => {
    const state: PaneSessionState = {
      panes: [
        { id: "pane-1", noteId: "note-1" },
        { id: "pane-2", noteId: "note-2" },
        { id: "pane-3", noteId: "note-3" },
      ],
      activePaneId: "pane-2",
    };

    const result = reduce(state, {
      type: "remove-notes",
      noteIds: ["note-1", "note-2"],
    });

    expect(result.panes).toEqual([{ id: "pane-3", noteId: "note-3" }]);
    expect(result.activePaneId).toBe("pane-3");
  });
});
