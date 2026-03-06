declare module "nspell" {
  interface NSpell {
    correct(word: string): boolean;
    suggest(word: string): string[];
  }

  export default function nspell(aff: Uint8Array | string, dic: Uint8Array | string): NSpell;
}
