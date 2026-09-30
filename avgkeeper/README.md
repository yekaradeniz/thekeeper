# AvgKeeper

Buys your losing OKX spot coins on a schedule with a fixed USDT budget, re-split at every buy by that day's losses.

## Before you start

This build carries no AI Builder Code from OKX yet, so `plan` refuses every plan, on a demo key and a live key alike, until an update that carries one, and nothing is ever bought. `holdings` still lists your coins, and `doctor` still checks the rest of your setup.

## Install

1. Node 18 or newer (check with `node --version`). Install the okx CLI: `npm install -g @okx_ai/okx-trade-cli@1.4.6`, then `okx config init` to create a profile with an OKX Global API key. [references/api-key-setup.md](references/api-key-setup.md) walks through every question that command asks, in order.
2. From the folder that contains the `avgkeeper` folder (if your Terminal is inside `avgkeeper` itself, run `cd ..` first), run `mkdir -p ~/.claude/skills`, then copy the folder there: `cp -R avgkeeper ~/.claude/skills/avgkeeper`. Claude Code's own documentation names `~/.claude/skills` as the folder it looks for a personal skill in. To update a copy already installed, from that same folder, remove the old one first, so the new copy never lands nested inside it: `rm -rf ~/.claude/skills/avgkeeper && cp -R avgkeeper ~/.claude/skills/avgkeeper`.
3. Ask your agent: "show my holdings with AvgKeeper on profile <name>", using the profile name you chose in step 1.

Make your first plan on a demo key ([references/api-key-setup.md](references/api-key-setup.md), "Demo trading"): it spends practice money only.

## The API key

[references/api-key-setup.md](references/api-key-setup.md) has the full walkthrough: creating the key on the OKX website, then saving it with `okx config init`. In short: site OKX Global; answer `n` to the demo question for a key on your real account (`y` only for a separate demo key); choose a profile name; give the key Read and Trade permissions with Withdraw off. Never paste an API key, a secret key or a passphrase into a chat with any AI agent, this one included; if you did, delete that key on the OKX website and make a new one there.

## What actually runs

Nothing buys until a schedule entry exists. Typing AVGPLAN to confirm a plan installs it for you: a launchd job on macOS, a marked crontab entry elsewhere. The receipt shows a `Schedule installed` line, which says which scheduler holds the entry and when it wakes AvgKeeper; warning lines may follow it. If the install failed, it shows a `FAIL:` line instead, which says whether an earlier AvgKeeper entry may still run the plan; then ask your agent for `doctor`, which prints the line to install by hand. Your agent never edits a crontab or a LaunchAgent itself. With crontab, your computer has to be on and awake at the buy time: a buy time it sleeps through is missed, never bought later. With launchd on macOS, launchd runs the job once at the next wake, and that run buys only for the period it wakes in. The period is the calendar day, or the local hour for an hourly plan. AvgKeeper runs on macOS or Linux; there is no native Windows build.

## Pause and uninstall

- To stop buying, ask your agent for `stop`. It ends the running plan and removes the schedule entry AvgKeeper installed (`Schedule removed.`); your coins stay exactly where they are, and nothing more is bought.
- If `stop` prints that the schedule could not be removed, ask your agent for `doctor`: while an entry is still installed, or when it cannot tell, it prints the exact commands, a `crontab -e` edit, or on macOS `launchctl bootout` followed by removing the saved plist file, even after `stop`. When nothing is installed it says so and prints none.
- To remove AvgKeeper's own records (the ledger of every plan, buy and skip, and its settings), delete `~/.avgkeeper` (or the folder named by the `AVGKEEPER_HOME` environment variable, if you set one).
- To remove the skill itself, delete the folder you copied in step 2: `rm -rf ~/.claude/skills/avgkeeper`.
- The OKX API key itself stays saved in `~/.okx/config.toml` and stays live on OKX, with Trade on, until you or OKX delete it. If no other tool uses it, delete it on the OKX website (https://www.okx.com/account/my-api) and remove that profile's section from `~/.okx/config.toml` yourself, in a text editor.

## Test

```bash
npm test
```
