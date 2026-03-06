const TASK_MARKER_PATTERN = /^(\s*(?:[-+*]|\d+[.)])\s+\[)( |x|X)(\])/;

export function toggleNthTaskMarker(markdown: string, taskIndex: number): string {
  if (taskIndex < 0) {
    return markdown;
  }

  const lines = markdown.split("\n");
  let currentTaskIndex = 0;

  const nextLines = lines.map((line) => {
    const match = line.match(TASK_MARKER_PATTERN);
    if (!match) {
      return line;
    }

    if (currentTaskIndex !== taskIndex) {
      currentTaskIndex += 1;
      return line;
    }

    currentTaskIndex += 1;
    const marker = match[2]?.toLowerCase() === "x" ? " " : "x";
    const prefix = match[1] ?? "";
    const suffix = match[3] ?? "]";

    return `${prefix}${marker}${suffix}${line.slice(match[0].length)}`;
  });

  return nextLines.join("\n");
}
