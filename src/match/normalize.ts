/** Lowercase, fold Norwegian letters and diacritics, strip punctuation, collapse whitespace. */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/å/g, 'a')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function tokens(s: string): string[] {
  const n = normalizeText(s);
  return n ? n.split(' ') : [];
}

function prefixShare(from: string[], to: string[]): number {
  if (!from.length) return 0;
  const hits = from.filter((t) => to.some((u) => u.startsWith(t))).length;
  return hits / from.length;
}

/** Fuzzy match score in 0..1: 1 exact, 0.9 prefix either way, else best token prefix share. */
export function matchScore(query: string, label: string): number {
  const q = normalizeText(query);
  const l = normalizeText(label);
  if (!q || !l) return 0;
  if (q === l) return 1;
  if (l.startsWith(q) || q.startsWith(l)) return 0.9;
  const qt = q.split(' ');
  const lt = l.split(' ');
  return Math.max(prefixShare(qt, lt), prefixShare(lt, qt));
}

function containedShare(from: string[], to: string[]): number {
  if (!from.length) return 0;
  return from.filter((t) => t.length >= 4 && to.some((u) => u.includes(t))).length / from.length;
}

/** Compound-word aware score in 0..1: max(matchScore, 0.95 when equal ignoring spaces, 0.8 × share of ≥4-char tokens contained in a token of the other side). */
export function fuzzyScore(query: string, label: string): number {
  const q = normalizeText(query);
  const l = normalizeText(label);
  if (!q || !l) return 0;
  const joined = q.replace(/ /g, '') === l.replace(/ /g, '') ? (q === l ? 1 : 0.95) : 0;
  const qt = q.split(' ');
  const lt = l.split(' ');
  const compound = 0.8 * Math.max(containedShare(qt, lt), containedShare(lt, qt));
  return Math.max(matchScore(query, label), joined, compound);
}
