// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

import { listAvailableTags, listTrashEntries } from "../src/services/notesService";

describe("notesService normalization", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("gravity.notesDirectory", "/vault");
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "set_vault_path") {
        return "/vault";
      }
      if (command === "list_trash_entries") {
        return [
          {
            id: "trash-1",
            name: "orphan.md",
            original_path: "/vault/archive/orphan.md",
            type: "file",
            deleted_at: 1700000000000,
          },
        ];
      }
      if (command === "list_available_tags") {
        return ["custom-tag", "  ", 42];
      }
      throw new Error(`Unexpected command: ${command}`);
    });
  });

  it("normalizes snake_case trash entry payloads", async () => {
    const entries = await listTrashEntries();

    expect(entries).toEqual([
      {
        id: "trash-1",
        name: "orphan.md",
        originalPath: "/vault/archive/orphan.md",
        type: "file",
        deletedAt: 1700000000000,
      },
    ]);
  });

  it("loads persistent available tags from the backend catalog", async () => {
    await expect(listAvailableTags()).resolves.toEqual(["custom-tag"]);
  });
});
