// avgkeeper/scripts/decimal.mjs
// Exact decimals: no float ever decides an order size. dec, cmpDec and sizeFromQuote come from GridKeeper's
// removed place.mjs (git show 107c05f^:gridkeeper/scripts/place.mjs); budgets and shares are whole cents.
const PLAIN = /^\d+(\.\d+)?$/;
export function dec(v) {
  if (typeof v !== 'string' || v.length > 40 || !PLAIN.test(v)) return null;
  const [w, f = ''] = v.split('.');
  return { i: BigInt(w + f), s: f.length };
}
const scaled = (d, s) => d.i * 10n ** BigInt(s - d.s);
export function cmpDec(a, b) {
  const s = Math.max(a.s, b.s);
  const x = scaled(a, s);
  const y = scaled(b, s);
  return x === y ? 0 : x < y ? -1 : 1;
}
function writeDec(d, places) {
  const i = d.s > places ? d.i / 10n ** BigInt(d.s - places) : d.i * 10n ** BigInt(places - d.s);
  const t = i.toString().padStart(places + 1, '0');
  return places ? `${t.slice(0, -places)}.${t.slice(-places)}` : t;
}
const placesOf = (t) => (String(t).split('.')[1] || '').length;

// The base size a USDT amount buys at a price, floored to a whole multiple of lotSz. null on unreadable input.
export function sizeFromQuote(quoteStr, priceStr, inst) {
  const q = dec(quoteStr);
  const p = dec(priceStr);
  const lot = dec(String(inst && inst.lotSz));
  if (!q || !(q.i > 0n) || !p || !(p.i > 0n) || !lot || !(lot.i > 0n)) return null;
  const places = placesOf(inst.lotSz);
  const numerator = q.i * 10n ** BigInt(p.s + lot.s);
  const denominator = p.i * 10n ** BigInt(q.s) * lot.i;
  const lots = numerator / denominator;
  return writeDec({ i: lots * lot.i, s: places }, places);
}

// A USDT amount typed by the user, as whole cents: at most two decimals, digits only. null otherwise.
export function toCents(s) {
  if (typeof s !== 'string' || !/^\d{1,9}(\.\d{1,2})?$/.test(s)) return null;
  const [w, f = ''] = s.split('.');
  return Number(w) * 100 + Number((f + '00').slice(0, 2));
}
export const centsStr = (c) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
