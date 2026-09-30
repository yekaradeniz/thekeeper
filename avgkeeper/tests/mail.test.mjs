// avgkeeper/tests/mail.test.mjs
// Mail notices (spec section 9). Three things are worth a test here for the same reason GridKeeper's removed
// mail.test.mjs held them: a mail that says something the screen did not (the owner's own previous system did
// exactly that), an address AvgKeeper guessed rather than was given, and a level that starts mailing on its own.
import { makeCtx, tmpDir, text, kinds, CALL } from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tell } from '../scripts/notify.mjs';
import { notifyVerb } from '../scripts/manage.mjs';
import { spawnSync } from 'node:child_process';
import { commandText, ENTRY_SCRIPT, stableNode } from '../scripts/cmdtext.mjs';
import { main, parseArgs } from '../scripts/avgkeeper.mjs';
import {
  mailConfig, mailAddressRefusal, noPlanId, localDate, noticeId, mailSubject, noticeFooter, factFromLine,
  buyOrderLines, mailBody, pendingNotices, noticeDelivery, runMail, mailVerb, mailLine, pendingMailCount, mailStatus,
  MAIL_ADDRESS_NEXT, mailReachLine,
} from '../scripts/mail.mjs';

const buyLine = 'AvgKeeper bought 2026-10-05: ETH 6.67 USDT.';
const buyExtra = { kind: 'buy', planId: 'p1', period: '2026-10-05' };

// ---------------------------------------------------------------------------
// The config: defaults, and what a malformed value reads as.
// ---------------------------------------------------------------------------

test('a mail block of the wrong shape reads as absent; level defaults to off, never problems', () => {
  for (const c of [undefined, null, {}, { mail: null }, { mail: 'yes' }, { mail: [] }, { mail: { level: 'loud' } }]) {
    const m = mailConfig(c);
    assert.equal(m.to, null, JSON.stringify(c));
    assert.equal(m.level, 'off', JSON.stringify(c));
    assert.equal(m.command, null, JSON.stringify(c));
  }
  assert.equal(mailConfig({ mail: { to: '  x@y.co  ' } }).to, 'x@y.co', 'surrounding space is not part of an address');
  assert.equal(mailConfig({ mail: { to: '   ' } }).to, null, 'a blank address is no address');
  assert.equal(mailConfig({ mail: { level: 'all' } }).level, 'all');
  assert.equal(mailConfig({ mail: { level: 'problems' } }).level, 'problems');
  assert.equal(mailConfig({ mail: { command: 'cat' } }).command, 'cat');
  assert.equal(mailConfig({ mail: { command: '   ' } }).command, null, 'a blank command is no command');
});

// ---------------------------------------------------------------------------
// The address.
// ---------------------------------------------------------------------------

test('an address is accepted only in the shape that can reach one person', () => {
  assert.equal(mailAddressRefusal('yunus@example.com'), null);
  assert.equal(mailAddressRefusal('a.b+tag@mail.example.co.uk'), null);
  for (const bad of ['', '   ', 'yunus', 'yunus@', '@example.com', 'yunus@example', 'a@b@c.com',
    'a b@example.com', 'a@example..com', 'a@.example.com', 'a@example.com.', 'a@x.com,b@y.com', 'a@x.com;b@y.com']) {
    assert.ok(mailAddressRefusal(bad), `${JSON.stringify(bad)} must be refused`);
  }
  assert.ok(mailAddressRefusal(`a@x.com${String.fromCharCode(7)}`), 'a control character is refused');
  assert.ok(mailAddressRefusal(' a@x.com'), 'a leading space is refused rather than trimmed away');
  assert.ok(mailAddressRefusal(42), 'a value that is not a string is refused');
});

// An invisible format character makes an address that reads back identical on screen but is a different address.
test('an address holding an invisible format character is refused', () => {
  for (const cp of [0x200b, 0x200e, 0x200f, 0x202a, 0x202e, 0x2066, 0x2069, 0xfeff]) {
    const v = `a${String.fromCodePoint(cp)}@x.com`;
    assert.ok(mailAddressRefusal(v), `U+${cp.toString(16)} must be refused`);
  }
});

// The address check runs on every read, not only in mail --to: a value edited into config.json by hand (the comma
// is how a second recipient is smuggled in) never reaches lane 1.
test('a mail.to in config.json that fails the address check reads as no address, and buy says why once', async () => {
  assert.equal(mailConfig({ mail: { to: 'me@x.com,other@y.com' } }).to, null);
  assert.equal(mailLine({ mail: { to: 'me@x.com,other@y.com', level: 'all' } }), 'Mail: off.');
  const ctx = makeCtx({ config: { mail: { to: 'me@x.com,other@y.com', level: 'all', command: 'cat' } } });
  await tell(ctx, CALL, 'info', buyLine, buyExtra);
  await tell(ctx, CALL, 'problem', 'AvgKeeper skipped 2026-10-06: x', { kind: 'skip', planId: 'p1', period: '2026-10-06' });
  assert.equal(ctx.mailed.length, 0);
  assert.equal(kinds(ctx).filter((k) => k === 'notice').length, 0);
  const said = ctx.lines.filter((l) => l.startsWith('WARNING: the mail address in config.json is refused'));
  assert.equal(said.length, 1, text(ctx));
  assert.match(said[0], /comma or a semicolon/);
  assert.ok(said[0].includes(commandText('mail --to <address>')), said[0]);

  ctx.lines.length = 0;
  await mailVerb(ctx, {});
  assert.match(text(ctx), /^Address: none usable\. config\.json holds one that is refused: .*comma or a semicolon/m);
});

test('every refusal names the address it refused, so the typo is visible', () => {
  assert.match(mailAddressRefusal('yunus@example'), /"yunus@example"/);
  assert.match(mailAddressRefusal('a@x.com,b@y.com'), /comma or a semicolon/);
  assert.match(mailAddressRefusal(''), /AvgKeeper never guesses one/);
});

// ---------------------------------------------------------------------------
// Ids and the subject.
// ---------------------------------------------------------------------------

test('the id is planId:period:kind', () => {
  assert.equal(noticeId('p1', '2026-10-05', 'buy'), 'p1:2026-10-05:buy');
  assert.equal(noticeId('p1', '2026-10-05', 'skip'), 'p1:2026-10-05:skip');
});

// Review findings (mail.mjs:307 should, buy.mjs:160 should): a plan id is a hash of the plan's own settings alone,
// so a plan remade with identical settings shares a halted predecessor's id. An auth halt has no period of its own,
// so its notice id fell back to the local date alone: a second halt of the REMADE plan's own new life, on the same
// local date, matched an id already in the ledger and was never prepared, silently, for the channel meant for
// unattended failures. Scoped to the plan's own life (its own plan_active ts) so two lives never share one id.
test('two halts of two different plan lives, same plan id and same local date, each prepare their own notice', async () => {
  const ctx = makeCtx({ config: { mail: { to: 'a@b.co', level: 'problems', command: 'cat' } } });
  await tell(ctx, CALL, 'problem', 'AvgKeeper HALTED: first life', {
    kind: 'halt', planId: 'p1', period: null, life: '2026-10-05T09:00:00.000Z',
  });
  await tell(ctx, CALL, 'problem', 'AvgKeeper HALTED: second life', {
    kind: 'halt', planId: 'p1', period: null, life: '2026-10-05T09:20:00.000Z',
  });
  const notices = ctx.store.readLedger().filter((e) => e.kind === 'notice');
  assert.equal(notices.length, 2);
  assert.notEqual(notices[0].id, notices[1].id);
  assert.equal(ctx.mailed.length, 2);
});

test('a plan-less event is scoped to the account, not left blank, and the fallback period is the local date', () => {
  assert.equal(noPlanId({ profile: 't', demo: false }), 'noplan-t-live');
  assert.equal(noPlanId({ profile: 't', demo: true }), 'noplan-t-demo');
  assert.equal(noPlanId({ profile: undefined, demo: false }), 'noplan-noprofile-live');
  const ctx = makeCtx({});
  assert.equal(localDate(ctx), '2026-10-05');
});

test('the subject names the product, the profile and the mode, and a demo run cannot be mistaken for a real one', () => {
  assert.equal(
    mailSubject({ profile: 't', demo: false, fact: 'bought 6.67 USDT across 1 coin (2026-10-05)' }),
    '[AvgKeeper / t live] bought 6.67 USDT across 1 coin (2026-10-05)',
  );
  assert.match(mailSubject({ profile: 't', demo: true, fact: 'x' }), /^\[AvgKeeper \/ t demo\]/);
  assert.match(mailSubject({ profile: undefined, demo: false, fact: 'x' }), /^\[AvgKeeper \/ no profile live\]/);
});

test('factFromLine strips a leading AvgKeeper prefix, colon or not, and leaves anything else untouched', () => {
  assert.equal(factFromLine('AvgKeeper skipped 2026-10-05: free USDT 8.20, below 10.00'), 'skipped 2026-10-05: free USDT 8.20, below 10.00');
  assert.equal(factFromLine('AvgKeeper: this plan was made in Europe/Istanbul'), 'this plan was made in Europe/Istanbul');
  assert.equal(factFromLine('AvgKeeper HALTED: x'), 'HALTED: x');
  assert.equal(factFromLine('something else entirely'), 'something else entirely');
});

// ---------------------------------------------------------------------------
// The body and the per-order details. The rule that matters most: the mail does not re-tell the run.
// ---------------------------------------------------------------------------

test('the body carries the run own printed line byte for byte, and ends with the footer', () => {
  const body = mailBody({
    line: buyLine, details: ['  ETH-USDT: share 6.67 USDT.'], planLine: '10.00 USDT every day at 10:00 (Europe/Istanbul), split equally.', profile: 't', demo: false, id: 'p1:2026-10-05:buy',
  });
  const lines = body.split('\n');
  assert.ok(lines.includes(buyLine), body);
  assert.equal(lines.filter((l) => l === buyLine).length, 1, 'one telling, not a paraphrase beside it');
  assert.ok(lines.includes('  ETH-USDT: share 6.67 USDT.'));
  assert.match(body, /10\.00 USDT every day at 10:00 \(Europe\/Istanbul\), split equally\./);
  assert.match(body, /Profile t, live, real money\./);
  assert.equal(lines.at(-1), noticeFooter('p1:2026-10-05:buy'));
});

test('a mail with no plan line and no details still ends in the footer, with nothing left dangling', () => {
  const body = mailBody({
    line: 'AvgKeeper skipped 2026-10-05: no coin in loss.', profile: undefined, demo: true, id: 'noplan-t-demo:2026-10-05:skip',
  });
  assert.match(body, /Profile no profile, demo, practice money\./);
  assert.equal(body.split('\n').at(-1), 'AvgKeeper notice id: noplan-t-demo:2026-10-05:skip');
});

test('buyOrderLines reads the share, the loss and the fill from that period own buy_sent and buy_filled lines, never recomputed', () => {
  const ledger = [
    {
      kind: 'buy_sent', planId: 'p1', period: '2026-10-05', instId: 'ETH-USDT', clOrdId: 'c1', amount: '6.67', lossPct: 10,
    },
    {
      kind: 'buy_filled', planId: 'p1', period: '2026-10-05', instId: 'ETH-USDT', clOrdId: 'c1', notional: 6.6, accFillSz: '0.00377', avgPx: '1767.30',
    },
    {
      kind: 'buy_sent', planId: 'p1', period: '2026-10-05', instId: 'BTC-USDT', clOrdId: 'c2', amount: '3.33', lossPct: 5,
    },
    {
      kind: 'buy_rejected', planId: 'p1', period: '2026-10-05', instId: 'BTC-USDT', clOrdId: 'c2',
    },
    // A different period with the same instId must never leak into this one's lines.
    {
      kind: 'buy_sent', planId: 'p1', period: '2026-10-06', instId: 'ETH-USDT', clOrdId: 'c3', amount: '9.99', lossPct: 1,
    },
    {
      kind: 'buy_filled', planId: 'p1', period: '2026-10-06', instId: 'ETH-USDT', clOrdId: 'c3', notional: 9.9, accFillSz: '1', avgPx: '1',
    },
  ];
  const lines = buyOrderLines(ledger, 'p1', '2026-10-05');
  assert.equal(lines.length, 1, 'the rejected coin has no buy_filled line and so no detail line');
  assert.match(lines[0], /^ {2}ETH-USDT: share 6\.67 USDT, loss 10\.00% at buy time, filled 0\.00377 at 1767\.30 USDT, notional 6\.60 USDT\.$/);
});

// ---------------------------------------------------------------------------
// tell(): the one call buy.mjs makes for both the notify line and a mail notice.
// ---------------------------------------------------------------------------

test('off never starts mailing on its own, whatever the severity', async () => {
  const ctx = makeCtx({ config: { mail: { to: 'a@b.co', level: 'off' } } });
  await tell(ctx, CALL, 'problem', 'AvgKeeper skipped 2026-10-05: x', { kind: 'skip', planId: 'p1', period: '2026-10-05' });
  await tell(ctx, CALL, 'info', buyLine, buyExtra);
  assert.equal(kinds(ctx).filter((k) => k === 'notice').length, 0);
});

test('problems mails only severity problem; all mails every outcome', async () => {
  const problems = makeCtx({ config: { mail: { to: 'a@b.co', level: 'problems' } } });
  await tell(problems, CALL, 'info', buyLine, buyExtra);
  assert.equal(kinds(problems).filter((k) => k === 'notice').length, 0, 'a finished buy with nothing wrong is not a problem');
  await tell(problems, CALL, 'problem', 'AvgKeeper skipped 2026-10-05: x', { kind: 'skip', planId: 'p1', period: '2026-10-05' });
  assert.equal(kinds(problems).filter((k) => k === 'notice').length, 1);

  const all = makeCtx({ config: { mail: { to: 'a@b.co', level: 'all' } } });
  await tell(all, CALL, 'info', buyLine, buyExtra);
  assert.equal(kinds(all).filter((k) => k === 'notice').length, 1, 'all mails a finished buy too');
});

test('the notice is written to the ledger before lane 1 runs, and lane 1 success records notice_sent via command', async () => {
  const ctx = makeCtx({ config: { mail: { to: 'a@b.co', level: 'all', command: 'cat' } } });
  await tell(ctx, CALL, 'info', buyLine, buyExtra);
  const ledger = ctx.store.readLedger();
  const notice = ledger.find((e) => e.kind === 'notice');
  assert.equal(notice.id, 'p1:2026-10-05:buy');
  assert.equal(notice.to, 'a@b.co');
  assert.equal(notice.severity, 'info');
  assert.equal(notice.profile, 't');
  assert.equal(notice.env, 'live');
  assert.ok(notice.body.split('\n').includes(buyLine));
  assert.equal(ledger.filter((e) => e.kind === 'notice_sent').length, 1);
  assert.equal(ledger.find((e) => e.kind === 'notice_sent').via, 'command');
  assert.equal(ctx.mailed.length, 1);
  assert.equal(ctx.mailed[0].to, 'a@b.co');
  assert.equal(ctx.mailed[0].subject, notice.subject);
  assert.equal(ctx.mailed[0].body, notice.body);
});

test('a lane 1 failure warns, never throws, and leaves the notice pending', async () => {
  const ctx = makeCtx({ config: { mail: { to: 'a@b.co', level: 'all', command: 'cat' } } });
  ctx.mailFails = new Error('mail command exited 1');
  await tell(ctx, CALL, 'info', buyLine, buyExtra);
  assert.match(text(ctx), /WARNING: your mail command failed: mail command exited 1/);
  const ledger = ctx.store.readLedger();
  assert.equal(ledger.filter((e) => e.kind === 'notice').length, 1);
  assert.equal(ledger.filter((e) => e.kind === 'notice_sent').length, 0);
  assert.equal(pendingNotices(ledger).length, 1);
});

test('with no command set, the notice is written and waits for lane 2; lane 1 is never attempted', async () => {
  const ctx = makeCtx({ config: { mail: { to: 'a@b.co', level: 'all' } } });
  await tell(ctx, CALL, 'info', buyLine, buyExtra);
  assert.equal(ctx.mailed.length, 0);
  assert.equal(pendingNotices(ctx.store.readLedger()).length, 1);
});

test('no address means no notice, said once per run, not once per call site', async () => {
  const ctx = makeCtx({ config: { mail: { level: 'all' } } });
  await tell(ctx, CALL, 'info', buyLine, buyExtra);
  await tell(ctx, CALL, 'problem', 'AvgKeeper skipped 2026-10-06: x', { kind: 'skip', planId: 'p1', period: '2026-10-06' });
  const said = ctx.lines.filter((l) => l.includes('no address is set'));
  assert.equal(said.length, 1, ctx.lines.join('\n'));
  assert.equal(kinds(ctx).filter((k) => k === 'notice').length, 0);
});

test('an id already in the ledger is never prepared again', async () => {
  const ctx = makeCtx({ config: { mail: { to: 'a@b.co', level: 'all', command: 'cat' } } });
  await tell(ctx, CALL, 'info', buyLine, buyExtra);
  const before = ctx.store.readLedger().length;
  const mailedBefore = ctx.mailed.length;
  await tell(ctx, CALL, 'info', buyLine, buyExtra);
  assert.equal(ctx.store.readLedger().length, before, 'no second notice or notice_sent line');
  assert.equal(ctx.mailed.length, mailedBefore, 'lane 1 is not attempted a second time either');
});

// Lane 1 and lane 2 cannot see each other: a session can record the notice as sent while the command still runs.
test('lane 1 writes no second delivery record when the notice was recorded as sent while its command ran', async () => {
  const ctx = makeCtx({ config: { mail: { to: 'a@b.co', level: 'all', command: 'cat' } } });
  ctx.runMail = async () => {
    ctx.store.appendLedger({ kind: 'notice_sent', id: 'p1:2026-10-05:buy', via: 'assistant' }, ctx.now());
  };
  await tell(ctx, CALL, 'info', buyLine, buyExtra);
  const sent = ctx.store.readLedger().filter((e) => e.kind === 'notice_sent');
  assert.deepEqual(sent.map((e) => e.via), ['assistant']);
  assert.match(text(ctx), /mail notice p1:2026-10-05:buy went out through your mail command and was also recorded as sent by your agent/);
});

test('the buy subject total adds the per-coin figures the summary prints, so the two never differ by a cent', async () => {
  const ctx = makeCtx({ config: { mail: { to: 'a@b.co', level: 'all' } } });
  for (const [instId, clOrdId, notional] of [['ETH-USDT', 'c1', 6.664], ['BTC-USDT', 'c2', 3.334]]) {
    ctx.store.appendLedger({
      kind: 'buy_filled', planId: 'p1', period: '2026-10-05', instId, clOrdId, notional, accFillSz: '1', avgPx: '1',
    }, ctx.now());
  }
  await tell(ctx, CALL, 'info', 'AvgKeeper bought 2026-10-05: ETH 6.66 USDT, BTC 3.33 USDT.', buyExtra);
  const notice = ctx.store.readLedger().find((e) => e.kind === 'notice');
  assert.equal(notice.subject, '[AvgKeeper / t live] bought 9.99 USDT across 2 coins (2026-10-05)');
});

// Spec section 9's subject shape is <fact> (<period>): a line that names no date gets the period, once.
test('a subject whose line names no date gets the period; a line that already names it is left as it is', async () => {
  const ctx = makeCtx({ config: { mail: { to: 'a@b.co', level: 'problems' } } });
  await tell(ctx, CALL, 'problem', 'AvgKeeper: WARNING: this plan was made in Europe/Istanbul.', { kind: 'tz', planId: 'p1' });
  await tell(ctx, CALL, 'problem', 'AvgKeeper skipped 2026-10-05: x', { kind: 'skip', planId: 'p1', period: '2026-10-05' });
  assert.deepEqual(ctx.store.readLedger().filter((e) => e.kind === 'notice').map((e) => e.subject), [
    '[AvgKeeper / t live] WARNING: this plan was made in Europe/Istanbul. (2026-10-05)',
    '[AvgKeeper / t live] skipped 2026-10-05: x',
  ]);
});

// Review finding (mail.mjs:313, later): a halt subject ran 250 to 480 characters, including OKX's own key-rule
// citation (buy.mjs's OKX_KEY_RULE) or a long list of order ids to check. Spec section 9's shape is a short
// `<fact> (<period>)`, and the full line is already the body's first line, unchanged.
test('a halt subject stays short and still names the period, even for a long halt line', async () => {
  const ctx = makeCtx({ config: { mail: { to: 'a@b.co', level: 'problems' } } });
  const longLine = `AvgKeeper HALTED: OKX did not accept API key t (Invalid OK-ACCESS-KEY). OKX deletes an API key that has trade permission and no IP address bound to it after 14 days with no call to it (okx.com/en-us/help/api-faq, "Will the API key expire?"). If this key has no IP address bound to it, that rule is one possible cause; check the key on the OKX website. Nothing more is bought until you make a new plan.`;
  await tell(ctx, CALL, 'problem', longLine, { kind: 'halt', planId: 'p1', period: '2026-10-05' });
  const notice = ctx.store.readLedger().find((e) => e.kind === 'notice');
  assert.ok(notice.subject.length <= 140, `${notice.subject.length}: ${notice.subject}`);
  assert.match(notice.subject, /^\[AvgKeeper \/ t live\] HALTED: /);
  assert.match(notice.subject, /\(2026-10-05\)$/);
  // The full line is unchanged as the body's own first line.
  assert.equal(notice.body.split('\n')[0], longLine);
});

// Review finding (mail.mjs:126, later): splitting on the bare first ". " cut inside a reason's own parenthetical
// aside whenever that aside carried a sentence of its own (OKX's "Invalid Sign. Please check your secret key",
// the exact shape reasonOf can return), leaving the subject with an opening paren and no closing one.
test('a halt subject never leaves an unbalanced parenthesis when the cause itself contains a period', async () => {
  const ctx = makeCtx({ config: { mail: { to: 'a@b.co', level: 'problems' } } });
  const line = 'AvgKeeper HALTED: OKX did not accept API key t (Invalid Sign. Please check your secret key). OKX deletes an API key that has trade permission and no IP address bound to it after 14 days with no call to it. If this key has no IP address bound to it, that rule is one possible cause; check the key on the OKX website. Nothing more is bought until you make a new plan.';
  await tell(ctx, CALL, 'problem', line, { kind: 'halt', planId: 'p1', period: '2026-10-05' });
  const notice = ctx.store.readLedger().find((e) => e.kind === 'notice');
  assert.equal(notice.subject, '[AvgKeeper / t live] HALTED: OKX did not accept API key t (Invalid Sign. Please check your secret key) (2026-10-05)');
});

// Review finding (mail.mjs:126, later): a settle halt's first clause is largely orderName, so a plain character
// cut at SUBJECT_FACT_MAX often landed mid-word ("buy finished and it r..."). The cut now falls at the last word
// boundary at or before the limit.
test('a halt subject cut for length never ends mid-word', async () => {
  const ctx = makeCtx({ config: { mail: { to: 'a@b.co', level: 'problems' } } });
  const line = 'AvgKeeper HALTED: the BTC-USDT 3.33 USDT on 2026-10-05 (client id akc2130b82c8fa4ed2) buy finished and it reads as filled with a filled size of 0, so AvgKeeper cannot say what it spent. Check it in the OKX app. Nothing more is bought until you make a new plan.';
  await tell(ctx, CALL, 'problem', line, { kind: 'halt', planId: 'p1', period: '2026-10-05' });
  const notice = ctx.store.readLedger().find((e) => e.kind === 'notice');
  assert.equal(notice.subject, '[AvgKeeper / t live] HALTED: the BTC-USDT 3.33 USDT on 2026-10-05 (client id akc2130b82c8fa4ed2) buy finished and it...');
});

test('a broken config.json turns mail off the same way it turns notify off, and never throws', async () => {
  const ctx = makeCtx({});
  fs.writeFileSync(path.join(ctx.store.home, 'config.json'), '{nope');
  await tell(ctx, CALL, 'problem', 'AvgKeeper skipped 2026-10-05: x', { kind: 'skip', planId: 'p1', period: '2026-10-05' });
  assert.equal(kinds(ctx).filter((k) => k === 'notice').length, 0);
  assert.match(text(ctx), /WARNING: config\.json is not valid JSON/);
});

// ---------------------------------------------------------------------------
// runMail: lane 1's own process contract.
// ---------------------------------------------------------------------------

test('runMail passes the whole body on stdin and the subject and recipient in the environment', async () => {
  const dir = tmpDir('ak-mail-');
  const out = path.join(dir, 'got.txt');
  await runMail(`{ printf 'SUBJ=%s\\n' "$AVGKEEPER_SUBJECT"; printf 'TO=%s\\n' "$AVGKEEPER_NOTIFY_EMAIL"; cat; } > '${out}'`, 'line one\nline two', 'a subject', 'a@b.co');
  const got = fs.readFileSync(out, 'utf8');
  assert.match(got, /^SUBJ=a subject$/m);
  assert.match(got, /^TO=a@b\.co$/m);
  assert.ok(got.includes('line one\nline two'));
  await assert.rejects(runMail('exit 3', 'x', 's', 't'), /exited 3/);
});

// ---------------------------------------------------------------------------
// The mail verb.
// ---------------------------------------------------------------------------

const run = async (ctx, o = {}) => mailVerb(ctx, o);

test('with nothing set, the screen shows no address, level off, no command, nothing pending', async () => {
  const ctx = makeCtx({});
  assert.equal(await run(ctx), 0);
  const out = text(ctx);
  assert.match(out, /^AvgKeeper mail$/m);
  assert.match(out, /^Address: none\. AvgKeeper never guesses one\.$/m);
  assert.match(out, /^Level: off\. Nothing is sent\.$/m);
  assert.match(out, /^Mail command: none\./m);
  assert.match(out, /^Waiting to be sent: none\.$/m);
  // Research doc section 6: the product prints the address step while no address is set, worded like SKILL.md's.
  assert.ok(ctx.lines.includes(MAIL_ADDRESS_NEXT), out);
  assert.match(MAIL_ADDRESS_NEXT, /only after you confirm it/);
});

// Review finding (mail.mjs:429): the plain screen's Level line alone read as if mail were already on with no
// address set, when in fact nothing is prepared until one is. mail --level already says so; this screen must too.
test('the plain screen says nothing is prepared yet when the level is on but no address is set', async () => {
  const ctx = makeCtx({ config: { mail: { level: 'problems' } } });
  assert.equal(await run(ctx), 0);
  const out = text(ctx);
  assert.match(out, /^Level: problems\. Only problems are sent: /m);
  assert.ok(out.includes(`No address is set yet, so nothing is prepared: ${commandText('mail --to <address>')}.`), out);
});

test('the plain screen adds no "nothing is prepared" line once level is off, or once an address is set', async () => {
  const off = makeCtx({});
  await run(off);
  assert.doesNotMatch(text(off), /nothing is prepared/);
  const withAddress = makeCtx({ config: { mail: { level: 'problems', to: 'a@b.co' } } });
  await run(withAddress);
  assert.doesNotMatch(text(withAddress), /nothing is prepared/);
});

test('once an address is set, the screen no longer prints the address step', async () => {
  const ctx = makeCtx({ config: { mail: { to: 'a@b.co' } } });
  await run(ctx);
  assert.ok(!ctx.lines.includes(MAIL_ADDRESS_NEXT), text(ctx));
});

test('with no command set, the screen says where notices wait without pointing at a list it does not print', async () => {
  const ctx = makeCtx({});
  await run(ctx);
  const out = text(ctx);
  assert.doesNotMatch(out, /below/);
  assert.ok(out.includes(`Mail command: none. Every notice waits in ${commandText('mail --pending --profile <p>')} until you ask your agent to send it.`), out);
});

test('the notify and mail screens describe each level in the same words, from one reader', async () => {
  for (const level of ['off', 'problems', 'all']) {
    const n = makeCtx({ config: { notify: 'cat' } });
    await notifyVerb(n, { level });
    const m = makeCtx({});
    await run(m, { level });
    const words = n.lines[0].replace(/^Notify level: \w+\. /, '');
    assert.equal(m.lines[0], `Mail level: ${level}. ${words}`);
  }
});

test('mail --to says nothing is sent while the level is off only when the level is off', async () => {
  const on = makeCtx({ config: { mail: { level: 'all' } } });
  assert.equal(await run(on, { to: 'a@b.co' }), 0);
  assert.deepEqual(on.lines, ['Mail address recorded: a@b.co']);
  const off = makeCtx({});
  assert.equal(await run(off, { to: 'a@b.co' }), 0);
  assert.equal(off.lines.length, 2);
  assert.match(off.lines[1], /while the level is off/);
});

// Spec section 9: mail.command is user-written; mail --to and --level never write, trim or drop it.
test('mail --to and --level change only their own key and never write mail.command', async () => {
  const ctx = makeCtx({});
  await run(ctx, { to: 'a@b.co' });
  await run(ctx, { level: 'all' });
  assert.deepEqual(ctx.store.readConfig(), { mail: { to: 'a@b.co', level: 'all' } });
  const odd = makeCtx({ config: { notify: 'cat', mail: { command: ['~/bin/m'], level: 'loud' } } });
  await run(odd, { to: 'a@b.co' });
  assert.deepEqual(odd.store.readConfig(), { notify: 'cat', mail: { command: ['~/bin/m'], level: 'loud', to: 'a@b.co' } });
  const spaced = makeCtx({ config: { mail: { command: '  ~/bin/m  ' } } });
  await run(spaced, { level: 'problems' });
  assert.deepEqual(spaced.store.readConfig(), { mail: { command: '  ~/bin/m  ', level: 'problems' } });
});

test('the address is recorded exactly as typed and read back in full, and a bad one is refused by name', async () => {
  const ctx = makeCtx({});
  assert.equal(await run(ctx, { to: 'Yunus.K@Example.com' }), 0);
  assert.equal(ctx.lines[0], 'Mail address recorded: Yunus.K@Example.com', 'never lowercased');
  assert.equal(mailConfig(ctx.store.readConfig()).to, 'Yunus.K@Example.com');

  ctx.lines.length = 0;
  assert.equal(await run(ctx, { to: 'not-an-address' }), 1);
  assert.match(ctx.lines[0], /^REFUSED: /);
  assert.equal(mailConfig(ctx.store.readConfig()).to, 'Yunus.K@Example.com', 'a refused address does not replace a good one');
});

test('the level is one of off, problems or all; an unknown value is refused and changes nothing', async () => {
  const ctx = makeCtx({});
  assert.equal(await run(ctx, { level: 'all' }), 0);
  assert.equal(mailConfig(ctx.store.readConfig()).level, 'all');
  assert.match(ctx.lines[0], /^Mail level: all\. Every problem is sent, and also every buy that went through/);

  ctx.lines.length = 0;
  assert.equal(await run(ctx, { level: 'loud' }), 1);
  assert.match(ctx.lines[0], /^REFUSED: --level reads loud; use off, problems or all\.$/);
  assert.equal(mailConfig(ctx.store.readConfig()).level, 'all');
});

test('turning the level on with no address set warns; once an address is set the warning is gone', async () => {
  const ctx = makeCtx({});
  assert.equal(await run(ctx, { level: 'problems' }), 0);
  assert.equal(ctx.lines.length, 2, text(ctx));
  assert.match(ctx.lines[0], /^Mail level: problems\. Only problems are sent: /);
  assert.equal(ctx.lines[1], `No address is set yet, so nothing is prepared: ${commandText('mail --to <address>')}.`);

  await run(ctx, { to: 'a@b.co' });
  ctx.lines.length = 0;
  assert.equal(await run(ctx, { level: 'all' }), 0);
  assert.equal(ctx.lines.length, 1, text(ctx));
  assert.match(ctx.lines[0], /^Mail level: all\. /);
});

test('two actions at once are refused rather than one of them silently winning', async () => {
  const ctx = makeCtx({});
  assert.equal(await run(ctx, { to: 'a@b.co', level: 'all' }), 1);
  assert.match(ctx.lines[0], /pass one of --to, --level, --pending, --sent at a time/);
  assert.equal(mailConfig(ctx.store.readConfig()).to, null, 'neither action happened');
});

test('a broken config.json refuses to change any mail setting until it is fixed', async () => {
  const ctx = makeCtx({});
  fs.writeFileSync(path.join(ctx.store.home, 'config.json'), '{nope');
  assert.equal(await run(ctx, { to: 'a@b.co' }), 1);
  assert.match(ctx.lines[0], /^REFUSED: config\.json is not valid JSON/);
});

test('the pending list prints the whole notice, and warns when the address has since changed', async () => {
  const ctx = makeCtx({ config: { mail: { to: 'old@example.com', level: 'all' } } });
  await tell(ctx, CALL, 'info', buyLine, buyExtra);
  ctx.store.writeConfig({ mail: { to: 'new@example.com', level: 'all' } });
  ctx.lines.length = 0;
  assert.equal(await run(ctx, { pending: true, profile: 't', demo: false }), 0);
  const out = text(ctx);
  assert.match(out, /^AvgKeeper mail, pending \(live\)$/m);
  assert.match(out, /^id: p1:2026-10-05:buy$/m);
  assert.match(out, /^to: old@example\.com {2}WARNING: the address now set is new@example\.com/m);
  assert.match(out, /^subject: \[AvgKeeper \/ t live\]/m);
  assert.ok(out.includes(buyLine), 'the body is printed in full, not summarised');
  assert.ok(out.includes(commandText('mail --sent p1:2026-10-05:buy --profile t')), out);
});

// Section 10: an hourly period is 'YYYY-MM-DD HH', so an hourly notice id holds a space. The printed record command
// must still run exactly as printed: split the way a real shell splits it, it records that very notice.
test('the printed record command for an hourly notice runs as printed and records that notice', async () => {
  const ctx = makeCtx({ config: { mail: { to: 'a@b.co', level: 'all' } } });
  await tell(ctx, CALL, 'info', 'AvgKeeper bought 2026-10-05 10: ETH 6.67 USDT.', { kind: 'buy', planId: 'p1', period: '2026-10-05 10' });
  const id = pendingNotices(ctx.store.readLedger())[0].id;
  assert.equal(id, 'p1:2026-10-05 10:buy');
  ctx.lines.length = 0;
  assert.equal(await run(ctx, { pending: true, profile: 't', demo: false }), 0);
  const prefix = 'Record it once it is actually sent: ';
  const printed = ctx.lines.find((l) => l.startsWith(prefix)).slice(prefix.length);
  const sh = spawnSync('/bin/sh', ['-c', `printf '%s\\0' ${printed}`], { encoding: 'utf8' });
  assert.equal(sh.status, 0, sh.stderr);
  const words = sh.stdout.split('\0').slice(0, -1);
  assert.deepEqual(words.slice(0, 2), [stableNode(process.env), ENTRY_SCRIPT]);
  const argv = words.slice(2);
  assert.equal(parseArgs(argv).sent, id);
  ctx.lines.length = 0;
  assert.equal(await main(argv, ctx), 0, text(ctx));
  assert.equal(ctx.lines.at(-1), `Recorded as sent: ${id}`);
  assert.equal(noticeDelivery(ctx.store.readLedger(), id).via, 'assistant');
});

// Every notice carries the buy's profile and buy always has one, so a screen run with no --profile would otherwise
// say nothing is waiting while notices are (and an agent following it would never offer to send them).
test('with no --profile, --pending and the plain screen point to each profile that has notices waiting', async () => {
  const ctx = makeCtx({ config: { mail: { to: 'a@b.co', level: 'all' } } });
  await tell(ctx, CALL, 'info', buyLine, buyExtra);
  await tell(ctx, { profile: 'u', demo: true }, 'info', buyLine, { ...buyExtra, planId: 'p2' });

  ctx.lines.length = 0;
  assert.equal(await run(ctx, { pending: true }), 0);
  let out = text(ctx);
  assert.doesNotMatch(out, /Nothing is waiting to be sent/);
  assert.ok(out.includes(`Waiting to be sent for profile t (live): 1. See them: ${commandText('mail --pending --profile t')}`), out);
  assert.ok(out.includes(`Waiting to be sent for profile u (demo): 1. See them: ${commandText('mail --pending --profile u --demo')}`), out);

  ctx.lines.length = 0;
  assert.equal(await run(ctx, {}), 0);
  out = text(ctx);
  assert.doesNotMatch(out, /Waiting to be sent: none/);
  assert.ok(out.includes(`Waiting to be sent for profile t (live): 1. See them: ${commandText('mail --pending --profile t')}`), out);
});

test('an empty pending list says so plainly', async () => {
  const ctx = makeCtx({});
  assert.equal(await run(ctx, { pending: true }), 0);
  assert.match(text(ctx), /^AvgKeeper mail, pending \(live\)$/m);
  assert.match(text(ctx), /^Nothing is waiting to be sent\.$/m);
});

test('a notice is recorded as sent once, and a second record is refused', async () => {
  const ctx = makeCtx({ config: { mail: { to: 'a@b.co', level: 'all' } } });
  await tell(ctx, CALL, 'info', buyLine, buyExtra);
  const id = pendingNotices(ctx.store.readLedger())[0].id;

  ctx.lines.length = 0;
  assert.equal(await run(ctx, { sent: id }), 0);
  assert.equal(ctx.lines.at(-1), `Recorded as sent: ${id}`);
  assert.equal(noticeDelivery(ctx.store.readLedger(), id).via, 'assistant');

  ctx.lines.length = 0;
  assert.equal(await run(ctx, { sent: id }), 1);
  assert.match(ctx.lines[0], /already recorded as sent \(assistant\)/);
  assert.equal(ctx.store.readLedger().filter((e) => e.kind === 'notice_sent').length, 1);
});

test('an id that was never prepared cannot be recorded as sent', async () => {
  const ctx = makeCtx({});
  assert.equal(await run(ctx, { sent: 'made:up:kind' }), 1);
  assert.match(ctx.lines[0], /no notice with id made:up:kind was ever prepared/);
  assert.deepEqual(ctx.store.readLedger(), []);
});

test('another profile or the other mode never sees this profile notices, in the count or in --pending', async () => {
  const ctx = makeCtx({ config: { mail: { to: 'a@b.co', level: 'all' } } });
  await tell(ctx, CALL, 'info', buyLine, buyExtra);

  ctx.lines.length = 0;
  assert.equal(await run(ctx, { profile: 'other' }), 0);
  assert.match(text(ctx), /^Waiting to be sent: none\.$/m);

  ctx.lines.length = 0;
  assert.equal(await run(ctx, { profile: 't', demo: true }), 0);
  assert.match(text(ctx), /^Waiting to be sent: none\.$/m);

  ctx.lines.length = 0;
  assert.equal(await run(ctx, { profile: 't' }), 0);
  assert.ok(text(ctx).includes(`Waiting to be sent: 1. See them: ${commandText('mail --pending --profile t')}`), text(ctx));
});

test('the mail command is reported as set or not, and its text is never printed', async () => {
  const ctx = makeCtx({});
  ctx.store.writeConfig({ mail: { command: 'curl -d @- https://hooks.example.com/SECRET-PATH' } });
  assert.equal(await run(ctx), 0);
  const out = text(ctx);
  assert.match(out, /^Mail command: set\./m);
  assert.ok(!out.includes('SECRET-PATH'), 'a command can hold a token; the screen names it, never quotes it');
});

// ---------------------------------------------------------------------------
// mailLine: the one helper the plan card, the receipt, status and doctor all print (spec section 9, "Surfaces").
// ---------------------------------------------------------------------------

test('mailLine is off for every config that mails nothing, including a level with no address', () => {
  assert.equal(mailLine(undefined), 'Mail: off.');
  assert.equal(mailLine({}), 'Mail: off.');
  assert.equal(mailLine({ mail: { level: 'all' } }), 'Mail: off.', 'a level with no address still mails nothing');
  assert.equal(mailLine({ mail: { level: 'problems' } }), 'Mail: off.');
  assert.equal(mailLine({ mail: { to: 'a@b.co', level: 'off' } }), 'Mail: off.');
});

test('mailLine names the level and the address exactly once each config actually mails something', () => {
  assert.equal(mailLine({ mail: { to: 'a@b.co', level: 'problems' } }), 'Mail: problems only, to a@b.co.');
  assert.equal(mailLine({ mail: { to: 'a@b.co', level: 'all' } }), 'Mail: every buy with its details, to a@b.co.');
});

// Review finding (mail.mjs:224, later): mailReachLine wrapped mailLine, which already ends in a period, inside
// parentheses, and every caller added another period right after the closing paren; the screen showed
// "(Mail: problems only, to me@example.com.)." Also, "a skipped or halted buy" was unconditional, but at level
// problems a skip for no coin in loss has severity info and is never mailed (shouldNotify).
test('mailReachLine never doubles the period, and names the one skip level problems never mails', () => {
  assert.equal(mailReachLine({ mail: { level: 'off' } }), null);
  assert.equal(mailReachLine({}), null);
  const problemsNoCommand = mailReachLine({ mail: { to: 'a@b.co', level: 'problems' } });
  assert.equal(
    problemsNoCommand,
    'A skipped (except for no coin in loss) or halted buy is prepared as a mail notice (Mail: problems only, to a@b.co) that waits until you ask your agent to send it: no mail command is set',
  );
  assert.doesNotMatch(`${problemsNoCommand}.`, /\.\)\./, 'never period, close-paren, period');
  const allWithCommand = mailReachLine({ mail: { to: 'a@b.co', level: 'all', command: 'cat' } });
  assert.equal(
    allWithCommand,
    'A skipped or halted buy also reaches you by mail (Mail: every buy with its details, to a@b.co)',
  );
  assert.doesNotMatch(`${allWithCommand}.`, /\.\)\./, 'never period, close-paren, period');
});

// ---------------------------------------------------------------------------
// pendingMailCount and mailStatus: the one reader status and doctor share (schedule.test.mjs and manage.test.mjs
// each pin the screen text this feeds).
// ---------------------------------------------------------------------------

test('pendingMailCount counts only this profile and mode own undelivered notices', () => {
  const ledger = [
    { kind: 'notice', id: 'a', profile: 't', env: 'live' },
    { kind: 'notice', id: 'b', profile: 't', env: 'demo' },
    { kind: 'notice', id: 'c', profile: 'other', env: 'live' },
    { kind: 'notice_sent', id: 'a' },
  ];
  assert.equal(pendingMailCount(ledger, { profile: 't', demo: false }), 0, 'a is already sent');
  assert.equal(pendingMailCount(ledger, { profile: 't', demo: true }), 1);
  assert.equal(pendingMailCount(ledger, { profile: 'other', demo: false }), 1);
  assert.equal(pendingMailCount(ledger, { profile: 'nobody', demo: false }), 0);
});

test('mailStatus reads the line and this profile own pending count in one call', () => {
  const ctx = makeCtx({ config: { mail: { to: 'a@b.co', level: 'all' } } });
  ctx.store.appendLedger({
    kind: 'notice', id: 'x', profile: 't', env: 'live', to: 'a@b.co', severity: 'info', subject: 's', body: 'b',
  }, ctx.now());
  const status = mailStatus(ctx.store, ctx.store.readLedger(), CALL);
  assert.deepEqual(status, { line: 'Mail: every buy with its details, to a@b.co.', pending: 1 });
});
