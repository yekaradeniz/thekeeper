// avgkeeper/tests/helpers.mjs
// Shared test doubles. The temp guard loads with this file, so a test file run on its own still cleans up.
import './tmp-guard.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../scripts/store.mjs';
import { ALLOWLIST, OkxError, commandKey } from '../scripts/runner.mjs';

// 2026-10-05 is a Monday; 07:00 UTC is 10:00 in Europe/Istanbul (UTC+3, no daylight saving).
export const T0 = Date.UTC(2026, 9, 5, 7, 0);
export const TZ = 'Europe/Istanbul';
export const HOUR = 3600000;
export const DAY = 86400000;

export const AK_ROOT = fileURLToPath(new URL('../', import.meta.url));
export const tmpDir = (prefix = 'ak-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
export const text = (ctx) => ctx.lines.join('\n');

// One `account balance` detail row the way OKX sends it: every figure a string. eq is left undefined by default
// (never invented, rule 1): a test that reads it (holdings' own amount column) passes it explicitly.
export const bal = (ccy, { eqUsd = '100', openAvgPx = '100', spotUplRatio = '0', availBal = '0', eq } = {}) => ({
  ccy, eqUsd, openAvgPx, spotUplRatio, availBal, ...(eq === undefined ? {} : { eq }),
});

export const NOT_FOUND_TEXT = 'Error: Order does not exist\nCode: 51603\n';
export const notFound = () => new OkxError(NOT_FOUND_TEXT, 'cli', NOT_FOUND_TEXT);

// A stateful stand-in for OKX. Orders a test sends are kept and read back as filled at the ticker price, unless
// placeReply or getReply answers first (return an Error to throw it, a row array or row to answer with it).
export function fakeExchange({
  balances = [], prices = {}, instruments = null, perm = 'read_only,trade', ip = undefined, version = '1.4.6', site = 'global',
  help = 'okx spot place --instId --side --ordType --sz --tgtCcy --clOrdId --aiBuilderCode', placeReply = null, getReply = null,
} = {}) {
  const calls = [];
  const orders = new Map();
  const inst = instruments || Object.keys(prices).map((id) => ({
    instId: id, quoteCcy: 'USDT', state: 'live', minSz: '0.00001', lotSz: '0.00000001', tickSz: '0.01',
  }));
  return {
    calls,
    orders,
    async raw(args) {
      calls.push({ type: 'raw', args });
      if (args[0] === '--version') return { code: 0, out: `${version}\n`, err: '' };
      return { code: 0, out: help, err: '' };
    },
    async json(args, call = {}) {
      const key = commandKey(args);
      calls.push({ type: 'json', args, call });
      if (!ALLOWLIST.has(key)) throw new OkxError(`REFUSED: internal: ${key} is not on the endpoint allowlist.`, 'allowlist');
      const env = { env: call.demo ? 'demo' : 'live', profile: call.profile || null };
      const flag = (f) => args[args.indexOf(f) + 1];
      switch (key) {
        case 'config show':
          return { ...env, data: { profiles: { t: { site } } } };
        case 'account config':
          return { ...env, data: [{ perm, ...(ip === undefined ? {} : { ip }) }] };
        case 'account balance':
          return { ...env, data: [{ details: balances }] };
        case 'market instruments':
          return { ...env, data: inst };
        case 'market ticker':
          return { ...env, data: [{ instId: args[2], last: prices[args[2]] }] };
        case 'spot place': {
          if (placeReply) {
            const r = placeReply(args);
            if (r instanceof Error) throw r;
            if (r) return { ...env, data: r };
          }
          const id = flag('--clOrdId');
          orders.set(id, { instId: flag('--instId'), sz: flag('--sz') });
          return { ...env, data: [{ clOrdId: id, ordId: String(orders.size), sCode: '0', sMsg: '' }] };
        }
        case 'spot get': {
          const id = flag('--clOrdId');
          if (getReply) {
            const r = getReply(id, orders.get(id));
            if (r instanceof Error) throw r;
            if (r) return { ...env, data: [r] };
          }
          const o = orders.get(id);
          if (!o) throw notFound();
          const px = prices[o.instId];
          // accFillSz is the total filled so far; fillSz (the last fill only) is deliberately half of that here,
          // so a reader still keyed on fillSz fails instead of passing by coincidence.
          const total = (Number(o.sz) / Number(px)).toFixed(8);
          return { ...env, data: [{ clOrdId: id, state: 'filled', fillSz: (Number(total) / 2).toFixed(8), accFillSz: total, avgPx: px }] };
        }
        default:
          throw new OkxError(`fake okx has no reply for ${key}`, 'cli');
      }
    },
  };
}

export const places = (okx) => okx.calls.filter((c) => c.type === 'json' && commandKey(c.args) === 'spot place');

// A context like the entry script's, with a temp store, a settable clock and recorded output and notices.
export function makeCtx({ okx = fakeExchange(), env = {}, now = T0, config } = {}) {
  const store = createStore(tmpDir('ak-store-'));
  if (config) store.writeConfig(config);
  let clock = now;
  const ctx = {
    okx,
    store,
    env,
    lines: [],
    notified: [],
    mailed: [],
    timeZone: TZ,
    platform: 'darwin',
    realHome: '/Users/test',
    now: () => clock,
    setNow: (ms) => { clock = ms; },
    out: (l) => ctx.lines.push(l),
    sleep: async () => {},
    runNotify: async (cmd, line) => { ctx.notified.push(line); },
    // A test-double lane 1: records the call instead of spawning anything, resolving unless mailFails is set (an
    // Error to reject with, matching runMail's own contract, or true for a generic failure).
    runMail: async (cmd, body, subject, to) => {
      if (ctx.mailFails) throw (ctx.mailFails instanceof Error ? ctx.mailFails : new Error('mail command failed'));
      ctx.mailed.push({
        cmd, body, subject, to,
      });
    },
    runChild: async () => ({ code: 0, stdout: '', stderr: '' }),
  };
  return ctx;
}

export const kinds = (ctx) => ctx.store.readLedger().map((e) => e.kind);
export const OWNER = { AVGKEEPER_OWNER_TEST: '1' };
export const SCHEDULED = { AVGKEEPER_SCHEDULED: '1', AVGKEEPER_OWNER_TEST: '1' };
export const CALL = { profile: 't', demo: false };

// The owner's account as read on 2026-09-26, with ETH and BTC moved into loss for the tests.
export const LOSING = {
  balances: [
    bal('USDT', { eqUsd: '1484.90', availBal: '1484.90', openAvgPx: '', spotUplRatio: '' }),
    bal('ETH', { eqUsd: '208.90', spotUplRatio: '-0.10' }),
    bal('BTC', { eqUsd: '809.86', spotUplRatio: '-0.05' }),
    bal('SOL', { eqUsd: '406.24', spotUplRatio: '0.1955' }),
  ],
  prices: { 'ETH-USDT': '1767.30', 'BTC-USDT': '84000.0', 'SOL-USDT': '121.13' },
};

// A small state machine, not a full JS parser: it only has to tell code and comments apart, so that a real
// sentence in a comment (documentation, a design note) is not mistaken for code, while every string and template
// literal, including a nested template inside a `${...}` expression, is kept intact for a pattern search. Regex
// literals are skipped as literals too, so a `//` inside one is never read as the start of a line comment. Used by
// tests/cmdtext.test.mjs and tests/independence.test.mjs.
export function withoutComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  // stack of 'template' (raw template text) or 'interp' (code inside a template's ${...}); code outside any
  // template needs no stack entry, it is simply the state when the stack is empty.
  const stack = [];
  let lastSignificant = '';
  const inTemplateInterp = () => stack.length && stack[stack.length - 1].kind === 'interp';

  while (i < n) {
    const top = stack.length ? stack[stack.length - 1] : null;

    if (top && top.kind === 'template') {
      const c = src[i];
      if (c === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
      if (c === '`') { stack.pop(); out += c; i += 1; continue; }
      if (c === '$' && src[i + 1] === '{') { stack.push({ kind: 'interp', depth: 0 }); out += '${'; i += 2; continue; }
      out += c;
      i += 1;
      continue;
    }

    // Code mode: top-level, or inside a template's ${...} interpolation.
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j += 1;
      i = j;
      continue;
    }
    if (c === '/' && c2 === '*') {
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j += 1;
      i = Math.min(j + 2, n);
      continue;
    }
    if (c === '\'' || c === '"') {
      const quote = c;
      out += c;
      i += 1;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
        out += src[i];
        i += 1;
      }
      if (i < n) { out += src[i]; i += 1; }
      lastSignificant = quote;
      continue;
    }
    if (c === '`') {
      stack.push({ kind: 'template' });
      out += c;
      i += 1;
      lastSignificant = '`';
      continue;
    }
    // A `/` not already caught above as `//` or `/*`: a regex literal unless the previous significant character
    // reads as the end of a value (identifier, number, `)`, `]`), in which case it is division.
    if (c === '/' && !/[\w)\]]/.test(lastSignificant)) {
      let j = i + 1;
      let inClass = false;
      while (j < n && (inClass || src[j] !== '/')) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '\n') break; // an unterminated "regex" is not one; bail out and treat `/` literally
        j += 1;
      }
      if (j < n && src[j] === '/') {
        j += 1;
        while (j < n && /[a-z]/i.test(src[j])) j += 1; // flags
        out += src.slice(i, j);
        i = j;
        lastSignificant = 'y'; // a value, for the next `/`'s own division-vs-regex check
        continue;
      }
      // fall through: not a regex after all, treat as a plain character below
    }
    if (inTemplateInterp()) {
      if (c === '{') { top.depth += 1; out += c; i += 1; lastSignificant = c; continue; }
      if (c === '}') {
        if (top.depth === 0) { stack.pop(); out += c; i += 1; lastSignificant = c; continue; }
        top.depth -= 1;
        out += c;
        i += 1;
        lastSignificant = c;
        continue;
      }
    }
    out += c;
    if (!/\s/.test(c)) lastSignificant = c;
    i += 1;
  }
  return out;
}
