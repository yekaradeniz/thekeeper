# Set up your OKX API key for AvgKeeper

AvgKeeper never sees your OKX password, and it never sees your API key either. It reaches OKX through OKX's own
command-line tool, the okx CLI, which keeps the key in a file on your own computer (`~/.okx/config.toml`). You do
every step below yourself, on the OKX website and in your own Terminal. Never paste an API key, a secret key or a
passphrase into a chat with any AI agent, this one included: if you did, delete that key on the OKX website and
make a new one.

## 1. Create the key on the OKX website

An API key is a separate login for programs. It can only do what you allow, and you can delete it at any time
without touching your account password.

1. Open https://www.okx.com/account/my-api and start creating an API key.
2. Permissions: turn on Read and Trade. Leave Withdraw off. AvgKeeper never needs it, and without it a leaked key
   cannot move money out of your account; AvgKeeper refuses to run on a key that can withdraw.
3. IP address: if your internet connection has a fixed address, entering it here means the key only ever works from
   that one address, which is the safest choice. Most home connections do not have a fixed address; if yours does
   not, leave this blank. A key with no address bound is deleted by OKX after 14 days with no use (see the note
   below); `doctor` warns you if your plan's own schedule could leave that much of a gap.
4. Passphrase: choose one for this key and write it down. You type it again in the next step.
5. OKX shows the API key and the secret key once. Keep that page open until step 2 below is done.

OKX itself suggests a sub-account key for automated trading, so a leaked key only ever reaches that sub-account's
money. AvgKeeper works the same way with either kind of key.

## 2. Save the key on your computer

In the Terminal app, run:

```
okx config init
```

It asks six questions. Here is what to answer:

| It asks | You answer | Why |
|---|---|---|
| Site | OKX Global | AvgKeeper works with OKX Global only; it refuses a profile saved under any other site. |
| Use demo trading? | `n` for a key on your real account | Typing `n` (not just pressing Enter, and not `no`) is what saves a real key. Answer `y` only when you are making a separate demo key (see "Demo trading" below). |
| Profile name | a short name of your own choosing | See "What the profile name is", next. |
| API Key | the API key from step 1 | |
| Secret Key | the secret key from step 1 | |
| Passphrase | the passphrase you chose in step 1 | |

Once it prints that the config was saved, the key lives in `~/.okx/config.toml` on your computer and nowhere else.

### What the profile name is

The profile name is the label you give this key on your own computer, the way you save a phone number under a
contact's name; it is not your OKX account name or username, and OKX's own website never asks for it. Every
AvgKeeper command needs it, as `--profile <name>`: your agent adds it for you once you have told it the name.

You can keep more than one key on one computer, for example one for a demo account and one for your real one. Pick
a short name you will recognise, such as `my-okx` or `live`: letters, digits, dots, dashes or underscores, up to 64
characters. AvgKeeper refuses a name with a space in it or a letter outside plain A to Z.

## 3. Check the connection

Ask your agent to run `holdings --profile <your name>` (see the main `README.md`). It reads your account and lists
every coin. If the profile is not in the okx config, the profile is not on OKX Global, or the key can withdraw or
cannot trade, it says so in plain words instead of listing coins.

Never run `okx config show --json` yourself to check this: that command prints every saved profile's API key,
secret key and passphrase in plain text, straight into a terminal an agent may be reading. AvgKeeper strips those
three fields from its own copy of that same reply for exactly this reason.

## Why a key with no IP bound can stop working on its own

OKX deletes an API key that has trade or withdraw permission and no IP address bound to it after 14 days with no
call made on it (OKX's own help center, "Will the API key expire?"). AvgKeeper's key always carries trade
permission, so this applies to any AvgKeeper key with no address bound. A plan that buys often (daily or more)
never goes 14 days quiet on its own; one that buys less often (say, once a month) can. `doctor` and the plan card
both warn you when your plan's own cadence could leave that much of a gap and the key has no address bound: bind
one on the OKX website, or expect to make a new key eventually.

## Demo trading

To try AvgKeeper without touching real money, make a second, separate key at
https://www.okx.com/account/my-api?go-demo-trading=1, run `okx config init` again, answer `y` to the demo question
this time, and give it a profile name of its own (such as `my-okx-demo`). Add `--demo` to every AvgKeeper command
to use it.
