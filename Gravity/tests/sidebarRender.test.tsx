import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NoteList } from "../src/components/NoteList";
import type { FileSystemItem } from "../src/types/notes";

describe("NoteList rendering", () => {
  it("shows correct nested folder note count", () => {
    const notes: FileSystemItem[] = [
      {
        type: "folder",
        id: "/vault/projects",
        name: "Projects",
        path: "/vault/projects",
        children: [
          {
            type: "file",
            id: "/vault/projects/one.md",
            title: "one",
            path: "/vault/projects/one.md",
          },
          {
            type: "folder",
            id: "/vault/projects/archive",
            name: "Archive",
            path: "/vault/projects/archive",
            children: [
              {
                type: "file",
                id: "/vault/projects/archive/two.md",
                title: "two",
                path: "/vault/projects/archive/two.md",
              },
            ],
          },
        ],
      },
    ];

    const html = renderToStaticMarkup(
      <NoteList
        directoryPath="/vault"
        notes={notes}
        templates={[]}
        selectedNoteId={null}
        selectedFolderPath={null}
        onOpenVault={() => {}}
        onCreateNote={() => {}}
        onCreateFolder={() => {}}
        onCreateTemplate={() => {}}
        onRenameTemplate={() => {}}
        onDeleteTemplate={() => {}}
        onSelectFolder={() => {}}
        onSelectNote={() => {}}
        onOpenInNewPane={() => {}}
        onDeleteNote={() => {}}
        errorMessage={null}
      />
    );

    expect(html).toContain("2 notes");
  });
});
