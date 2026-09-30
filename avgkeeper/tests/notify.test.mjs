// avgkeeper/tests/notify.test.mjs
import { makeCtx, tmpDir } from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createStore } from '../scripts/store.mjs';
import {
  readConfigSafe, levelOf, shouldNotify, notify, runNotify, NOTIFY_LEVELS, notifyStatusLine, runShellPiped,
} from '../scripts/notify.mjs';

test('levels: off, problems (default), all', () => {
  assert.deepEqual(NOTIFY_LEVELS, ['off', 'problems', 'all']);
  assert.equal(levelOf({}), 'problems');
  assert.equal(levelOf({ notifyLevel: 'all' }), 'all');
  assert.equal(levelOf({ notifyLevel: 'loud' }), 'problems');
  assert.equal(shouldNotify('off', 'problem'), false);
  assert.equal(shouldNotify('problems', 'problem'), true);
  assert.equal(shouldNotify('problems', 'info'), false);
  assert.equal(shouldNotify('all', 'info'), true);
});

test('readConfigSafe turns notify off for a broken config and says so', () => {
  const home = tmpDir('ak-conf-');
  fs.writeFileSync(path.join(home, 'config.json'), '{nope');
  const r = readConfigSafe(createStore(home));
  assert.deepEqual(r.config, {});
  assert.match(r.line, /not valid JSON/);
  fs.writeFileSync(path.join(home, 'config.json'), '{"notify": 5}');
  assert.match(readConfigSafe(createStore(home)).line, /must be a command/);
});

// Review finding (notify.mjs:59, should): config.json breaking (invalid JSON, or the wrong shape entirely) turns
// mail off too, since the config it holds (its mail.to, mail.level, mail.command) is lost right along with notify's
// own key, not only notify's. The one sentence said only "notify is off", although mail went dark the same way.
test('readConfigSafe says both notify and mail are off when config.json cannot be read at all', () => {
  const home = tmpDir('ak-conf-');
  fs.writeFileSync(path.join(home, 'config.json'), '{nope');
  assert.match(readConfigSafe(createStore(home)).line, /notify and mail are both off until it is fixed\./);
  fs.writeFileSync(path.join(home, 'config.json'), '[]');
  assert.match(readConfigSafe(createStore(home)).line, /Notify and mail are both off until it is fixed\./);
});

// Review finding (notify.mjs:59, should): a bad notify key alone leaves config.mail intact (readConfigSafe keeps
// every other key), so mail --to and mail --level still work once the refusal clears; the sentence named only
// notify's own effect, not that mail cannot be changed meanwhile either.
test('readConfigSafe says mail cannot be changed either while only the notify key itself is bad', () => {
  const home = tmpDir('ak-conf-');
  fs.writeFileSync(path.join(home, 'config.json'), '{"notify": 5, "mail": {"to": "a@b.co", "level": "all"}}');
  const r = readConfigSafe(createStore(home));
  assert.match(r.line, /Notify is off, and mail cannot be changed, until it is fixed\./);
  // Mail's own settings are not lost: prepareMail (mail.mjs) reads them from r.config unchanged.
  assert.deepEqual(r.config.mail, { to: 'a@b.co', level: 'all' });
});

test('notify sends by level and never throws', async () => {
  const ctx = makeCtx({ config: { notify: 'cat', notifyLevel: 'problems' } });
  await notify(ctx, 'info', 'bought');
  await notify(ctx, 'problem', 'skipped');
  assert.deepEqual(ctx.notified, ['skipped']);
  const failing = makeCtx({ config: { notify: 'cat' } });
  failing.runNotify = async () => { throw new Error('notify command exited 1'); };
  await notify(failing, 'problem', 'x');
  assert.match(failing.lines.join('\n'), /WARNING: your notify command failed/);
});

test('runNotify passes the line on stdin and rejects a failing command', async () => {
  const dir = tmpDir('ak-notify-');
  const out = path.join(dir, 'got.txt');
  await runNotify(`cat > '${out}'`, 'hello');
  assert.equal(fs.readFileSync(out, 'utf8'), 'hello\n');
  await assert.rejects(runNotify('exit 3', 'x'), /exited 3/);
});

// Review finding (buy.mjs:368, notify.mjs:60): OKX's own key variables being stripped from the notify and mail
// command's environment had no test at all. This command reaches the user's own notifier or mailer, never OKX.
test('runShellPiped strips OKX key variables from the child environment', async () => {
  const dir = tmpDir('ak-notify-');
  const out = path.join(dir, 'got.txt');
  const saved = process.env.OKX_API_KEY;
  process.env.OKX_API_KEY = 'super-secret-value';
  try {
    await runShellPiped(`echo "KEY=[$OKX_API_KEY]" > '${out}'`, '');
    assert.equal(fs.readFileSync(out, 'utf8').trim(), 'KEY=[]');
  } finally {
    if (saved === undefined) delete process.env.OKX_API_KEY;
    else process.env.OKX_API_KEY = saved;
  }
});

// Review findings (schedule.mjs:244): "nothing reaches you" is false whenever mail is on with no notify command
// set, and a command set with level off is off, the same word mailLine uses for the same state.
// Review finding (notify.mjs:36, should): this line said mail "reaches" the user whenever it was on, even with no
// mail.command set, the same overclaim 6dedffa already fixed for notify and smoke's own lines. Built from
// mailReachLine now (rule 4, one fact one reader), so doctor never disagrees with notify and smoke about whether a
// halt or skip reaches the user on its own.
test('notifyStatusLine names both channels, and calls a command at level off simply off', () => {
  assert.equal(notifyStatusLine({}), 'Notify: no command set, so nothing reaches you when a buy is skipped or halted.');
  assert.equal(
    notifyStatusLine({ mail: { to: 'a@b.co', level: 'problems' } }),
    'Notify: no command set. A skipped (except for no coin in loss) or halted buy is prepared as a mail notice (Mail: problems only, to a@b.co) that waits until you ask your agent to send it: no mail command is set. It also shows in status.',
  );
  assert.equal(
    notifyStatusLine({ mail: { to: 'a@b.co', level: 'all', command: 'cat' } }),
    'Notify: no command set. A skipped or halted buy also reaches you by mail (Mail: every buy with its details, to a@b.co). It also shows in status.',
  );
  assert.equal(
    notifyStatusLine({ mail: { to: 'a@b.co', level: 'off' } }),
    'Notify: no command set, so nothing reaches you when a buy is skipped or halted.',
    'mail on but its own level off still reaches nobody',
  );
  assert.equal(notifyStatusLine({ notify: 'cat', notifyLevel: 'all' }), 'Notify: on, level all.');
  assert.equal(notifyStatusLine({ notify: 'cat', notifyLevel: 'off' }), 'Notify: off (a command is set, level off).');
});
