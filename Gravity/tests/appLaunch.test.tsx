// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginStartupDiagnostics,
  getStartupDiagnosticsHistory,
  resetStartupDiagnosticsForTests,
} from "../src/state/startupDiagnostics";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const services = vi.hoisted(() => ({
  listNotesWithFolders: vi.fn(async () => []),
  listTrashEntries: vi.fn(async () => []),
}));

vi.mock("../src/services/notesService", () => ({
  buildFilenameSearchResults: () => [],
  createFolder: vi.fn(),
  createNote: vi.fn(),
  deleteFolder: vi.fn(),
  deleteNote: vi.fn(),
  getNotesDirectory: () => "/vault",
  listNotesWithFolders: services.listNotesWithFolders,
  listTrashEntries: services.listTrashEntries,
  moveFolder: vi.fn(),
  moveNote: vi.fn(),
  permanentlyDeleteTrashEntry: vi.fn(),
  readNote: vi.fn(),
  renameFolder: vi.fn(),
  renameNote: vi.fn(),
  restoreTrashEntry: vi.fn(),
  selectNotesDirectory: vi.fn(),
  updateNote: vi.fn(),
}));

vi.mock("../src/components/NoteEditor", () => ({
  NoteEditor: ({ isLoading }: { isLoading?: boolean }) => (
    <div data-testid="mock-note-editor">{isLoading ? "loading" : "idle"}</div>
  ),
}));

import App from "../src/App";

describe("App launch state", () => {
  let container: HTMLDivElement;
  let root: Root | null;
  const originalRequestAnimationFrame = window.requestAnimationFrame;
  const originalCancelAnimationFrame = window.cancelAnimationFrame;

  beforeAll(() => {
    window.requestAnimationFrame = (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(performance.now()), 0);
    window.cancelAnimationFrame = (handle: number) => {
      window.clearTimeout(handle);
    };
  });

  afterAll(() => {
    window.requestAnimationFrame = originalRequestAnimationFrame;
    window.cancelAnimationFrame = originalCancelAnimationFrame;
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    localStorage.clear();
    root = null;
    resetStartupDiagnosticsForTests();
    beginStartupDiagnostics({ test: "app-launch" });
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    container.remove();
  });

  it("renders the empty editor in an idle state and records boot readiness", async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
      await Promise.resolve();
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve());
      });
    });

    const editor = container.querySelector('[data-testid="mock-note-editor"]');
    expect(editor?.textContent).toBe("idle");
    expect(document.documentElement.dataset["gravityBoot"]).toBe("ready");
    expect(services.listNotesWithFolders).toHaveBeenCalledTimes(1);
    expect(services.listTrashEntries).toHaveBeenCalledTimes(1);

    const latestSession = getStartupDiagnosticsHistory()[0];
    const eventNames = latestSession?.events.map((event) => event.name) ?? [];
    expect(eventNames).toContain("app.mounted");
    expect(eventNames).toContain("vault.refresh.started");
    expect(eventNames).toContain("vault.refresh.succeeded");
    expect(eventNames).toContain("boot.ui.ready");
  });
});
