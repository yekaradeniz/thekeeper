// avgkeeper/scripts/runner.mjs
// Spawns the okx CLI. JSON calls pass an endpoint allowlist first.
// AVGKEEPER_OKX_BIN may point to another okx binary; a path ending in .mjs runs under the current Node.
import { spawn } from 'node:child_process';

// Exactly the endpoints this build calls. Add one only with the verb that needs it.
export const ALLOWLIST = new Set([
  'market instruments', 'market ticker',
  'account balance', 'account config',
  'spot place', 'spot get',
  'config show',
]);

// What the user is told when the account the CLI used is not the one this run is stamping its ledger with. It
// names both sides and the one flag that decides it; AvgKeeper never edits the okx config itself.
export const envMismatch = (said, demo, profile) => {
  const who = profile ? `profile ${profile}` : 'this profile';
  return demo
    ? `REFUSED: this run passed --demo, but the okx CLI used the live account for ${who}. Check that profile's demo setting in the okx config, then run it again.`
    : `REFUSED: the okx CLI used the demo account for ${who}, and this run did not pass --demo. Either pass --demo, or clear demo in that profile's okx config, then run it again.`;
};

// The CLI resolves demo from its own sources as well as this call's flag: a profile saved with demo = true, or
// OKX_DEMO in the environment, puts a run this build believes is live on the demo account instead, or the other
// way around. The envelope (--json --env's env/profile/data shape) is the one place the CLI states which account
// it actually used, and every read and every write comes through json() below, so the two are compared here,
// once, whichever path produced the envelope: an ordinary exit-0 reply, or the sCodeRejection safety net for a
// rejected write. A run that does not agree with its own account stops before anything else is trusted or
// written. Returns true when parsed is an env/data envelope (whether or not it matched), false otherwise, so a
// caller can tell an envelope it already checked from a bare reply that was never enveloped at all.
function checkEnvelope(parsed, demo, profile) {
  if (!(parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'env' in parsed && 'data' in parsed)) return false;
  const said = String(parsed.env || '');
  if ((said === 'demo') !== Boolean(demo) && (said === 'demo' || said === 'live')) {
    throw new OkxError(envMismatch(said, demo, profile), 'env');
  }
  return true;
}

export class OkxError extends Error {
  constructor(message, kind, stderr = '') {
    super(message);
    this.kind = kind;
    this.stderr = stderr;
  }
}

// CLI 1.4.6 (dist/index.js main().catch): every failure's stderr opens with this line, "Error: " then the
// message, an OKX rejection's own "[<sCode>] " echo left in when there is one. redactStderr reads the whole
// matched line, classify's own msg reads the raw text after "Error: ", and okxMessage strips a leading
// "[<sCode>] " from that same raw text. One export, so the CLI's own grammar is one edit, not three.
export const ERROR_LINE = /^Error: (.*)$/m;

// A TOML parse error from the okx CLI quotes the lines around the fault, which can hold api_key, secret_key or
// passphrase. AvgKeeper keeps only the first line (a deliberate exception to printing stderr verbatim).
export function redactStderr(s) {
  const t = String(s || '');
  if (/Invalid TOML document/.test(t)) {
    const first = (ERROR_LINE.exec(t) || [t.trim().split('\n')[0]])[0];
    return `${first}\nAvgKeeper hid the lines of your okx config because they can hold your keys. Fix the quoting in ~/.okx/config.toml yourself.`;
  }
  return t.split('\n').filter((l) => !/^\s*\d+\s*:\s{2}/.test(l) && !/^\s*\^\s*$/.test(l)).join('\n');
}

// okx --json config show prints every profile unmasked; AvgKeeper keeps no key material in memory or output.
// Both shapes of the reply are stripped, because every call this runner makes passes --env and so gets the
// enveloped one: the profiles then sit at parsed.data.profiles, not only at parsed.profiles (a lesson carried
// over from GridKeeper's 2026-09-20 review, security-11, where reading only the bare shape left the strip doing
// nothing at all for the reply the CLI actually sends). A promise about key material that nothing carries out is
// worse than no promise.
export function stripKeys(parsed) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  for (const holder of [parsed, parsed.data]) {
    const profiles = (holder && typeof holder === 'object' && holder.profiles) || {};
    for (const p of Object.values(profiles)) {
      if (p && typeof p === 'object') for (const k of ['api_key', 'secret_key', 'passphrase']) delete p[k];
    }
  }
  return parsed;
}

export function commandKey(args) {
  return args.slice(0, 2).join(' ');
}

// Writes are never spawned twice: a re-send could buy twice.
export const WRITES = new Set(['spot place']);

// CLI 1.4.6 prints Error, Code (business and HTTP errors only), TraceId, Hint and Version lines. Auth errors
// (50111 to 50113) and rate limits (50011, 50061) carry no Code line; their Hint names them. The TraceId and
// the prices in a message are never read.
//
// Proposal 26: a NetworkError (CLI 1.4.6 dist/index.js: every fetch that never reaches OKX, a DNS failure, a
// refused connection, no route) is wrapped in this fixed English wording regardless of the OS error underneath,
// and carries no Code line. Matching that wrapping text is the sturdier signal: the OS-level text it wraps
// (ECONNREFUSED, ENOTFOUND, EAI_AGAIN) varies by platform and Node version, so classify() never reaches for it.
// code is the process exit status of the call this stderr came from (undefined when a caller checks a bare
// string, as the tests below do): the caller here only ever classifies a call that did not exit 0, so a real
// network line is also checked against that fact rather than its wording alone.
export function classify(stderr, code) {
  const t = String(stderr || '');
  // 'Error' reuses ERROR_LINE rather than building its own copy of the same pattern; 'Code' and 'Hint' still
  // read the CLI's other two grammar lines the generic way they always have.
  const line = (name) => ((name === 'Error' ? ERROR_LINE : new RegExp(`^${name}: (.*)$`, 'm')).exec(t) || [])[1] || '';
  const msg = line('Error') || t.trim().split('\n')[0] || '';
  const errCode = line('Code');
  const hint = line('Hint');
  if (errCode === '401' || /^Check API key, secret, passphrase and permissions/.test(hint)
    || /^(No credentials found|Not logged in|Session expired)|okx-auth|Invalid OK-ACCESS/i.test(msg)) return 'auth';
  if (errCode === '429' || /^(Rate limited|Too many connections)/.test(hint) || /^HTTP 429\b|Too Many Requests/i.test(msg)) return 'rate';
  if (code !== 0 && !errCode && (/^Failed to call OKX endpoint\b/.test(msg) || /^Please check network connectivity and retry the request\b/.test(hint))) {
    return 'network';
  }
  return 'cli';
}

// The CLI's "Error:" line when there is one: an update notice or a blank line can come first on stderr.
export const firstLine = (s) => {
  const t = String(s || '');
  const m = ERROR_LINE.exec(t);
  return m ? m[0] : t.trim().split('\n')[0];
};

// OKX being unreachable is not a decision AvgKeeper made, so it is never worded as a refusal or a guard: nothing
// here was refused, and no rule fired; the connection between AvgKeeper and OKX simply failed. The CLI's own
// NetworkError message names the endpoint's method and path (`Failed to call OKX endpoint ${method} ${path}.`),
// which are not words a plain-English sentence reads out; this fixed sentence replaces it wherever a network
// failure is shown, and every caller already says which read or buy it was trying in the sentence around it
// (a lesson carried over from GridKeeper's 2026-09-26 review of the same CLI wrapper).
export function unreachableReason() {
  return 'AvgKeeper could not reach OKX';
}

// The text embedded inside an existing outcome sentence a caller already prints: AvgKeeper's own words for the
// reason when OKX could not be reached, OKX's own message with the CLI's "Error: " and "[code] " grammar stripped
// (okxMessage) otherwise. This never decides whether anything was sent or read; the caller's own read-back logic
// still does that, unchanged. Never firstLine here: firstLine keeps the whole "Error: ..." line, brackets
// included, which is the CLI's raw grammar a plain sentence should not carry.
export function reasonOf(e) {
  return e && e.kind === 'network' ? unreachableReason(e) : okxMessage(e.message);
}

// What a read, or a write that dies before it ever sends anything, says on its own: nothing happened yet here,
// so trying again once the connection is back is safe. A write that already sent something, or cannot prove it
// did not, never reaches for this; it stays with its own UNKNOWN-STATE-shaped sentence instead (see reasonOf).
export const NOTHING_SENT_TAIL = 'Nothing was read and nothing was sent. Try again once the connection is back.';
export function unreachableLine(e, tail = NOTHING_SENT_TAIL) {
  return `${unreachableReason(e)}. ${tail}`;
}

// CLI 1.4.6 prints "Error: [<sCode>] <sMsg>" and "Code: <sCode>" for an OKX rejection. These codes, a 5xx and a
// timeout leave the outcome unknown (OKX error code table), so they never count as a rejection. 51149 is OKX's
// "order timed out, please try again later": the order that timed out may still have filled, so it is never read
// as a rejection either.
export const AMBIGUOUS_CODES = ['50001', '50004', '50013', '50026', '51149'];
// One of those codes or a 5xx, wherever it appears: on stderr or in a reply row.
export const ambiguousCode = (c) => AMBIGUOUS_CODES.includes(String(c)) || /^5\d\d$/.test(String(c));
export const okxCode = (text) => (/^Code: (\S+)$/m.exec(String(text || '')) || [])[1] || null;
// A reason as a clause: no surrounding space and no closing period, because every sentence AvgKeeper builds around
// one adds its own punctuation. OKX's 50004 message is "API endpoint request timeout. ", which printed as
// "(API endpoint request timeout. )" and "timeout. . Check it" on the owner's demo, 2026-09-28.
export const clause = (text) => String(text || '').trim().replace(/\.+$/, '');
export const okxMessage = (text) => {
  const m = ERROR_LINE.exec(String(text || ''));
  return clause(m ? m[1].replace(/^\[\w+\] /, '') : firstLine(text));
};

// Whether a failure is worth reading again rather than a real answer: a plain network failure, a rate limit, a
// timeout, or a CLI failure whose own code is one OKX documents as ambiguous (50001, 50013, a 5xx transient
// server error). One reader for buy.mjs's own pre-send retries (withNetworkRetry), readOrder's own network flag
// (orders.mjs) and lastPrices' own rethrow (today.mjs), so a later edit that widens or narrows what is worth
// retrying cannot do it for only one of the three and leave the others reading the same OKX reply differently
// (ProjectBuilder rule 3, one fact one reader; review findings, buy.mjs:315, orders.mjs:59, today.mjs:47).
export function isRetryable(e) {
  if (!e) return false;
  if (e.kind === 'network' || e.kind === 'rate' || e.kind === 'timeout') return true;
  if (e.kind === 'cli') return ambiguousCode(okxCode(e.stderr || e.message));
  return false;
}

function spawnOnce(bin, argv, env, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(bin, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let timedOut = false;
    // Settle at the timeout itself: a grandchild (okx-auth) can hold stderr open long after the kill.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ code: null, out, err, timedOut: true });
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    // ENOENT is the okx CLI not being there at all, which no retry and no reading of its stderr can explain.
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 127, out: '', err: String(e.message), timedOut: false, missing: e.code === 'ENOENT' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err, timedOut });
    });
  });
}

// This is the MAIN path for a rejected buy, not a fallback. CLI 1.4.6's `spot place` handler
// (dist/index.js, spot_place_order) never goes through normalizeWrite, the throw-on-bad-sCode path some other
// write commands use; it returns normalizeResponse(response) instead (dist/index.js, around line 12256), which
// only ever carries endpoint, requestTime and data, whatever OKX answered. The CLI's own logger wrapper then
// calls markFailedIfSCodeError(result.data) (dist/index.js, around line 23494): it sets process.exitCode = 1
// when any row's sCode is not "0", but it never throws and it never writes to stderr, so a rejected buy exits 1
// with the reply rows still on stdout, enveloped in --json --env's env/profile/data shape, and stderr empty.
// classify() only ever reads stderr, so it would never see this rejection at all. This function reads stdout
// instead: OKX's own answer, not a CLI failure, so the caller reads sCode and sMsg itself rather than seeing an
// error. Returns the reply when it is exactly that, null otherwise.
// A row with sCode undefined, null or blank is not OKX naming a code at all, so it proves no rejection (rule 2):
// only a row that actually holds a non-zero code counts. orders.mjs's sendBuy reads the very same rows this
// function found (via the reply it returns), so both read sCode the same way here (rule 3, one fact one reader).
export const sCodeMissing = (sCode) => sCode === undefined || sCode === null || (typeof sCode === 'string' && sCode.trim() === '');
function sCodeRejection(out, demo, profile) {
  let parsed;
  try {
    parsed = out.trim() ? JSON.parse(out) : null;
  } catch {
    return null;
  }
  const enveloped = Boolean(parsed) && typeof parsed === 'object' && !Array.isArray(parsed) && 'env' in parsed && 'data' in parsed;
  const data = enveloped ? parsed.data : parsed;
  const rows = Array.isArray(data) ? data : [];
  if (!rows.some((x) => x && typeof x === 'object' && !sCodeMissing(x.sCode) && String(x.sCode) !== '0')) return null;
  return enveloped ? parsed : { env: demo ? 'demo' : 'live', profile: profile || null, data };
}

// The environment variables the okx CLI reads a key from ahead of the named profile. AvgKeeper removes them from
// every call it makes (createRunner below), so a key exported in the shell for some other tool never silently
// wins over the profile this run names.
export const OKX_KEY_ENV = ['OKX_API_KEY', 'OKX_SECRET_KEY', 'OKX_PASSPHRASE'];
// Every variable the CLI reads ahead of the profile's own settings: the key, the demo switch, the site and the
// host. A lesson carried over from GridKeeper's 2026-09-21 re-review (E1, E2): OKX_DEMO left set in a shell for
// another tool sent a live write to the demo account instead, and OKX_API_BASE_URL sent every private call, key
// and passphrase headers included, to whatever host it named. The profile this run names, with --demo where the
// user passes it, is the account and the host, always.
export const OKX_SHADOW_ENV = [...OKX_KEY_ENV, 'OKX_DEMO', 'OKX_SITE', 'OKX_API_BASE_URL'];

export function createRunner({ env = process.env, bin, binArgs, timeoutMs = 60000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  // CLI 1.4.6 skips its update notice only for the exact string "false"; the notice would precede every error.
  // The three key variables are dropped: the pinned CLI reads `process.env.OKX_API_KEY ?? toml.api_key` (and the
  // same for the secret and the passphrase), so a key exported in the shell for some other tool would otherwise
  // silently win over the profile this run names on every call.
  env = { ...env, OKX_UPDATE_CHECK: 'false' };
  for (const k of OKX_SHADOW_ENV) delete env[k];
  let pre = binArgs || [];
  if (!bin) {
    const envBin = env.AVGKEEPER_OKX_BIN;
    if (envBin && envBin.endsWith('.mjs')) {
      bin = process.execPath;
      pre = [envBin];
    } else {
      bin = envBin || 'okx';
    }
  }

  // Text calls serve only --version and plain --help; anything else is refused before it spawns.
  async function raw(args) {
    const help = args.length > 1 && args[args.length - 1] === '--help' && args.slice(0, -1).every((a) => /^[a-z][a-z-]*$/.test(a));
    if (!help && !(args.length === 1 && args[0] === '--version')) {
      throw new OkxError(`REFUSED: internal: raw ${args.join(' ')} is not a version or help call.`, 'allowlist');
    }
    const r = await spawnOnce(bin, [...pre, ...args], env, timeoutMs);
    return { code: r.code, out: r.out, err: r.err };
  }

  async function json(args, { profile, demo } = {}) {
    const key = commandKey(args);
    if (!ALLOWLIST.has(key)) throw new OkxError(`REFUSED: internal: ${key} is not on the endpoint allowlist.`, 'allowlist');
    const argv = ['--json', '--env', ...(profile ? ['--profile', profile] : []), ...(demo ? ['--demo'] : []), ...args];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const r = await spawnOnce(bin, [...pre, ...argv], env, timeoutMs);
      if (r.timedOut) throw new OkxError(`okx ${key} timed out after ${timeoutMs} ms`, 'timeout');
      if (r.missing) throw new OkxError(`could not start ${bin}: ${r.err}`, 'missing');
      if (r.code === 1 && WRITES.has(key) && !r.err.trim()) {
        const rejected = sCodeRejection(r.out, demo, profile);
        if (rejected) {
          checkEnvelope(rejected, demo, profile);
          return rejected;
        }
      }
      if (r.code === 0) {
        let parsed;
        try {
          parsed = r.out.trim() ? JSON.parse(r.out) : null;
        } catch {
          // What the CLI actually printed belongs in the message, not only in stderr: a lesson carried over from
          // GridKeeper's 2026-09-20 review (okx-3), where a build's CLI answered a read with plain text on stdout
          // and exit 0, and every reader of the error saw only "unparseable reply", with no clue why. One line,
          // redacted, and never for config show, whose stdout holds key material.
          const body = key === 'config show' ? '' : redactStderr(r.out.slice(0, 200));
          const said = firstLine(body);
          throw new OkxError(`unparseable reply from okx ${key}${said ? `: ${said}` : ''}`, 'parse', body);
        }
        if (key === 'config show') stripKeys(parsed);
        if (checkEnvelope(parsed, demo, profile)) return parsed;
        return { env: demo ? 'demo' : 'live', profile: profile || null, data: parsed };
      }
      const kind = classify(r.err, r.code);
      if (kind === 'rate' && attempt === 0 && !WRITES.has(key)) {
        await sleep(2000);
        continue;
      }
      const err = redactStderr(r.err);
      throw new OkxError(err.trim() || `okx ${key} exited with code ${r.code}`, kind, err);
    }
    throw new OkxError(`okx ${key} was rate limited twice`, 'rate');
  }

  return { raw, json };
}
