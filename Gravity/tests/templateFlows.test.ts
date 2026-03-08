import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

class LocalStorageMock {
  private store = new Map<string, string>();

  clear() {
    this.store.clear();
  }

  getItem(key: string) {
    return this.store.get(key) ?? null;
  }

  key(index: number) {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string) {
    this.store.delete(key);
  }

  setItem(key: string, value: string) {
    this.store.set(key, value);
  }

  get length() {
    return this.store.size;
  }
}

describe("template flows", () => {
  beforeEach(() => {
    vi.resetModules();
    invokeMock.mockReset();
    const storage = new LocalStorageMock();
    storage.setItem("gravity.notesDirectory", "/vault");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: storage,
    });
  });

  it("applies template content when creating a note", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "set_vault_path") {
        return "/vault";
      }

      if (command === "create_note") {
        return {
          id: "/vault/plan.md",
          title: "Plan",
          path: "/vault/plan.md",
        };
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    const { createNote } = await import("../src/services/notesService");

    await createNote("Plan", null, {
      body: "# Kickoff\n",
      subject: "Sprint Planning",
      tags: ["planning", "team"],
    });

    expect(invokeMock).toHaveBeenNthCalledWith(1, "set_vault_path", { path: "/vault" });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "create_note", {
      title: "Plan",
      folderPath: null,
      initialContent:
        "---\nsubject: Sprint Planning\ntags:\n  - planning\n  - team\n---\n\n# Kickoff\n",
    });
  });

  it("creates a template from the current note frontmatter and body", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "set_vault_path") {
        return "/vault";
      }

      if (command === "create_template") {
        return {
          id: "/vault/.gravity/templates/Retro.md",
          name: "Retro",
          path: "/vault/.gravity/templates/Retro.md",
          updatedAt: 123,
          body: "## Wins\n- Shipping\n",
          subject: "Weekly Retro",
          tags: ["retro", "team"],
        };
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    const { createTemplateFromNote } = await import("../src/services/notesService");

    await createTemplateFromNote(
      "Retro",
      "---\nsubject: Weekly Retro\ntags:\n  - retro\n  - team\n---\n\n## Wins\n- Shipping\n"
    );

    expect(invokeMock).toHaveBeenNthCalledWith(1, "set_vault_path", { path: "/vault" });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "create_template", {
      name: "Retro",
      body: "## Wins\n- Shipping\n",
      subject: "Weekly Retro",
      tags: ["retro", "team"],
    });
  });

  it("renames and deletes a template", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "set_vault_path") {
        return "/vault";
      }

      if (command === "rename_template") {
        return {
          id: "/vault/.gravity/templates/Journal.md",
          name: "Journal",
          path: "/vault/.gravity/templates/Journal.md",
          updatedAt: 456,
        };
      }

      if (command === "delete_template") {
        return undefined;
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    const { deleteTemplate, renameTemplate } = await import("../src/services/notesService");

    await renameTemplate("/vault/.gravity/templates/Daily.md", "Journal");
    await deleteTemplate("/vault/.gravity/templates/Journal.md");

    expect(invokeMock).toHaveBeenNthCalledWith(1, "set_vault_path", { path: "/vault" });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "rename_template", {
      path: "/vault/.gravity/templates/Daily.md",
      newName: "Journal",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "delete_template", {
      path: "/vault/.gravity/templates/Journal.md",
    });
  });
});
