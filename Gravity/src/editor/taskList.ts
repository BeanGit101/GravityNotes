import { findCheckboxAtIndex } from "./checkboxParser";

export function toggleNthTaskMarker(markdown: string, taskIndex: number): string {
  const checkbox = findCheckboxAtIndex(markdown, taskIndex);
  if (!checkbox) {
    return markdown;
  }

  const marker = markdown[checkbox.from + 1]?.toLowerCase() === "x" ? " " : "x";
  return `${markdown.slice(0, checkbox.from + 1)}${marker}${markdown.slice(checkbox.from + 2)}`;
}
