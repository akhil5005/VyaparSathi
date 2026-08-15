/**
 * Matching a name read off a piece of paper to a name in the database.
 *
 * A mill's invoice says "M/S J.K. PAPER MILLS LTD." and the party is called
 * "JK Paper Mills". A supplier's line reads "A-4 COPIER 75 GSM 500SHT" and the
 * product is "JK Copier A4 75gsm". Neither matches with `LIKE '%…%'`, which is
 * all the list endpoints do — so scanning a bill needs its own matcher.
 *
 * Deliberately **not** a database extension. `pg_trgm` would do this well and
 * costs a migration, an index and a query per lookup; a shop has a few hundred
 * parties and a few hundred products, and comparing a string against all of
 * them in memory is microseconds. It is also pure, so every rule below is
 * tested without a database — which matters more here than speed, because this
 * is the layer deciding which supplier a bill belongs to.
 *
 * The output is always a ranked shortlist with scores, never a decision. What
 * to do with a weak match is the caller's problem, and on screen it is the
 * operator's.
 */

/// Words that carry no identity. "JK Paper Mills Ltd" and "JK Paper Mills" are
/// the same firm; "Ltd" should not cost similarity, and should not earn it.
const NOISE = new Set([
  'm/s',
  'ms',
  'messrs',
  'ltd',
  'limited',
  'pvt',
  'private',
  'co',
  'company',
  'the',
  'and',
  '&',
  'inc',
  'llp',
]);

/**
 * Lowercase, strip punctuation, split run-together units, drop noise words.
 *
 * Punctuation goes first so "J.K." becomes "jk" rather than three tokens.
 *
 * Then the awkward one: the catalogue says "75gsm" and the supplier prints
 * "75 GSM", which as single tokens have nothing in common. Splitting at the
 * digit-to-letter boundary fixes it — but only where the letters run to two or
 * more, so "75gsm" becomes "75 gsm" while "A4" stays "a4" and does not
 * disintegrate into a stray "a". Paper sizes are one letter and a digit;
 * units are not.
 */
export function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[.\-_/\\,()[\]]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/(\d)([a-z]{2,})/g, '$1 $2')
    .replace(/([a-z]{2,})(\d)/g, '$1 $2')
    .split(/\s+/)
    .filter((token) => token.length > 0 && !NOISE.has(token))
    .join(' ');
}

const tokensOf = (value: string): string[] => normalize(value).split(' ').filter(Boolean);

/** Character bigrams, which is what catches a typo or a missing letter. */
function bigrams(value: string): Set<string> {
  const compact = value.replace(/\s+/g, '');
  const set = new Set<string>();
  for (let i = 0; i < compact.length - 1; i++) set.add(compact.slice(i, i + 2));
  return set;
}

/** Sørensen–Dice on bigrams: 1 for identical, 0 for nothing in common. */
function dice(a: string, b: string): number {
  const left = bigrams(a);
  const right = bigrams(b);
  if (left.size === 0 || right.size === 0) return a === b ? 1 : 0;

  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

/**
 * How much of the *shorter* name appears in the longer one.
 *
 * Containment rather than Jaccard, because a scanned line is routinely a
 * superset of the product name — "A4 COPIER 75 GSM 500 SHEETS REAM" against
 * "JK Copier A4 75gsm". Jaccard punishes the extra words; containment asks the
 * question that actually matters, which is whether one name is inside the
 * other.
 */
function tokenContainment(a: string, b: string): number {
  const left = new Set(tokensOf(a));
  const right = new Set(tokensOf(b));
  if (left.size === 0 || right.size === 0) return 0;

  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  let shared = 0;
  for (const token of small) if (large.has(token)) shared += 1;
  return shared / small.size;
}

/**
 * Similarity between two names, 0 to 1.
 *
 * The better of two measures rather than a blend: they fail in different ways
 * and averaging lets one drag down a match the other is certain about.
 * Containment catches "extra words on the invoice", bigrams catch "spelled
 * slightly differently".
 */
export function similarity(a: string, b: string): number {
  const left = normalize(a);
  const right = normalize(b);
  if (!left || !right) return 0;
  if (left === right) return 1;

  return Math.max(tokenContainment(a, b), dice(left, right));
}

export interface Candidate<T> {
  item: T;
  score: number;
}

/**
 * The best few matches for a scanned name, strongest first.
 *
 * `names` rather than a single name per item, so a product can be matched on
 * its aliases too — the names the shop actually says out loud, which are often
 * closer to what a supplier prints than the catalogue name is.
 */
export function rank<T>(
  query: string,
  items: T[],
  names: (item: T) => string[],
  options: { limit?: number; floor?: number } = {},
): Candidate<T>[] {
  const limit = options.limit ?? 3;
  /// Below this two names have nothing meaningful in common, and offering the
  /// match is worse than offering none — it invites a wrong confirmation.
  const floor = options.floor ?? 0.45;

  return items
    .map((item) => ({
      item,
      score: Math.max(0, ...names(item).map((name) => similarity(query, name))),
    }))
    .filter((candidate) => candidate.score >= floor)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * The single match, if there is an obvious one.
 *
 * Two conditions, and both matter. It has to be good on its own, and it has to
 * be clearly better than the runner-up — "Sharma Stationery" against "Sharma
 * Stationers" is two strong scores a hair apart, and picking one silently is
 * how a bill ends up on the wrong account.
 */
export function bestMatch<T>(
  query: string,
  items: T[],
  names: (item: T) => string[],
  options: { confident?: number; margin?: number } = {},
): { item: T; score: number; confident: boolean } | null {
  const confidentAt = options.confident ?? 0.8;
  const margin = options.margin ?? 0.12;

  const ranked = rank(query, items, names, { limit: 2, floor: 0.3 });
  const top = ranked[0];
  if (!top) return null;

  const runnerUp = ranked[1]?.score ?? 0;
  return {
    item: top.item,
    score: top.score,
    confident: top.score >= confidentAt && top.score - runnerUp >= margin,
  };
}
