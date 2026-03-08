import type { TemplateContent } from "../types/templates";

type TemplateSeed = Pick<TemplateContent, "body" | "subject" | "tags">;

function normalizeContent(markdown: string): string {
  return markdown.replace(/\r\n/g, "\n");
}

function cleanSubject(subject: string | undefined): string | undefined {
  const value = subject?.trim();
  return value ? value : undefined;
}

function cleanTags(tags: string[] | undefined): string[] | undefined {
  if (!tags) {
    return undefined;
  }

  const next = tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0);
  return next.length > 0 ? next : undefined;
}

function parseInlineTags(value: string): string[] {
  return value
    .slice(1, -1)
    .split(",")
    .map((tag) => tag.trim().replace(/^['"]|['"]$/g, ""))
    .filter((tag) => tag.length > 0);
}

export function serializeTemplateMarkdown(template: TemplateSeed): string {
  const subject = cleanSubject(template.subject);
  const tags = cleanTags(template.tags);
  const body = template.body;

  if (!subject && !tags) {
    return body;
  }

  const lines = ["---"];
  if (subject) {
    lines.push(`subject: ${subject}`);
  }
  if (tags) {
    lines.push("tags:");
    tags.forEach((tag) => {
      lines.push(`  - ${tag}`);
    });
  }
  lines.push("---");

  if (body.length > 0) {
    lines.push("");
    lines.push(body);
  }

  return lines.join("\n");
}

export function parseTemplateMarkdown(markdown: string): TemplateSeed {
  const normalized = normalizeContent(markdown);
  if (!normalized.startsWith("---\n")) {
    return { body: normalized };
  }

  const remaining = normalized.slice(4);
  const closingIndex = remaining.indexOf("\n---\n");
  const closingWithoutBody = remaining.endsWith("\n---") ? remaining.length - 4 : -1;

  if (closingIndex === -1 && closingWithoutBody === -1) {
    return { body: normalized };
  }

  const frontmatter =
    closingIndex >= 0 ? remaining.slice(0, closingIndex) : remaining.slice(0, closingWithoutBody);
  const bodyWithSpacing = closingIndex >= 0 ? remaining.slice(closingIndex + 5) : "";
  const body = bodyWithSpacing.startsWith("\n") ? bodyWithSpacing.slice(1) : bodyWithSpacing;

  let subject: string | undefined;
  let tags: string[] | undefined;
  const lines = frontmatter.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }

    if (line.startsWith("subject:")) {
      subject = cleanSubject(line.slice("subject:".length).trim());
      continue;
    }

    if (!line.startsWith("tags:")) {
      continue;
    }

    const remainder = line.slice("tags:".length).trim();
    if (remainder.startsWith("[") && remainder.endsWith("]")) {
      tags = cleanTags(parseInlineTags(remainder));
      continue;
    }

    const collected: string[] = [];
    let cursor = index + 1;
    while (cursor < lines.length) {
      const item = lines[cursor]?.trim();
      if (!item?.startsWith("- ")) {
        break;
      }
      collected.push(
        item
          .slice(2)
          .trim()
          .replace(/^['"]|['"]$/g, "")
      );
      cursor += 1;
    }
    tags = cleanTags(collected);
    index = cursor - 1;
  }

  return {
    body,
    subject,
    tags,
  };
}

export function buildTemplatePayload(template: TemplateSeed): TemplateSeed {
  return {
    body: template.body,
    subject: cleanSubject(template.subject),
    tags: cleanTags(template.tags),
  };
}
