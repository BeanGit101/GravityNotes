import { describe, expect, it } from "vitest";
import {
  createEmptyNoteMetadata,
  parseNoteDocument,
  serializeNoteDocument,
} from "../src/utils/frontmatter";

describe("frontmatter parsing and serialization", () => {
  it("returns the full document body when no frontmatter is present", () => {
    const content = "# Plain note\n\nNo frontmatter here.";

    const parsed = parseNoteDocument(content);

    expect(parsed.metadata).toEqual(createEmptyNoteMetadata());
    expect(parsed.body).toBe(content);
  });

  it("treats malformed frontmatter as plain markdown", () => {
    const content = "---\nsubject hello\nbody";

    const parsed = parseNoteDocument(content);

    expect(parsed.metadata).toEqual(createEmptyNoteMetadata());
    expect(parsed.body).toBe(content);
    expect(serializeNoteDocument(parsed)).toBe(content);
  });

  it("round-trips subject and tags metadata", () => {
    const content = "---\nsubject: \"Weekly review\"\ntags:\n  - work\n  - planning\n---\n# Notes";

    const parsed = parseNoteDocument(content);
    const serialized = serializeNoteDocument(parsed);

    expect(parsed.metadata).toEqual({
      subject: "Weekly review",
      tags: ["work", "planning"],
    });
    expect(serialized).toBe(content);
  });

  it("preserves the markdown body exactly during round-trip", () => {
    const body = "# Heading\n\n- [ ] item\n\n```ts\nconsole.log('keep body exact');\n```\n";
    const serialized = serializeNoteDocument({
      body,
      metadata: {
        subject: "Body fidelity",
        tags: ["test"],
      },
    });

    const parsed = parseNoteDocument(serialized);

    expect(parsed.body).toBe(body);
    expect(serializeNoteDocument(parsed)).toBe(serialized);
  });
});
