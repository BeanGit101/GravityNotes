import { forceLinting, linter, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import { spellChecker } from "./spellCheck";
import { TECH_WORDS } from "./techWords";

const ALLOWLIST_STORAGE_KEY = "spell-allowlist";
const WORD_PATTERN = /\b[a-zA-Z]{2,}(?:['\u2019][a-zA-Z]+)*\b/g;
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

const normalizeWord = (word: string) => word.replace(/\u2019/g, "'");

const editDistance = (source: string, target: string) => {
  const sourceLength = source.length;
  const targetLength = target.length;

  if (sourceLength === 0) return targetLength;
  if (targetLength === 0) return sourceLength;

  const previousRow = Array.from({ length: targetLength + 1 }, (_, index) => index);
  const currentRow = new Array<number>(targetLength + 1).fill(0);

  for (let i = 1; i <= sourceLength; i += 1) {
    currentRow[0] = i;

    for (let j = 1; j <= targetLength; j += 1) {
      const substitutionCost = source[i - 1] === target[j - 1] ? 0 : 1;
      currentRow[j] = Math.min(
        (previousRow[j] ?? 0) + 1,
        (currentRow[j - 1] ?? 0) + 1,
        (previousRow[j - 1] ?? 0) + substitutionCost
      );
    }

    for (let j = 0; j <= targetLength; j += 1) {
      previousRow[j] = currentRow[j] ?? 0;
    }
  }

  return previousRow[targetLength] ?? 0;
};

const getFallbackSuggestions = (word: string, allowlist: Set<string>) => {
  const normalizedWord = normalizeWord(word).toLowerCase();
  const firstLetter = normalizedWord[0];
  if (!firstLetter) {
    return [];
  }

  const maxDistance = normalizedWord.length > 8 ? 3 : 2;
  const candidates = new Set<string>([...TECH_WORDS, ...allowlist]);
  const rankedCandidates: Array<{ candidate: string; distance: number }> = [];

  for (const candidate of candidates) {
    if (!candidate || candidate === normalizedWord) {
      continue;
    }

    if (candidate[0] !== firstLetter) {
      continue;
    }

    if (Math.abs(candidate.length - normalizedWord.length) > maxDistance) {
      continue;
    }

    const distance = editDistance(normalizedWord, candidate);
    if (distance <= maxDistance) {
      rankedCandidates.push({ candidate, distance });
    }
  }

  rankedCandidates.sort((left, right) => {
    if (left.distance !== right.distance) {
      return left.distance - right.distance;
    }

    return left.candidate.localeCompare(right.candidate);
  });

  return rankedCandidates.slice(0, 3).map((entry) => entry.candidate);
};

const isCorrectWord = (word: string) => {
  const normalizedWord = normalizeWord(word).toLowerCase();
  const cached = checkCache.get(normalizedWord);
  if (cached !== undefined) {
    return cached;
  }

  const result = spellChecker.checkWord(normalizedWord);
  checkCache.set(normalizedWord, result);
  return result;
};

const getTopSuggestions = (word: string, allowlist: Set<string>) => {
  const normalizedWord = normalizeWord(word).toLowerCase();
  const cached = suggestionCache.get(normalizedWord);
  if (cached) {
    return cached;
  }

  const variants = new Set([word, normalizedWord, normalizedWord.replace(/'/g, "")]);
  const suggestions = new Set<string>();

  for (const variant of variants) {
    for (const suggestion of spellChecker.getSuggestions(variant)) {
      suggestions.add(suggestion);
      if (suggestions.size >= 3) {
        break;
      }
    }

    if (suggestions.size >= 3) {
      break;
    }
  }

  if (suggestions.size === 0) {
    for (const suggestion of getFallbackSuggestions(normalizedWord, allowlist)) {
      suggestions.add(suggestion);
    }
  }

  const topSuggestions = Array.from(suggestions).slice(0, 3);
  suggestionCache.set(normalizedWord, topSuggestions);
  return topSuggestions;
};

const shouldSkipWord = (word: string, allowlist: Set<string>) => {
  const normalizedWord = normalizeWord(word).toLowerCase();

  if (/[A-Z]/.test(word.slice(1))) {
    return true;
  }

  if (word.length >= 2 && word.length <= 5 && word === word.toUpperCase()) {
    return true;
  }

  if (/\d/.test(word)) {
    return true;
  }

  if (TECH_WORDS.has(normalizedWord)) {
    return true;
  }

  return allowlist.has(normalizedWord);
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
      const normalizedWord = normalizeWord(word).toLowerCase();

      if (shouldSkipWord(word, allowlist)) {
        continue;
      }

      if (isCorrectWord(word)) {
        continue;
      }

      const from = range.from + match.index;
      const to = from + word.length;
      const suggestions = getTopSuggestions(word, allowlist);

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
