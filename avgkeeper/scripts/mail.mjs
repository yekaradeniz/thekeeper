// avgkeeper/scripts/mail.mjs
//
// Mail notices: what the user is told about a scheduled buy when nobody is at the machine to read it.
// Design: docs/superpowers/specs/2026-09-26-avgkeeper-design.md section 9. This ports GridKeeper's removed mail
// design (docs/research/2026-09-15-mail-notices.md, code at git show 107c05f^:gridkeeper/scripts/mail.mjs);
// that document's rules hold here unless section 9 says otherwise. The one difference big enough to name: mail has
// no topic list here. AvgKeeper mails what a scheduled buy did (its outcomes), and, from stop or plan --confirm,
// a stale period an earlier run left behind (review finding, manage.mjs:201, paths lens; SKILL.md's own Network
// calls section names this too), so the switch is the same three-word level buy's own notify command already uses
// (off, problems, all), not a per-topic on/off map.
//
// Everything through pendingNotices/noticeDelivery is a pure function: no okx call, no clock of its own, no
// network. mailBody puts the run's own printed `line` in unchanged (research doc section 2, its own rule born from
// a real incident: the screen and a mail must never have two different authors). A test pins that the body
// contains the printed line byte for byte.
//
// mail.mjs imports readConfigSafe and shouldNotify from notify.mjs, and notify.mjs's tell() imports prepareMail
// from here. Both sides use the other module's export only inside a function body, never at module-top-level, so
// the import cycle never touches an uninitialized binding (Node evaluates each module's own top-level statements
// before either side calls into the other).
import {
  readConfigSafe, NOTIFY_LEVELS, shouldNotify, runShellPiped, NOTIFY_TIMEOUT_MS, LEVEL_WORDS,
} from './notify.mjs';
import { modeOf } from './planview.mjs';
import { localParts } from './period.mjs';
import { usd } from './units.mjs';
import { toCents, centsStr } from './decimal.mjs';
import { commandText, shWord } from './cmdtext.mjs';

// The raw mail object of config.json, or {} when it has the wrong shape. mail --to and --level merge their one key
// into this, so a key they do not own (command, which the user writes) is kept exactly as the user wrote it.
const mailBlock = (config) => ((config && config.mail && typeof config.mail === 'object' && !Array.isArray(config.mail)) ? config.mail : {});
const rawTo = (config) => (typeof mailBlock(config).to === 'string' ? mailBlock(config).to.trim() : '');

// The mail block of ~/.avgkeeper/config.json, read the way every config read in this product is read: a value of
// the wrong shape is absent, never a crash and never a guess.
//
//   { "mail": { "to": "someone@example.com", "level": "problems", "command": "..." } }
//
// level absent or not one of off/problems/all is off: mail never starts on its own, the same rule notify's own
// levelOf follows for its own key. command is optional and user-written, like notify; AvgKeeper never writes it.
// to passes the same check mail --to makes, on every read: an address edited into the file by hand (a comma is how
// a second recipient is smuggled in) is no address, and mailToRefusal says why.
export function mailConfig(config) {
  const m = mailBlock(config);
  const raw = rawTo(config);
  const to = raw && !mailAddressRefusal(raw) ? raw : null;
  const level = NOTIFY_LEVELS.includes(m.level) ? m.level : 'off';
  const command = typeof m.command === 'string' && m.command.trim() ? m.command.trim() : null;
  return { to, level, command };
}

// Why the address written in config.json is not used, or null when there is none or it passes.
export const mailToRefusal = (config) => (rawTo(config) ? mailAddressRefusal(rawTo(config)) : null);

// An address AvgKeeper will accept, and the sentence it refuses with otherwise (research doc section 6, ported
// unchanged but for the product name). Deliberately strict and deliberately shallow: one @, something on either
// side, a dot in the domain, no whitespace, no control character, no comma or semicolon (how a second recipient
// would be smuggled in). AvgKeeper never repairs an address, never lowercases it, never trims inside it: an
// address is not this product's to normalise, and a silently corrected one is how mail reaches the wrong person.
export function mailAddressRefusal(raw) {
  const v = typeof raw === 'string' ? raw : '';
  if (!v.trim()) return 'an email address is required: pass --to <address>. AvgKeeper never guesses one.';
  if (v !== v.trim()) return `"${v.trim()}" has a space at one end. Pass the address with no surrounding spaces.`;
  if (/[\s]/.test(v)) return `"${v}" contains a space. An email address has none.`;
  // Char codes, not a regex: a control-character class written as an escape is a literal control byte the moment
  // anything rewrites this file, and a source file with a NUL in it is its own bug.
  if ([...v].some((ch) => ch.codePointAt(0) < 0x20 || ch.codePointAt(0) === 0x7f)) return 'that address contains a control character. Pass a plain address.';
  // An invisible format character (zero-width space, a direction mark) reads back identical on screen but makes a
  // different address: the read-back the user confirms by could not show it.
  if (/\p{Cf}/u.test(v)) return 'that address contains an invisible formatting character, often carried in by a paste. Type the address by hand.';
  if (/[,;]/.test(v)) return `"${v}" contains a comma or a semicolon. AvgKeeper sends to one address; pass one.`;
  const parts = v.split('@');
  if (parts.length !== 2) return `"${v}" is not one address: an address has exactly one @.`;
  const [local, domain] = parts;
  if (!local) return `"${v}" has nothing before the @.`;
  if (!domain) return `"${v}" has nothing after the @.`;
  if (!domain.includes('.')) return `"${v}" has no dot after the @, so it names no domain.`;
  if (domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) return `"${v}" has a misplaced dot after the @.`;
  return null;
}

// The scope a notice belongs to when no plan exists yet to give it one: a ledger read that fails before buy ever
// reaches activePlan (an unreadable ledger, a torn line, a newer schema) has no plan id. Scoped to the account
// rather than left blank, so two different profiles' pre-plan failures on one shared ~/.avgkeeper never collide.
export const noPlanId = (call) => `noplan-${call.profile || 'noprofile'}-${modeOf(call)}`;

// The local calendar date for an event with no period of its own (a warning or a lock contention that fires
// before due() has picked a period). Machine time, the same clock buy already reads for the ledger's own local
// dates (period.localParts), not the plan's own time zone: this label is for a human reading a mail today, not for
// deciding whether a buy is due.
export const localDate = (ctx) => localParts(ctx.now(), ctx.timeZone || 'UTC').date;

// One notice per event: <planId>:<period>:<kind>. An id already in the ledger is never prepared again (prepareMail
// below), the same guarantee guard 34 check 11 gives the buy lock itself: a second attempt at the same event
// cannot mail a second time even if everything else about it were to go wrong. kind is buy, skip, halt or resolve
// for a period's own outcome, and tz or lock for the warnings that come before any period is decided: those take
// the local date (or the due period), which is also a skip's period, so sharing the word skip would let the
// warning's id swallow the real skip's notice on the same day.
// Review finding (mail.mjs:92, later): this comment fell behind the mail.mjs:307 fix. A halt with no period of
// its own (an auth failure before due() ever picked one) is life-scoped: prepareMail passes `<planId>.<life ts>`
// as the `planId` argument here, not the bare plan id, so two different lives never share one halt id on the same
// day. The shape below is unchanged; only what a caller may pass as planId grew.
export const noticeId = (planId, period, kind) => `${planId}:${period}:${kind}`;

// [AvgKeeper / <profile> <mode>] <fact>. Not generic, on the owner's own instruction (research doc section 7):
// the same mailbox carries other work, so the prefix has to be something a mail filter can match and nothing else
// running on the machine will produce. Profile and mode come first, so a demo run can never be mistaken for a real
// one in an inbox. Every number in `fact` is one the run already read; nothing here is computed for the subject
// alone.
export function mailSubject({ profile, demo, fact }) {
  return `[AvgKeeper / ${profile || 'no profile'} ${demo ? 'demo' : 'live'}] ${fact}`;
}

// The last line of every body, always, in one place: the id that makes a repeat recognisable. Lane 1 (the user's
// own command) and lane 2 (a later assistant session) cannot see each other, so a duplicate is possible in
// principle; this is what lets the user tell one apart from a second buy.
export const noticeFooter = (id) => `AvgKeeper notice id: ${id}`;

// The line buy already printed, with its leading "AvgKeeper" (or "AvgKeeper:") stripped, for reuse as the
// subject's fact when a kind has no more specific fact builder of its own (skip, halt, resolve). The full
// sentence still goes into the body unchanged (mailBody); this only shortens it for a subject line.
const FACT_PREFIX = /^AvgKeeper:?\s*/;
export const factFromLine = (line) => String(line).replace(FACT_PREFIX, '') || String(line);
// Spec section 9's subject shape is `<fact> (<period>)`: a fact whose line already names the period keeps it once.
const withPeriod = (fact, period) => (fact.includes(period) ? fact : `${fact} (${period})`);
// Review finding (mail.mjs:313, later): a halt's own line can run 250 to 480 characters (OKX's key-rule citation,
// or a list of order ids to check), and the whole line already reached the subject unshortened. Cut to its first
// clause, then to this length, so the subject stays a subject; the full line is unchanged as the body's own first
// line (mailBody).
export const SUBJECT_FACT_MAX = 100;
// The index of the first ". " that sits outside every parenthesis, or -1 when there is none. Review finding
// (mail.mjs:126, later): splitting on the bare first ". " cut inside a reason's own parenthetical aside whenever
// that aside carried a sentence of its own (OKX's "Invalid Sign. Please check your secret key", the exact shape
// reasonOf can return), leaving the subject with an opening paren and no closing one.
function firstClauseEnd(s) {
  let depth = 0;
  for (let i = 0; i < s.length - 1; i += 1) {
    if (s[i] === '(') depth += 1;
    else if (s[i] === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && s[i] === '.' && s[i + 1] === ' ') return i;
  }
  return -1;
}
function haltFact(line) {
  const fact = factFromLine(line);
  const end = firstClauseEnd(fact);
  const first = end === -1 ? fact : fact.slice(0, end);
  if (first.length <= SUBJECT_FACT_MAX) return first;
  // Review finding (mail.mjs:126, later): a plain character cut can land mid-word (a settle halt's first clause
  // is largely orderName, so the cut often did). Cut at the last space at or before the limit instead, so the
  // subject always ends on a whole word.
  const cut = first.slice(0, SUBJECT_FACT_MAX - 3);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}...`;
}

// Per-order detail lines, read from the ledger's own buy_sent and buy_filled lines, never recomputed (spec section
// 9): the share this run tried to send, what OKX actually filled and at what price, the notional OKX reports, and
// the coin's loss percent at buy time. By default every fill of one period; with clOrdIds, exactly those orders,
// whatever their period (a later read-back names only what it settled itself). A rejected or still-waiting order
// has no buy_filled line and so no detail line here; its own sentence is already part of the printed `line` this
// notice carries unchanged.
export function buyOrderLines(ledger, planId, period, clOrdIds = null) {
  const wanted = (e) => e.planId === planId && (clOrdIds ? clOrdIds.includes(e.clOrdId) : e.period === period);
  const sent = new Map();
  for (const e of ledger) {
    if (e.kind === 'buy_sent' && wanted(e)) sent.set(e.clOrdId, e);
  }
  const lines = [];
  for (const e of ledger) {
    if (e.kind !== 'buy_filled' || !wanted(e)) continue;
    const s = sent.get(e.clOrdId);
    const share = s ? `${s.amount} USDT` : 'an unrecorded share';
    const loss = s && Number.isFinite(Number(s.lossPct)) ? `${Number(s.lossPct).toFixed(2)}%` : 'an unrecorded loss';
    const notional = Number.isFinite(e.notional) ? `${usd(e.notional)} USDT` : 'an unrecorded notional';
    lines.push(`  ${e.instId}: share ${share}, loss ${loss} at buy time, filled ${e.accFillSz} at ${e.avgPx} USDT, notional ${notional}.`);
  }
  return lines;
}

// The subject fact for a finished buy: what filled, read the same way buyOrderLines reads it, never a copy of the
// share this run tried to send. "bought nothing" when every order was rejected or is still waiting; that outcome
// is still a finished period, not a skip, since a skip means the period was never attempted at all. The total adds
// each coin's notional as the summary prints it (usd, to the cent), so the subject and the body's first line never
// differ by a rounding cent.
function buyFact(ledger, planId, period) {
  const filled = ledger.filter((e) => e.kind === 'buy_filled' && e.planId === planId && e.period === period);
  if (!filled.length) return `bought nothing (${period})`;
  const cents = filled.reduce((sum, e) => sum + (toCents(usd(e.notional)) || 0), 0);
  return `bought ${centsStr(cents)} USDT across ${filled.length} coin${filled.length === 1 ? '' : 's'} (${period})`;
}

// The body: the run's own printed line first and unchanged, then the per-order details a screen already showed
// less of, the plan line when one is known, who this account is, and the footer every notice ends with.
export function mailBody({
  line, details = [], planLine = null, profile, demo, id,
}) {
  return [
    line,
    ...(details.length ? ['', ...details] : []),
    ...(planLine ? ['', planLine] : []),
    '',
    `Profile ${profile || 'no profile'}, ${demo ? 'demo, practice money' : 'live, real money'}.`,
    '',
    noticeFooter(id),
  ].join('\n');
}

// The notices with no delivery recorded, oldest first. A notice is prepared before any attempt to send it and
// marked only after one succeeds, so an attempt that failed, timed out, or was never configured leaves the notice
// here rather than losing it. This is the whole of lane 2's state: there is no second file.
export function pendingNotices(ledger) {
  const sent = new Set(ledger.filter((e) => e.kind === 'notice_sent').map((e) => String(e.id)));
  return ledger.filter((e) => e.kind === 'notice' && !sent.has(String(e.id)));
}

// This profile and mode's own undelivered notices (a notice carries the profile and env it was prepared for, spec
// section 9, so another profile's mail is never listed or counted here). One reader for mailVerb's lists and for
// the count status and doctor print.
export function pendingFor(ledger, call) {
  return pendingNotices(ledger).filter((n) => (n.profile || null) === (call.profile || null) && n.env === modeOf(call));
}
export const pendingMailCount = (ledger, call) => pendingFor(ledger, call).length;

// For a mail screen run with no --profile: one line per profile and mode that has notices waiting. buy always runs
// with a profile, so every notice carries one, and a screen with no --profile would otherwise say nothing is
// waiting while notices are, and the agent would never offer to send them.
function otherProfileLines(ledger, o) {
  if (o.profile !== undefined) return [];
  const counts = new Map();
  for (const n of pendingNotices(ledger)) {
    if (!n.profile) continue;
    const flags = `--profile ${n.profile}${n.env === 'demo' ? ' --demo' : ''}`;
    const seen = counts.get(flags) || { profile: n.profile, env: n.env, count: 0 };
    counts.set(flags, { ...seen, count: seen.count + 1 });
  }
  return [...counts].map(([flags, g]) => `Waiting to be sent for profile ${g.profile} (${g.env}): ${g.count}. See them: ${commandText(`mail --pending ${flags}`)}`);
}

// The one line every surface prints about mail: the plan card, the receipt, status and doctor (spec section 9,
// "Surfaces"). One helper, so those screens can never drift into saying two different things about the same
// config. Off and "on but no address" read the same, because both mail nothing: a level the user turned on with
// no address set yet is not lying by calling itself off, it is describing what actually happens right now.
export const MAIL_OFF_LINE = 'Mail: off.';
export function mailLine(config) {
  const { to, level } = mailConfig(config);
  if (level === 'off' || !to) return MAIL_OFF_LINE;
  if (level === 'all') return `Mail: every buy with its details, to ${to}.`;
  return `Mail: problems only, to ${to}.`;
}

// What actually happens to a skipped or halted buy by mail, for a screen with no room to print the Mail line
// itself: null while mail is off, a sentence saying it reaches the user on its own when a mail.command is set to
// run it, or one saying it is only prepared and waits for the agent when no command is set. One reader, so notify
// and smoke can never say two different things about whether mail delivers itself (review finding, schedule.mjs:449:
// "(see the Mail line)" pointed at a line neither screen ever prints, and with no mail.command the smoke screen
// promised delivery mail does not have on its own, directly contradicting its own later "waits in mail --pending"
// sentence).
export function mailReachLine(config) {
  const { command, level } = mailConfig(config);
  const line = mailLine(config);
  if (line === MAIL_OFF_LINE) return null;
  // Review finding (mail.mjs:224, later): mailLine always ends in a period; wrapped in parentheses and followed by
  // a caller's own period, the screen read "...(Mail: problems only, to a@b.co.)." Embedded here with that period
  // dropped, so the whole thing still reads as one sentence.
  const bare = line.slice(0, -1);
  // Review finding (mail.mjs:224, later): "a skipped ... buy" was unconditional, but shouldNotify never mails a
  // skip at level problems whose severity is info, and a skip for no coin in loss is the one buy.mjs ever sends at
  // that severity (cards.mjs's noBuyReason).
  const subject = level === 'problems' ? 'A skipped (except for no coin in loss) or halted buy' : 'A skipped or halted buy';
  return command
    ? `${subject} also reaches you by mail (${bare})`
    : `${subject} is prepared as a mail notice (${bare}) that waits until you ask your agent to send it: no mail command is set`;
}

// status and doctor's one reader for both the mail line and the pending count (ProjectBuilder CLAUDE.md rule 3,
// one fact one reader), so the two screens read config and the ledger the same way rather than each rolling its
// own. ledger is the caller's own read (both verbs already read it once for their other lines); this adds only
// the one config read mailLine needs.
export function mailStatus(store, ledger, call) {
  const { config } = readConfigSafe(store);
  return { line: mailLine(config), pending: pendingMailCount(ledger, call) };
}

// Whether this id was already delivered, and by which lane. Used to refuse a second notice_sent rather than write
// one: two delivery lines for one notice would make the outbox lie about what happened.
export function noticeDelivery(ledger, id) {
  return ledger.find((e) => e.kind === 'notice_sent' && String(e.id) === String(id)) || null;
}

// Lane 1: the user's own mail.command, run exactly like notify.mjs's runNotify (detached, its own process group
// killed on timeout, OKX's key variables stripped from its environment) but with the whole body on stdin instead
// of one line, and the subject and recipient passed through the environment so a one-line wrapper needs no
// address of its own. runShellPiped is the shared piece; this file duplicates none of its process handling.
export function runMail(command, body, subject, to, timeoutMs = NOTIFY_TIMEOUT_MS) {
  return runShellPiped(command, body.endsWith('\n') ? body : `${body}\n`, {
    timeoutMs,
    label: 'mail command',
    extraEnv: { AVGKEEPER_SUBJECT: subject, AVGKEEPER_NOTIFY_EMAIL: to },
  });
}

// tell() (notify.mjs) calls this after every notify() call in buy.mjs, whatever the mail level: prepareMail itself
// decides, from the current config, whether anything is prepared at all, so a call site can never remember the
// notify half and forget this one. Never throws: a mail failure is always a WARNING on stdout, and never changes a
// buy, a ledger money line, or an exit code (spec section 9's own rule, the research doc's failure table origin).
//
// extra: { kind, planId, period, planLine, clOrdIds }. kind is one of noticeId's kind words. planId defaults to
// noPlanId(call) for the handful of failures that happen before any plan is read; period defaults to
// localDate(ctx) for the events section 9 names as period-less (a stale lock with no due period, a time zone
// mismatch, an unreadable or too-new ledger). clOrdIds: for resolve, the orders that run settled as filled.
export async function prepareMail(ctx, call, severity, line, extra = {}) {
  const {
    kind, planId = null, period = null, planLine = null, clOrdIds = null, life = null,
  } = extra;
  try {
    const { config } = readConfigSafe(ctx.store);
    const { to, level, command } = mailConfig(config);
    if (level === 'off' || !shouldNotify(level, severity)) return;
    if (!to) {
      // Said once per run, not once per call site: a run can reach this several times (buy.mjs.buyPeriod's own
      // final summary follows an earlier skip, say), and the user does not need to be told the same thing twice.
      if (!ctx.mailAddressNoticeShown) {
        const why = mailToRefusal(config);
        ctx.out(why
          ? `WARNING: the mail address in config.json is refused, so no notice was prepared: ${why} Set it with ${commandText('mail --to <address>')}.`
          : `AvgKeeper: mail is on but no address is set, so no notice was prepared. Set one: ${commandText('mail --to <address>')}.`);
        ctx.mailAddressNoticeShown = true;
      }
      return;
    }
    let ledger;
    try {
      ledger = ctx.store.readLedger();
    } catch (e) {
      ctx.out(`WARNING: AvgKeeper could not prepare a mail notice: ${e.message}`);
      return;
    }
    const pid = planId || noPlanId(call);
    const per = period || localDate(ctx);
    // Review finding (mail.mjs:307, should): a plan id is a hash of its own settings alone, so a plan remade with
    // identical settings shares a halted predecessor's id. A halt with no period of its own falls back to the local
    // date alone; scoped to the plan's own life here (its own plan_active ts, life), the same instant
    // planview.mjs's planLifeStart already scopes stalePeriods and lastRun by, so two different lives never share
    // one id on the same day. tz and lock warnings keep the plain id: each already fires at most once before any
    // period is due in a life that never remakes mid-warning, so life-scoping them would only risk this exact
    // scope leaking an unrelated life's timestamp into an id nothing else here needs scoped.
    const scope = kind === 'halt' && !period && life ? `${pid}.${life}` : pid;
    const id = noticeId(scope, per, kind);
    if (ledger.some((e) => e.kind === 'notice' && String(e.id) === id)) return;
    // Money spent reaches a mail with its details on every path, not only a finished buy: a halt with a known
    // period lists what that period filled before it stopped, and a later read-back lists what it settled.
    let details = [];
    if (kind === 'buy' || (kind === 'halt' && period)) details = buyOrderLines(ledger, pid, per);
    if (kind === 'resolve' && clOrdIds && clOrdIds.length) details = buyOrderLines(ledger, pid, null, clOrdIds);
    // Review finding (mail.mjs:313, later): a halt's own fact is cut to a short first clause (haltFact above);
    // every other kind keeps the full line, none of which runs anywhere near this long.
    const rawFact = kind === 'buy' ? buyFact(ledger, pid, per) : kind === 'halt' ? haltFact(line) : factFromLine(line);
    const fact = kind === 'buy' ? rawFact : withPeriod(rawFact, per);
    const subject = mailSubject({ profile: call.profile, demo: call.demo, fact });
    const body = mailBody({
      line, details, planLine, profile: call.profile, demo: call.demo, id,
    });
    try {
      ctx.store.appendLedger({
        kind: 'notice', id, severity, subject, body, to, profile: call.profile || null, env: modeOf(call),
      }, ctx.now());
    } catch (e) {
      ctx.out(`WARNING: AvgKeeper could not record a mail notice: ${e.message}`);
      return;
    }
    if (!command) return; // lane 2 only: it waits for `mail --pending`.
    try {
      await ctx.runMail(command, body, subject, to);
      try {
        // The command can run for up to NOTIFY_TIMEOUT_MS, and a session may send this notice and run mail --sent
        // meanwhile. A second delivery line would make the outbox say it went out twice by one record; the footer
        // id is what tells the user the two mails apart.
        const already = noticeDelivery(ctx.store.readLedger(), id);
        if (already) ctx.out(`AvgKeeper: the mail notice ${id} went out through your mail command and was also recorded as sent by ${already.via === 'assistant' ? 'your agent' : 'another run'}. If both went out, each mail ends with that id.`);
        else ctx.store.appendLedger({ kind: 'notice_sent', id, via: 'command' }, ctx.now());
      } catch (e) {
        ctx.out(`WARNING: the mail notice ${id} was sent but could not be recorded (${e.message}); it may be offered again by mail --pending.`);
      }
    } catch (e) {
      ctx.out(`WARNING: your mail command failed: ${e.message}`);
    }
  } catch (e) {
    ctx.out(`WARNING: AvgKeeper could not prepare a mail notice: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The verb. Everything above is pure or a lane; this reads and writes the user's own config and ledger and still
// sends nothing. AvgKeeper never sends a mail itself: it prepares one, and either the user's own command or a
// later assistant session carries it.
// ---------------------------------------------------------------------------------------------------------------

// The address step, printed while no address is set, worded like SKILL.md's own step (research doc section 6), so
// the product and the agent's instructions say the same thing.
export const MAIL_ADDRESS_NEXT = `Next: ask your agent to set an address. It offers the address of a connected mail tool or asks you to type one, reads it back to you in full, and runs ${commandText('mail --to <address>')} only after you confirm it.`;
const MAIL_ACTIONS = ['to', 'level', 'pending', 'sent'];

export async function mailVerb(ctx, o) {
  const given = MAIL_ACTIONS.filter((k) => o[k] !== undefined);
  if (given.length > 1) {
    ctx.out(`REFUSED: pass one of --${MAIL_ACTIONS.join(', --')} at a time; this run passed ${given.map((k) => `--${k}`).join(' and ')}.`);
    return 1;
  }
  const { config, line } = readConfigSafe(ctx.store);
  if (line) {
    ctx.out(`REFUSED: ${line}`);
    return 1;
  }
  const call = { profile: o.profile, demo: Boolean(o.demo) };

  if (o.to !== undefined) {
    const why = mailAddressRefusal(o.to === true ? '' : o.to);
    if (why) {
      ctx.out(`REFUSED: ${why}`);
      return 1;
    }
    // Only the one key changes: the rest of the mail object, command included, stays exactly as the user wrote it.
    const next = { ...config, mail: { ...mailBlock(config), to: String(o.to) } };
    ctx.store.writeConfig(next);
    // Read back and print in full: the user confirms the address by seeing it, not by trusting it was taken as
    // typed. This is the only place AvgKeeper ever prints it unasked.
    const now = mailConfig(ctx.store.readConfig());
    ctx.out(`Mail address recorded: ${now.to}`);
    if (now.level === 'off') ctx.out(`AvgKeeper sends nothing by itself while the level is off: ${commandText('mail --level problems')} or ${commandText('mail --level all')}.`);
    return 0;
  }

  if (o.level !== undefined) {
    if (!NOTIFY_LEVELS.includes(o.level)) {
      ctx.out(`REFUSED: --level reads ${o.level}; use off, problems or all.`);
      return 1;
    }
    const next = { ...config, mail: { ...mailBlock(config), level: o.level } };
    ctx.store.writeConfig(next);
    ctx.out(`Mail level: ${o.level}. ${LEVEL_WORDS[o.level]}`);
    if (o.level !== 'off' && !mailConfig(next).to) {
      ctx.out(`No address is set yet, so nothing is prepared: ${commandText('mail --to <address>')}.`);
    }
    return 0;
  }

  const ledger = ctx.store.readLedger();
  const mine = pendingFor(ledger, call);
  const elsewhere = mine.length ? [] : otherProfileLines(ledger, o);

  if (o.pending !== undefined) {
    ctx.out(`AvgKeeper mail, pending (${modeOf(call)})`);
    if (!mine.length) {
      if (elsewhere.length) ctx.out('No --profile was given, and notices are kept per profile:');
      for (const l of elsewhere) ctx.out(l);
      if (!elsewhere.length) ctx.out('Nothing is waiting to be sent.');
      return 0;
    }
    const now = mailConfig(config).to;
    for (const n of mine) {
      ctx.out('');
      ctx.out(`id: ${n.id}`);
      ctx.out(`to: ${n.to}${now && n.to !== now ? `  WARNING: the address now set is ${now}. This notice was prepared for the one above.` : ''}`);
      ctx.out(`subject: ${n.subject}`);
      ctx.out(String(n.body));
      // shWord: an hourly period is 'YYYY-MM-DD HH' (section 10), so an hourly id holds a space and must be quoted
      // to reach --sent as one word.
      ctx.out(`Record it once it is actually sent: ${commandText(`mail --sent ${shWord(n.id)}${o.profile ? ` --profile ${o.profile}` : ''}${o.demo ? ' --demo' : ''}`)}`);
    }
    return 0;
  }

  if (o.sent !== undefined) {
    const id = String(o.sent);
    const notice = ledger.find((e) => e.kind === 'notice' && String(e.id) === id);
    if (!notice) {
      ctx.out(`REFUSED: no notice with id ${id} was ever prepared, so there is nothing to record as sent.`);
      return 1;
    }
    const already = noticeDelivery(ledger, id);
    if (already) {
      ctx.out(`REFUSED: notice ${id} is already recorded as sent (${already.via}). A second record would say this was sent twice when it was sent once.`);
      return 1;
    }
    ctx.store.appendLedger({ kind: 'notice_sent', id, via: 'assistant' }, ctx.now());
    ctx.out(`Recorded as sent: ${id}`);
    return 0;
  }

  // No action: the whole state on one screen, because a switch the user cannot see is a switch they cannot trust.
  const { to, level, command } = mailConfig(config);
  const refused = mailToRefusal(config);
  const scope = `--profile ${o.profile || '<p>'}${o.demo ? ' --demo' : ''}`;
  ctx.out('AvgKeeper mail');
  if (to) ctx.out(`Address: ${to}`);
  else ctx.out(refused ? `Address: none usable. config.json holds one that is refused: ${refused}` : 'Address: none. AvgKeeper never guesses one.');
  if (!to) ctx.out(MAIL_ADDRESS_NEXT);
  ctx.out(`Level: ${level}. ${LEVEL_WORDS[level]}`);
  // Review finding (mail.mjs:429): the Level line alone reads as if mail is already on with no address set;
  // mail --level already says nothing is prepared yet in this case, this screen did not.
  if (!to && level !== 'off') ctx.out(`No address is set yet, so nothing is prepared: ${commandText('mail --to <address>')}.`);
  ctx.out(command
    ? 'Mail command: set. AvgKeeper runs it when a notice is prepared and passes the subject and address in its environment. Its text is not printed here.'
    : `Mail command: none. Every notice waits in ${commandText(`mail --pending ${scope}`)} until you ask your agent to send it.`);
  if (mine.length) ctx.out(`Waiting to be sent: ${mine.length}. See them: ${commandText(`mail --pending${o.profile ? ` --profile ${o.profile}` : ''}${o.demo ? ' --demo' : ''}`)}`);
  for (const l of elsewhere) ctx.out(l);
  if (!mine.length && !elsewhere.length) ctx.out('Waiting to be sent: none.');
  return 0;
}
