// @vitest-environment jsdom

import { act } from "react";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NoteListErrorBoundary } from "../src/components/NoteListErrorBoundary";
import {
  beginStartupDiagnostics,
  getStartupDiagnosticsHistory,
  resetStartupDiagnosticsForTests,
} from "../src/state/startupDiagnostics";

function ThrowingChild() {
  throw new Error("note-list exploded");
}

describe("NoteListErrorBoundary", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    resetStartupDiagnosticsForTests();
    beginStartupDiagnostics({ test: "note-list-boundary" });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it("renders a readable fallback and records diagnostics when the sidebar crashes", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await act(async () => {
      root = createRoot(container);
      root.render(
        <NoteListErrorBoundary>
          <ThrowingChild />
        </NoteListErrorBoundary>
      );
    });

    expect(container.textContent).toContain("Sidebar failed to render");
    expect(container.textContent).toContain("note-list exploded");
    expect(consoleErrorSpy).toHaveBeenCalled();

    const sessions = getStartupDiagnosticsHistory();
    const latestEventNames = sessions[0]?.events.map((event) => event.name) ?? [];
    expect(latestEventNames).toContain("notelist.render.failed");
  });
});
