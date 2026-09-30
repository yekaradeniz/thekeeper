// avgkeeper/scripts/units.mjs
// Number reading and formatting. A field OKX did not send is NaN, never 0 (ProjectBuilder CLAUDE.md rule 1).
export const MINUTE_MS = 60000;
export const DAY_MS = 86400000;

const PLAIN = /^-?\d+(\.\d+)?(e-?\d+)?$/i;
export function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v !== 'string' || !PLAIN.test(v)) return NaN;
  return Number(v);
}

// The UTC minute of a millisecond time, the one formatter for it (GridKeeper's isoMinute). A number only: new
// Date(null) is 1970, a time nobody recorded.
export function isoMinute(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return 'an unreadable time';
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? 'an unreadable time' : `${d.toISOString().slice(0, 16)}Z`;
}

// toFixed prints a signed zero as "-0.00" for any v in (-0.005, 0): a rounding artifact, not a negative amount.
const noSignedZero = (s) => (s === '-0.00' || s === '-0' ? s.slice(1) : s);

export const usd = (v) => (Number.isFinite(v) ? noSignedZero(v.toFixed(2)) : '?');
export const pct = (ratio) => (Number.isFinite(ratio) ? noSignedZero((ratio * 100).toFixed(2)) : '?');

// A decimal digit string, sign and point stripped, with leading zeros dropped: the significant digits alone.
const sigDigits = (s) => (String(s).replace(/^-/, '').replace('.', '').replace(/^0+/, '') || '0');

// Converts a toPrecision result back out of exponential notation, decimal only, for a display string.
function expFixed(s) {
  const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/i.exec(s);
  if (!m) return s;
  const [, sign, lead, frac = '', expStr] = m;
  const digits = lead + frac;
  const point = 1 + Number(expStr);
  let out;
  if (point <= 0) out = `0.${'0'.repeat(-point)}${digits}`;
  else if (point >= digits.length) out = digits + '0'.repeat(point - digits.length);
  else out = `${digits.slice(0, point)}.${digits.slice(point)}`;
  return `${sign}${out}`;
}

// A price string shown with at most `sig` significant digits (default 8), decimal notation, never exponential.
// A price that already reads within `sig` significant digits is returned exactly as it came in, trailing zeros and
// all. Only for display: nothing that computes an order size reads this.
export function sigPrice(s, sig = 8) {
  const str = String(s);
  if (sigDigits(str).length <= sig) return str;
  const v = num(s);
  if (!Number.isFinite(v)) return str;
  const neg = v < 0;
  const out = expFixed(Math.abs(v).toPrecision(sig));
  return neg ? `-${out}` : out;
}
