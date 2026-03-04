import nspell from "nspell";
import affData from "./dictionaries/en.aff?raw";
import dicData from "./dictionaries/en.dic?raw";

let spellInstance: ReturnType<typeof nspell> | null = null;

const initializeSpellChecker = () => {
  spellInstance = nspell(affData, dicData);
};

const ready = Promise.resolve().then(initializeSpellChecker);

const getSpellInstance = () => {
  if (!spellInstance) {
    throw new Error("Spell checker is not initialized.");
  }

  return spellInstance;
};

export const spellChecker = {
  ready,
  checkWord(word: string) {
    if (!word) return true;
    return getSpellInstance().correct(word);
  },
  getSuggestions(word: string) {
    if (!word) return [];
    return getSpellInstance().suggest(word);
  },
};
