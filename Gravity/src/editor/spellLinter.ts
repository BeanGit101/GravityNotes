import { forceLinting, linter, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import { spellChecker } from "./spellCheck";

const ALLOWLIST_STORAGE_KEY = "spell-allowlist";
const WORD_PATTERN = /\b[a-zA-Z]{2,}\b/g;
const MAX_DIAGNOSTICS = 200;

let allowlistCache: Set<string> | null = null;
const checkCache = new Map<string, boolean>();
const suggestionCache = new Map<string, string[]>();

const readAllowlist = () => {
  if (allowlistCache) {
    return new Set(allowlistCache);
  }

  try {
    const raw = localStorage.getItem(ALLOWLIST_STORAGE_KEY);
    if (!raw) {
      allowlistCache = new Set<string>();
      return new Set<string>();
    }

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      allowlistCache = new Set<string>();
      return new Set<string>();
    }

    const words = parsed.filter((value): value is string => typeof value === "string");
    allowlistCache = new Set(words.map((word) => word.toLowerCase()));
    return new Set(allowlistCache);
  } catch {
    allowlistCache = new Set<string>();
    return new Set<string>();
  }
};

const writeAllowlist = (allowlist: Set<string>) => {
  allowlistCache = new Set(allowlist);
  localStorage.setItem(ALLOWLIST_STORAGE_KEY, JSON.stringify(Array.from(allowlist.values())));
};

const isCorrectWord = (word: string) => {
  const normalizedWord = word.toLowerCase();
  const cached = checkCache.get(normalizedWord);
  if (cached !== undefined) {
    return cached;
  }

  const result = spellChecker.checkWord(word);
  checkCache.set(normalizedWord, result);
  return result;
};

const getTopSuggestions = (word: string) => {
  const normalizedWord = word.toLowerCase();
  const cached = suggestionCache.get(normalizedWord);
  if (cached) {
    return cached;
  }

  const suggestions = spellChecker.getSuggestions(word).slice(0, 3);
  suggestionCache.set(normalizedWord, suggestions);
  return suggestions;
};

const refreshDiagnosticsImmediately = (editorView: EditorView) => {
  editorView.dispatch(setDiagnostics(editorView.state, linterDiagnosticSource(editorView)));
};

const linterDiagnosticSource = (view: EditorView) => {
  const diagnostics: Diagnostic[] = [];
  const allowlist = readAllowlist();
  const text = view.state.doc.toString();

  for (const range of view.visibleRanges) {
    const segment = text.slice(range.from, range.to);
    WORD_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = WORD_PATTERN.exec(segment)) !== null) {
      const word = match[0];
      const normalizedWord = word.toLowerCase();

      if (allowlist.has(normalizedWord) || isCorrectWord(word)) {
        continue;
      }

      const from = range.from + match.index;
      const to = from + word.length;
      const suggestions = getTopSuggestions(word);

      const actions = suggestions.map((suggestion) => ({
        name: `Replace with "${suggestion}"`,
        apply: (editorView: EditorView, replaceFrom: number, replaceTo: number) => {
          editorView.dispatch({
            changes: { from: replaceFrom, to: replaceTo, insert: suggestion },
          });
        },
      }));

      actions.push({
        name: "Add to dictionary",
        apply: (editorView: EditorView) => {
          const updatedAllowlist = readAllowlist();
          updatedAllowlist.add(normalizedWord);
          writeAllowlist(updatedAllowlist);
          refreshDiagnosticsImmediately(editorView);
          forceLinting(editorView);
        },
      });

      diagnostics.push({
        from,
        to,
        severity: "error",
        message: `Unknown word: "${word}"`,
        actions,
      });

      if (diagnostics.length >= MAX_DIAGNOSTICS) {
        return diagnostics;
      }
    }
  }

  return diagnostics;
};

export const spellLinter = linter(
  async (view) => {
    await spellChecker.ready;
    return linterDiagnosticSource(view);
  },
  {
    delay: 400,
    needsRefresh: (update: ViewUpdate) => update.viewportChanged,
  }
);
