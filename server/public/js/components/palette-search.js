// Fuzzy matching for the command palette. Pure functions, no DOM. Each word of the query must match somewhere:
// a plain substring scores highest (best at the start of the text), otherwise the letters must appear in order.
function scoreWord(word, text) {
  const at = text.indexOf(word);
  if (at >= 0) return 1000 - at * 2 - (text.length - word.length) * 0.1 + (at === 0 ? 200 : 0);
  let from = 0; let last = -2; let score = 0;
  for (const ch of word) {
    const i = text.indexOf(ch, from);
    if (i < 0) return -1;
    score += i === last + 1 ? 8 : 1;
    last = i; from = i + 1;
  }
  return score;
}

// Score of the query against the text, or -1 when it does not match. An empty query matches everything with 0.
export function fuzzy(query, text) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  const t = String(text || '').toLowerCase();
  let total = 0;
  for (const w of words) {
    const s = scoreWord(w, t);
    if (s < 0) return -1;
    total += s;
  }
  return total;
}

// Items that match, best first. `text(item)` gives the searchable string. Without a query the order is kept.
export function rank(items, query, text, limit = 50) {
  if (!String(query || '').trim()) return items.slice(0, limit);
  return items.map(item => ({ item, s: fuzzy(query, text(item)) })).filter(x => x.s >= 0).sort((a, b) => b.s - a.s).slice(0, limit).map(x => x.item);
}
