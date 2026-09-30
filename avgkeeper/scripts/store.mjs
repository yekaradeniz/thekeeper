// avgkeeper/scripts/store.mjs
// Local state under ~/.avgkeeper: config.json, ledger.jsonl and lock files. No keys, no account ids.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MINUTE_MS } from './units.mjs';

// A lock older than this is taken over even from a live pid (store.lock below); pid reuse after a reboot
// must never wedge AvgKeeper's buy lock forever.
export const LOCK_STALE_MS = 15 * MINUTE_MS;

// The asides an interrupted takeover of this lock name left behind, older than a lock ever gets. Files only,
// inside the home, matching this one lock's own name: nothing else is touched, and a failure to read the
// directory is not a reason to fail a lock, so it is swallowed (ledger-09).
function sweepAsides(home, name) {
  // The escaper did not escape: `[\\]` closed the class after one backslash and the replacement inserted two, so a
  // dot in a lock name was a wildcard and a `+` broke the sweep (2026-09-21 re-review, E6).
  const pattern = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.lock\\.\\d+\\.\\d+\\.stale$`);
  let entries;
  try {
    entries = fs.readdirSync(home, { withFileTypes: true });
  } catch {
    return;
  }
  const cutoff = Date.now() - LOCK_STALE_MS;
  for (const e of entries) {
    if (!e.isFile() || !pattern.test(e.name)) continue;
    const f = path.join(home, e.name);
    try {
      if (fs.statSync(f).mtimeMs < cutoff) fs.rmSync(f, { force: true });
    } catch {
      // gone, or another process is using it right now: leave it alone.
    }
  }
}

// Whether lock(name, { takeover: false }) would leave this lock file held right now, with no side effect: never
// takes, moves or removes anything, only stats and reads it. Every real caller of the buy lock (buy, stop, plan
// confirm) passes takeover:false, so this mirrors that one case, not lock()'s own takeover:true default. Applies
// lock()'s own rule (store.mjs's lock, the "held" branch): a live or EPERM pid is held whatever its age, since a
// scheduled buy's own read-backs can run long; a confirmed-dead pid, or empty or garbage content, is held only
// while young and taken over once past LOCK_STALE_MS. Review findings (buy.mjs:568, period.mjs:315): staleLock
// below answers only the file's own age, so a dry run, status or doctor that judged a lock "still held" from age
// alone named a cause the real run's own lock() would not act on whenever the pid behind it had already died.
function wouldHoldLock(p) {
  let mtimeMs;
  try {
    mtimeMs = fs.statSync(p).mtimeMs;
  } catch {
    return true; // unreadable mtime: fail closed, the same as lock() itself
  }
  let text;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch {
    return true; // unreadable content: fail closed, the same as lock() itself
  }
  const trimmed = text.trim();
  let pid = NaN;
  if (trimmed) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parsed = undefined;
    }
    pid = Number(parsed && typeof parsed === 'object' ? parsed.pid : (parsed === undefined ? trimmed : parsed));
  }
  const pidValid = Number.isInteger(pid) && pid > 0;
  const stale = Date.now() - mtimeMs >= LOCK_STALE_MS;
  if (!pidValid) return !stale; // empty or garbage: the writer may be mid-write while young, never once stale
  try {
    process.kill(pid, 0);
    return true; // live: always held under takeover:false, whatever its age
  } catch (k) {
    return k.code === 'EPERM'; // EPERM: live but another user, held; anything else (ESRCH): dead, always taken over
  }
}

// Every ledger line carries v, the schema of the AvgKeeper copy that wrote it. Raise it whenever a new line kind or
// field makes an older copy unsafe on this ledger. It never goes down.
export const LEDGER_SCHEMA = 1;

// The highest v in the ledger. A line without v was written before v existed and counts as 1, so an empty ledger is 1.
// A v that is not a whole number of at least 1 is unreadable: the result is NaN, which every caller reads as newer
// than any real schema, so an unreadable ledger is treated as too new to touch rather than silently accepted.
export function ledgerSchema(ledger) {
  let n = 1;
  for (const e of ledger) {
    const v = e.v === undefined ? 1 : e.v;
    if (!Number.isInteger(v) || v < 1) return NaN;
    if (v > n) n = v;
  }
  return n;
}

// Every lock this process takes gets its own start, never equal to an earlier one's, so a release can tell its own lock
// file from a later holder's, even a holder inside this same process.
let lastStart = 0;
const nextStart = () => {
  lastStart = Math.max(Date.now(), lastStart + 1);
  return lastStart;
};

// The one formula for where AvgKeeper's own state lives, given the real home directory a process would otherwise
// use and an optional AVGKEEPER_HOME override (resolved, never raw: cron and launchd start in a different working
// directory, so a relative value would name one store here and another there, 2026-09-20 review,
// schedules-gridkeeper-home-dropped). homeDir below is the one caller that turns this into an actual directory for
// the current process; schedule.mjs is the other, to name the very same file a scheduled run's own log lands in
// (item 4 of the 2026-09-27 release audit) without ever computing this process's own real home by mistake.
export function resolveAvgkeeperHome(home, akHomeOverride) {
  return akHomeOverride ? path.resolve(akHomeOverride) : path.join(home, '.avgkeeper');
}

// The path a user-facing sentence should show for a file under the AvgKeeper home: the ~/.avgkeeper shorthand
// only when home is in fact the default, unoverridden one (the only case a hard-coded "~/.avgkeeper/..." string
// was ever right for), the real absolute path otherwise, since AVGKEEPER_HOME can point anywhere. One reader for
// every message that names such a file: the stale-lock line, the torn-ledger warning, the newer-schema refusal,
// and the notify key sentence (review finding, planview.mjs:77).
export function displayHomePath(home, tail = '') {
  const base = home === path.join(os.homedir(), '.avgkeeper') ? '~/.avgkeeper' : home;
  return tail ? `${base}/${tail}` : base;
}

export function homeDir(env = process.env) {
  if (env.AVGKEEPER_HOME) return resolveAvgkeeperHome(null, env.AVGKEEPER_HOME);
  // node --test sets this for every test file's own process, and a spawned child inherits it. Resolving the
  // real ~/.avgkeeper here would let a test read or write the user's actual state; refuse instead.
  if (process.env.NODE_TEST_CONTEXT) {
    throw new Error('tests must use a temporary AvgKeeper home (AVGKEEPER_HOME)');
  }
  return resolveAvgkeeperHome(os.homedir(), null);
}

// mkdir and write modes apply only on creation, so every call also sets them on what already exists.
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  return dir;
}

function writePrivate(p, text, append = false) {
  (append ? fs.appendFileSync : fs.writeFileSync)(p, text, { mode: 0o600 });
  fs.chmodSync(p, 0o600);
}

export function createStore(home = homeDir()) {
  const configPath = path.join(home, 'config.json');
  const ledgerPath = path.join(home, 'ledger.jsonl');
  return {
    home,
    readConfig() {
      if (!fs.existsSync(configPath)) return {};
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    },
    writeConfig(config) {
      ensureDir(home);
      writePrivate(configPath, JSON.stringify(config, null, 2) + '\n');
    },
    // v goes last, so an entry never carries another copy's schema into the ledger.
    appendLedger(entry, now = Date.now()) {
      ensureDir(home);
      const line = JSON.stringify({ ts: new Date(now).toISOString(), ...entry, v: LEDGER_SCHEMA });
      writePrivate(ledgerPath, line + '\n', true);
    },
    // Exactly one unparsable line is tolerated, counted and reported, wherever in the file it sits. A torn write
    // (a process cut off mid-append) can land anywhere a later append then lands on top of, not only at the end,
    // since a scheduled run can append again minutes later (a lesson carried over from GridKeeper's own ledger,
    // where a rule that only forgave the last line stopped every read once a second append moved a still-torn
    // fragment out of that position). A single mangled line in the middle of the ledger, whatever mangled it, is
    // read past instead of refused. Two are still corruption and still refuse in full, and the caller is told
    // which line was tolerated so it can be fixed rather than quietly lived with.
    readLedger() {
      if (!fs.existsSync(ledgerPath)) return [];
      const parts = fs.readFileSync(ledgerPath, 'utf8').split('\n');
      const rows = [];
      let torn = 0;
      let tornLine = 0;
      parts.forEach((l, i) => {
        if (!l) return;
        // A line that parses but is not a ledger line is as unreadable as one that does not parse, and one of
        // those shapes is worse than a fragment: every reader of this array asks a row for its kind, and a bare
        // `null` answers that with a TypeError out of readLedger's caller, so a single such line could take down
        // every caller with no refusal naming the file (a lesson carried over from GridKeeper's 2026-09-20
        // review, security-5). Both shapes now take the same tolerated-once path, so the file is still readable
        // past one bad line and the caller is still told which line it was.
        let row = null;
        try {
          const parsed = JSON.parse(l);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) row = parsed;
        } catch { /* row stays null: unreadable, counted below */ }
        if (row) {
          rows.push(row);
          return;
        }
        if (torn === 0) {
          torn = 1;
          tornLine = i + 1;
          return;
        }
        throw new Error(`REFUSED: ${ledgerPath} lines ${tornLine} and ${i + 1} cannot be read as ledger lines; each one has to be a single JSON object. Fix or remove them.`);
      });
      if (torn) {
        Object.defineProperty(rows, 'torn', { value: torn, enumerable: false });
        Object.defineProperty(rows, 'tornLine', { value: tornLine, enumerable: false });
      }
      return rows;
    },
    // One lock file per name, holding the pid and the start of its holder (JSON; a bare pid, the old format,
    // is read the same way). Age always comes from the file's own mtime, never from the content, so a lock
    // cannot be aged by anything other than the clock actually running out on it. A lock is HELD only while
    // its pid is a live positive integer AND the lock is younger than LOCK_STALE_MS: pid reuse after a reboot
    // must never wedge a lock forever, so a lock older than that is taken over even from a live pid, and a
    // dead pid is always taken over regardless of age. An empty or unparsable lock is still HELD while young
    // (fail closed: the writer can be between its wx create and the write that follows), and always taken over
    // once stale, whatever takeover says: no writer takes 15 minutes between its create and its write, and holding
    // such a file under takeover false stopped every buy forever (2026-09-26 review, item 1). An unreadable mtime
    // is HELD, fail closed. Returns a release function, or null while held.
    // { takeover }, default true, gates only the age-based branch below: with takeover false, a lock that is
    // stale but whose pid is still alive is left HELD rather than taken over, because a live
    // holder past LOCK_STALE_MS can be a scheduled buy still genuinely running (read-backs with retry sleeps
    // add up), not a pid reused after a reboot. A lock whose pid is confirmed dead is still
    // taken over regardless of takeover or age: a dead process cannot be the case that rule protects.
    lock(name, { takeover = true } = {}) {
      ensureDir(home);
      const p = path.join(home, `${name}.lock`);
      const me = { pid: process.pid, start: nextStart() };
      const create = () => fs.writeFileSync(p, JSON.stringify(me), { flag: 'wx', mode: 0o600 });
      // The file still holds this holder's pid and start. A holder whose lock went stale and was taken over finds
      // another holder's lock there, so its release never deletes a successor's lock.
      const mine = () => {
        try {
          const held = JSON.parse(fs.readFileSync(p, 'utf8'));
          return Boolean(held) && held.pid === me.pid && held.start === me.start;
        } catch {
          return false;
        }
      };
      const release = () => {
        if (mine()) fs.rmSync(p, { force: true });
      };
      // A function is an object: attaching mine here, once, means every return path below (the fresh-create
      // path and the takeover path) hands back the exact same release, and it always carries its own live
      // ownership check. A caller that re-asserts release.mine() immediately before it sends a write can never
      // send that write twice because a stale-lock takeover happened underneath it in the seconds since this run
      // last held the lock; no existing AvgKeeper caller reads this property yet, so none of them changes
      // behavior today.
      release.mine = mine;
      try {
        create();
        return release;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        let seen;
        let mtimeMs;
        try {
          seen = fs.statSync(p);
          mtimeMs = seen.mtimeMs;
        } catch {
          return null; // unreadable mtime: fail closed
        }
        let text;
        try {
          text = fs.readFileSync(p, 'utf8');
        } catch {
          return null; // unreadable content: fail closed
        }
        const trimmed = text.trim();
        let pid = NaN;
        if (trimmed) {
          let parsed;
          try {
            parsed = JSON.parse(trimmed);
          } catch {
            parsed = undefined;
          }
          pid = Number(parsed && typeof parsed === 'object' ? parsed.pid : (parsed === undefined ? trimmed : parsed));
        }
        const pidValid = Number.isInteger(pid) && pid > 0;
        const stale = Date.now() - mtimeMs >= LOCK_STALE_MS;
        // Age alone decides whether a stale lock is even eligible for takeover (gated by the takeover option);
        // a live pid past that age is held only when takeover is refused. Content with no pid to check at all is
        // held only while young. A confirmed-dead pid (ESRCH) is never held, whatever its age or the takeover flag.
        //
        // EPERM means the pid exists but belongs to another user, so it is live and gets the live rule, age
        // included, rather than held forever whatever the age: a lesson carried over from GridKeeper's 2026-09-20
        // review (money-1), where a reboot handed the recorded pid to a root daemon and every caller of that lock
        // refused indefinitely, with no way to recover short of the user editing the lock file by hand.
        let held;
        if (pidValid) {
          try {
            process.kill(pid, 0);
            held = stale ? !takeover : true;
          } catch (k) {
            held = k.code === 'EPERM' ? (stale ? !takeover : true) : false;
          }
        } else {
          held = !stale; // empty or garbage: the writer may be mid-write while young, never once stale
        }
        if (held) return null;
        // The takeover moves the stale file aside under a name no other process uses. rename is atomic, so of two
        // processes that judged the same file stale only one moves that file: the other finds the name empty, or
        // moves the winner's new lock, sees it is not the file it judged, and puts it back.
        // An interrupted takeover (a crash between the rename and the remove below) leaves its aside behind for
        // good: nothing ever read that name again (2026-09-20 review, ledger-09). Every takeover of this lock
        // name sweeps the ones that are old enough to be nobody's, before it makes its own. The pattern is the
        // lock NAME's, never this process's pid, because the orphan carries the dead holder's pid; and the age
        // gate is not tidiness: a young aside can be another live taker's, whose put-back is still to come, and
        // deleting that would lose a live lock. rename preserves mtime, so an aside of an already-stale lock is
        // already past the gate.
        sweepAsides(home, name);
        const aside = `${p}.${me.pid}.${me.start}.stale`;
        try {
          fs.renameSync(p, aside);
        } catch {
          return null; // gone or unmovable: another process got there first
        }
        let judged = false;
        try {
          judged = fs.statSync(aside).ino === seen.ino && fs.readFileSync(aside, 'utf8') === text;
        } catch {
          judged = false;
        }
        if (!judged) {
          try {
            fs.linkSync(aside, p);
          } catch {
            // a third process already holds the name
          }
          fs.rmSync(aside, { force: true });
          return null;
        }
        try {
          create();
        } catch (w) {
          fs.rmSync(aside, { force: true });
          if (w.code === 'EEXIST') return null;
          throw w;
        }
        fs.rmSync(aside, { force: true });
        return release;
      }
    },
    // The age in ms of this lock name's file when it exists and is at least LOCK_STALE_MS old, else null. Read
    // only: it never takes, moves or removes the lock. An unreadable file answers null (nothing it can vouch for).
    staleLock(name) {
      try {
        const age = Date.now() - fs.statSync(path.join(home, `${name}.lock`)).mtimeMs;
        return age >= LOCK_STALE_MS ? age : null;
      } catch {
        return null;
      }
    },
    // 'none' while no lock file exists right now, 'held' when lock(name, { takeover: false }) would refuse it,
    // 'takeover' when that same call would in fact take it over. Read only (wouldHoldLock above): the one reader
    // for every caller that only wants to know what the real gate would decide, never take it itself (review
    // findings buy.mjs:568, period.mjs:315).
    lockDecision(name) {
      const p = path.join(home, `${name}.lock`);
      if (!fs.existsSync(p)) return 'none';
      return wouldHoldLock(p) ? 'held' : 'takeover';
    },
  };
}
