/**
 * Punjabi / Hindi spoken-number parser.
 *
 * Why this is not an LLM's job: the fractional multipliers below are a small,
 * closed, deterministic grammar. A parser gets them right every time and can be
 * unit-tested; a model gets them mostly right and fails silently on the ones it
 * doesn't. Rates and quantities are the two fields where "mostly right" means a
 * wrong bill, so they go through here — and only here.
 *
 * Whisper/Saarika transcribe roman or Gurmukhi depending on the engine, so both
 * scripts are accepted.
 *
 * The multiplier rule that trips people up:
 *   "sava"  scales the FOLLOWING numeral by +0.25 before the scale word applies
 *   "sarhe" by +0.5, "paune" by -0.25
 *
 *   sava sau        -> 1.25 x 100 = 125
 *   sava do sau     -> 2.25 x 100 = 225   (not 1.25 x 200 = 250)
 *   sarhe teen sau  -> 3.50 x 100 = 350
 *   paune char sau  -> 3.75 x 100 = 375
 */

/** Standalone words that already carry a fraction. */
const STANDALONE: Record<string, number> = {
  adha: 0.5, addha: 0.5, aadha: 0.5, half: 0.5, ਅੱਧਾ: 0.5,
  paun: 0.75, pauna: 0.75, ਪੌਣਾ: 0.75,
  dedh: 1.5, derh: 1.5, deodh: 1.5, ਡੇਢ: 1.5,
  dhai: 2.5, adhai: 2.5, ਢਾਈ: 2.5,
};

/** Modifiers applied to the numeral that follows them. */
const MODIFIERS: Record<string, number> = {
  sava: 0.25, sawa: 0.25, savaa: 0.25, ਸਵਾ: 0.25,
  sarhe: 0.5, sadhe: 0.5, saadhe: 0.5, ਸਾਢੇ: 0.5,
  paune: -0.25, pone: -0.25, poune: -0.25, ਪੌਣੇ: -0.25,
};

const UNITS: Record<string, number> = {
  sifar: 0, zero: 0, ਸਿਫਰ: 0,
  ik: 1, ikk: 1, ek: 1, one: 1, ਇੱਕ: 1,
  do: 2, doe: 2, two: 2, ਦੋ: 2,
  tin: 3, teen: 3, tinn: 3, three: 3, ਤਿੰਨ: 3,
  char: 4, chaar: 4, four: 4, ਚਾਰ: 4,
  panj: 5, panch: 5, paanj: 5, paanch: 5, five: 5, ਪੰਜ: 5,
  che: 6, chhe: 6, chey: 6, chah: 6, six: 6, ਛੇ: 6,
  satt: 7, sat: 7, saat: 7, seven: 7, ਸੱਤ: 7,
  ath: 8, atth: 8, aath: 8, eight: 8, ਅੱਠ: 8,
  nau: 9, nao: 9, nine: 9, ਨੌਂ: 9,
  das: 10, dus: 10, ten: 10, ਦਸ: 10,
  gyarah: 11, gyara: 11, yaran: 11,
  barah: 12, bara: 12, baraan: 12,
  terah: 13, tera: 13,
  chaudah: 14, chauda: 14,
  pandrah: 15, pandra: 15,
  solah: 16, sola: 16,
  satrah: 17, satara: 17,
  atharah: 18, athara: 18,
  unnis: 19, unni: 19,
  bees: 20, bis: 20, vih: 20, ਵੀਹ: 20,
  pachchi: 25, pachees: 25, pachi: 25,
  tees: 30, tih: 30, ਤੀਹ: 30,
  challi: 40, chalis: 40, chali: 40, ਚਾਲੀ: 40,
  panjah: 50, pachas: 50, panjaah: 50, ਪੰਜਾਹ: 50,
  satth: 60, saath: 60, sath: 60,
  sattar: 70, sattar_: 70,
  assi: 80, asi: 80, ਅੱਸੀ: 80,
  nabbe: 90, nabe: 90, navve: 90,
};

const SCALES: Record<string, number> = {
  sau: 100, so: 100, hundred: 100, ਸੌ: 100,
  hazaar: 1000, hazar: 1000, hajar: 1000, thousand: 1000, ਹਜ਼ਾਰ: 1000,
  lakh: 100_000, lac: 100_000, ਲੱਖ: 100_000,
  crore: 10_000_000, karor: 10_000_000, ਕਰੋੜ: 10_000_000,
};

/** Words that mean "and" or are pure filler between numerals. */
const FILLER = new Set(['te', 'ate', 'aur', 'and', 'ਤੇ', 'ਅਤੇ']);

export interface ParsedNumber {
  value: number;
  /// The exact span of tokens consumed, so the caller can splice the number out
  /// of the utterance and keep parsing the remainder.
  matchedTokens: string[];
  startIndex: number;
  endIndex: number;
}

const normalize = (token: string): string =>
  token
    .toLowerCase()
    .replace(/[.,!?;:]/g, '')
    .trim();

/**
 * Reads one number starting at `startIndex`. Returns null when the token there
 * is not part of a number.
 */
export function parseNumberAt(tokens: string[], startIndex: number): ParsedNumber | null {
  let i = startIndex;
  let total = 0; // completed scale groups
  let current = 0; // group being built
  let pendingModifier: number | null = null;
  let consumedAny = false;

  while (i < tokens.length) {
    const word = normalize(tokens[i]!);
    if (!word) {
      i++;
      continue;
    }

    // Bare digits — Whisper often emits these directly.
    if (/^\d+(\.\d+)?$/.test(word)) {
      const numeric = Number(word);
      current += pendingModifier !== null ? numeric + pendingModifier : numeric;
      pendingModifier = null;
      consumedAny = true;
      i++;
      continue;
    }

    if (word in MODIFIERS) {
      // "sava sau" with no numeral between: the implied numeral is 1.
      pendingModifier = MODIFIERS[word]!;
      consumedAny = true;
      i++;
      continue;
    }

    if (word in STANDALONE) {
      current += STANDALONE[word]!;
      pendingModifier = null;
      consumedAny = true;
      i++;
      continue;
    }

    if (word in UNITS) {
      const base = UNITS[word]!;
      current += pendingModifier !== null ? base + pendingModifier : base;
      pendingModifier = null;
      consumedAny = true;
      i++;
      continue;
    }

    if (word in SCALES) {
      const scale = SCALES[word]!;
      // A dangling modifier before a bare scale means an implied 1: "sava sau".
      const multiplicand =
        current !== 0 ? current : pendingModifier !== null ? 1 + pendingModifier : 1;
      pendingModifier = null;

      if (scale >= 1000) {
        // "do hazaar panj sau" — everything accumulated so far scales together.
        total = (total + multiplicand) * scale;
        current = 0;
      } else {
        current = multiplicand * scale;
        total += current;
        current = 0;
      }
      consumedAny = true;
      i++;
      continue;
    }

    if (FILLER.has(word) && consumedAny) {
      i++;
      continue;
    }

    break;
  }

  if (!consumedAny) return null;

  // A modifier with nothing after it ("sava" alone) reads as 1 + modifier.
  if (pendingModifier !== null && current === 0 && total === 0) {
    current = 1 + pendingModifier;
  }

  const value = total + current;
  const endIndex = i;

  // Trim trailing filler out of the reported span.
  let realEnd = endIndex;
  while (realEnd > startIndex && FILLER.has(normalize(tokens[realEnd - 1]!))) realEnd--;

  return {
    value: Math.round(value * 1000) / 1000,
    matchedTokens: tokens.slice(startIndex, realEnd),
    startIndex,
    endIndex: realEnd,
  };
}

/** Parses a whole phrase that is expected to be nothing but a number. */
export function parsePunjabiNumber(phrase: string): number | null {
  const tokens = phrase.split(/\s+/).filter(Boolean);
  const result = parseNumberAt(tokens, 0);
  return result ? result.value : null;
}

/** Finds every number in an utterance, left to right. */
export function extractNumbers(phrase: string): ParsedNumber[] {
  const tokens = phrase.split(/\s+/).filter(Boolean);
  const found: ParsedNumber[] = [];
  let i = 0;
  while (i < tokens.length) {
    const result = parseNumberAt(tokens, i);
    if (result && result.endIndex > i) {
      found.push(result);
      i = result.endIndex;
    } else {
      i++;
    }
  }
  return found;
}

/**
 * Rewrites spoken numbers as digits before the utterance reaches the model.
 *
 *   "das ream A4 paper do sau chali rate te"
 *   -> "10 ream A4 paper 240 rate te"
 *
 * This is the single highest-leverage preprocessing step: the model never has
 * to reason about "sarhe teen", so it cannot get it wrong.
 */
export function digitizeNumbers(phrase: string): string {
  const tokens = phrase.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const result = parseNumberAt(tokens, i);
    if (result && result.endIndex > i) {
      out.push(String(result.value));
      i = result.endIndex;
    } else {
      out.push(tokens[i]!);
      i++;
    }
  }
  return out.join(' ');
}
