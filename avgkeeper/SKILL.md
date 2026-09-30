---
name: avgkeeper
description: Buys your losing OKX spot coins on a schedule with a fixed USDT budget, re-splitting it at every buy by that day's losses. Use when the user wants to average down, lower their average cost, run a recurring or DCA buy into coins that are in loss, or check, change or stop such a plan.
license: MIT
---

# AvgKeeper

AvgKeeper reads your OKX Global account, finds the coins in loss against OKX's own average buy price, and buys
them on your schedule with a fixed USDT budget. At every buy it reads the account again, so a coin that moved into
profit drops out and a coin whose loss deepened gets a larger share. OKX's own recurring buy fixes the coins and
the ratios when you create it; this does not.

Run it as `node <this skill folder>/scripts/avgkeeper.mjs <verb> ...`.

## Rules for the agent

1. Never run `buy` yourself, in any form except `buy --dry-run` and `buy --smoke`. It runs only from the user's own schedule, and refuses a hand run.
2. Never type or pass `--confirm AVGPLAN` unless the user's latest message is the word AVGPLAN, in any letter case (for example `Avgplan` or `avgplan`), and nothing else, sent after they saw the plan card, with exactly the flags that card was made from. A message with other words, punctuation, a near spelling, or look-alike letters from another alphabet or fullwidth letters is not the word; never infer it from an agreement word like `ok`, `yes`, `evet` or `devam`.
3. Never edit a crontab or a LaunchAgent yourself. AvgKeeper installs its own schedule entry when the user confirms with AVGPLAN and removes it on `stop`; `doctor` only reads it; `buy --smoke` proves the line runs.
4. Never set `AVGKEEPER_OWNER_TEST`, `AVGKEEPER_SCHEDULED` or any `AVGKEEPER_` variable.
5. Never ask for, accept or repeat an API key, secret or passphrase. If the user pastes one, tell them to delete that key on the OKX website and make a new one.
6. A REFUSED line is a finished answer. Do not look for a way around it.
7. This is not advice. Do not tell the user whether to average down.
8. Never write, edit or suggest a value for the `notify` key in ~/.avgkeeper/config.json. Tell the user the key
   name, that it holds one shell command they write themselves, and that the command receives one line on stdin;
   the user edits the file.
9. Never write, edit or suggest a value for the `mail.command` key in ~/.avgkeeper/config.json either. The user
   writes it themselves. It receives the whole notice body on stdin, the subject in the environment variable
   `AVGKEEPER_SUBJECT`, and the recipient in `AVGKEEPER_NOTIFY_EMAIL`. Never edit `mail.to` by hand either: set it
   only with `mail --to`, which checks it.
10. Whenever this skill is used on a profile, run `mail --pending --profile <p>` (add `--demo` for the demo
    account). If it lists notices, ask the user before sending any of them with your own connected mail tool. A yes
    covers that one session only; ask again next session, never carry a yes forward. Send each notice to the address
    on its `to:` line, with its subject and body exactly as printed, word for word; never summarise or reword them.
    If a notice shows the WARNING that the address now set is different, ask the user which address to use before
    sending it. For each notice you actually send this way, and no others, run the command printed after
    `Record it once it is actually sent:` exactly as shown. It is `mail --sent <id> --profile <p>`, with the id
    quoted when it holds a space, as an hourly plan's ids do.
11. Never run `okx config show`, `okx config list-profile` or read `~/.okx/config.toml` yourself: the profile name
    comes from the user, and the file and `okx config show --json` hold every saved key, secret and passphrase in
    plain text. This holds every time this skill runs, not only on the first one.

## Making a plan

Ask the user for each of these, one at a time, and propose no number yourself:
1. How often: every hour, every day, every N days, weekly on a weekday, or monthly on a day (`--every hour` with `--at :MM`, `--every day`, `days:3`, `week:mon`, `month:15`).
2. How much USDT per buy (`--budget 10`).
3. Split equally, or more to the coins with the larger loss (`--method equal` or `weighted`).
4. Which coins: every coin in loss, every coin in loss except some (`--exclude BTC,ETH`), or only some (`--only BTC,ETH`).
5. Do you want email notices? If yes: only problems, or every buy with its details?
Optional: the time (`--at 10:00`, default 10:00 machine time; for an hourly plan the minute past each hour, `--at :30`, default :05) and the dust threshold (`--dust 10`).

If question 5 was yes, set the address before showing the card, so the card already shows the mail line. Look for
a connected mail tool. If one is connected, offer the address of the account it sends from, read from that tool's
own profile call or, when it has none, the sender field of one message the user sent from it, and ask whether
notices should go to that address or to another one they type; if no mail tool is connected, ask the user to type
an address. Read the chosen address back to the user in full and wait for them to confirm it. Only after they
confirm it, run `mail --to <address>`, then `mail --level problems` (only problems) or `mail --level all` (every
buy), matching what they answered; `mail` takes one action per call, so these are two commands, not one.

If question 5 was no, run `mail`. If its Level line is not `off`, an earlier plan turned mail on; mail is one
setting for every plan on this machine, so tell the user it stops for those plans too, then run `mail --level off`.

Run `plan` with those flags and show the card word for word. It includes a line saying that typing AVGPLAN also adds
AvgKeeper's own schedule entry on this computer; do not drop it. If `plan` refuses the profile name because it ends
in `.demo`, ask the user for another okx profile name. Only after the user's latest message is the word AVGPLAN and
nothing else, in any letter case (rule 2), run the same command with `--confirm AVGPLAN`. That command also installs
the schedule (launchd on macOS, a marked crontab entry elsewhere). Relay its receipt word for word, including the
line that starts `Schedule installed` with any WARNING lines under it, or, when the install failed, the `FAIL:` line
(the plan is on, the line says whether an earlier AvgKeeper entry may still run it or nothing buys until a schedule exists, WARNING lines may follow, and the command exits 1). Run `doctor` only to check, or
when the receipt says FAIL.

## First run

0. Ask the user for the okx profile name they chose when they saved their API key (the name only, never the key;
   rule 5). Never run `okx config show`, `okx config list-profile` or read `~/.okx/config.toml` yourself: the
   profile name comes from the user, and the file and `okx config show --json` hold every saved key, secret and
   passphrase in plain text. If they have no profile yet, point them to `references/api-key-setup.md` in this skill
   folder, so they run `okx config init` themselves, in their own Terminal. Never run it for them.
1. `holdings --profile <p>` to see the account before ever making a plan.
2. Build the plan card as in "Making a plan" above and confirm it with `AVGPLAN`. If `plan` refuses because this
   copy carries no AI Builder Code from OKX yet, relay that line as it is (rule 6): nothing can be bought until an
   update carries one, and nothing is wrong with the user's account.
3. The `--confirm AVGPLAN` receipt says whether the schedule was installed (rule 3). If it says FAIL, run
   `doctor --profile <p>`: it prints the line for the user to install themselves. Otherwise `doctor` is only a check.
4. Run `buy --smoke --profile <p>` (add `--launchd` too when the receipt or `doctor` says launchd) to prove the
   installed line actually runs, and relay PASS or FAIL. It sends no order. If a notify or mail command is set, it
   sends one test message through each.

## Verbs

| Verb | Type | What it does |
|---|---|---|
| `holdings --profile <p>` | READ | Every coin with its value, OKX's profit or loss, and whether a plan would buy it. |
| `plan --profile <p> --budget --every --method [...]` | READ | The card: today's split, monthly spend, the risk sentence. Sends nothing. |
| `plan ... --confirm AVGPLAN` | WRITE | Starts the plan (rule 2) and installs its schedule entry (launchd on macOS, a marked crontab entry elsewhere), then prints `Schedule installed (...)` or a `FAIL:` line (exit code 1). Sends no order; replaces a different plan on record, or restarts the same one (same settings, same id) if it was running or halted. Can send a notice through your own notify or mail command if it closes a stale period left over from an earlier run. |
| `buy --profile <p>` | WRITE | The scheduled run. Only the user's own schedule runs this in full (rule 1); never run it by hand. |
| `status --profile <p>` | READ | The running plan, recent buys and skips, a halt and its reason. |
| `stop --profile <p>` | WRITE | Ends the plan and removes its schedule entry (`Schedule removed.`; if removal fails it prints the commands to take the entry out by hand). No typed word: stopping only lowers what the account buys. Can send a notice through your own notify or mail command if it closes a stale period left over from an earlier run. |
| `notify [--level off\|problems\|all]` | READ | Which lines reach the user's notify command. Default `problems`. |
| `mail [--profile <p>]` | READ | The mail address, the level, whether a command is set, and how many notices are waiting to be sent. |
| `mail --to <address>` / `mail --level off\|problems\|all` | READ | Sets the mail address, or the level, one action per call (the address step under Making a plan). Default level `off`: mail never starts on its own. |
| `mail --pending --profile <p>` | READ | The notices waiting to be sent for that profile. Notices are kept per profile, so name it. |
| `mail --sent <id> --profile <p>` | WRITE | Records one notice as sent right after you actually send it (agent rule 10). |
| `doctor --profile <p>` | READ | Checks the setup and reads the schedule entry, never writing it. Installed and matching the plan: `Schedule: installed (...)`. Missing or different: prints the crontab line and the launchd plist to install by hand, or says to make the plan again with AVGPLAN. With no plan, it says whether an AvgKeeper schedule entry is still installed and prints removal commands only for one that is, or when it could not tell. Exits 1 when it prints a FAIL line, for example a second AvgKeeper entry next to the installed one. |
| `buy --smoke [--launchd] --profile <p>` | READ | Runs the schedule's buy line as a dry run under the schedule's environment and says PASS or FAIL. It proves the line runs, not that it is installed (`doctor` reads that); `--launchd` also checks the saved plist matches. |
| `buy --dry-run --profile <p>` | READ | What a real buy would do right now, checking the same gates it would (halted, a stale buy lock, an unsettled send, not due, no coin in loss, every coin below OKX's minimum, free USDT below the budget). Sends nothing. |

Type: WRITE starts, replaces or ends a plan, or records an order or a sent notice, in the ledger
(`~/.avgkeeper/ledger.jsonl`, the record of what a plan and its orders did). READ never does any of those and never
sends an order. Two kinds of READ row still write a file: the plan card appends one `plan_card` line to the ledger,
the record `--confirm` checks the card against, and setting the notify level or the mail address changes
`config.json`, a setting.

Add `--demo` to any verb for the OKX demo account.

## Network calls

These reach OKX, through the okx CLI, every time they run: `holdings`, `plan` (both the card and `--confirm`),
`doctor`, and every form of `buy` (the scheduled run, `--smoke` and `--dry-run`; a dry run still reads the real
account to show what it would do). These never call OKX, only local files under `~/.avgkeeper`: `status`, `stop`,
`notify`, and every form of `mail`. `stop` and `plan --confirm` can also run your own notify or mail command (never
OKX) when they close a period an earlier run left stale, so its money still reaches a notice.

## Pause and uninstall

- To stop buying without touching anything else, run `stop`. It ends the plan and removes AvgKeeper's own schedule
  entry; the user's coins stay exactly where they are.
- If `stop` prints that the schedule could not be removed, run `doctor`: while an entry is still installed, or
  when it cannot tell, it prints the exact commands to remove it, a `crontab -e` edit or, on macOS,
  `launchctl bootout` followed by deleting the saved plist file, even after `stop`. When nothing is installed it
  says so and prints no commands.
- Removing AvgKeeper's own records, or the skill folder itself, is not something this skill runs for the user:
  point them at `README.md`'s own "Pause and uninstall" section, which names the exact folders to delete
  (`~/.avgkeeper` and the copied skill folder) themselves.

## What the user should know

- A period with too little free USDT is skipped, never part-bought. A period the Mac sleeps through (a day, or an hour for an hourly plan) is never bought later. launchd runs the job once at the next wake, and that run buys only for the period it wakes in.
- An order whose result is not known yet waits: not found on OKX yet, OKX unreachable, or still open. The next run reads it again and buys nothing new until it knows.
- An order whose result cannot be read at all halts the plan. `status` names the orders to check in the OKX app; a new plan starts buying again.
- At most one buy per period per profile and mode, whatever plan made it. For a daily or longer plan the period is the calendar day; for an hourly plan it is the local hour. Replacing a plan never buys twice in one period. A new hourly plan can still buy on a day a daily plan already bought. A new daily or longer plan does not buy on a day an hourly plan already bought or skipped in.
- The schedule runs at your machine's local time. The plan records the time zone it was made in; if the Mac's time zone changes, make a new plan with AVGPLAN, which reinstalls the schedule.
- Dollar stablecoins never join a plan. Coins worth under the dust threshold stay out unless named with `--only`.
- AvgKeeper spends only the account's free USDT. Money a trading bot or another tool has already set aside is never touched, but every buy leaves less free USDT for anything else on the same account.
