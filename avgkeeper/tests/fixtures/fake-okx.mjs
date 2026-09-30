// avgkeeper/tests/fixtures/fake-okx.mjs
// Test double for the okx CLI. Replies come from the JSON file named by AK_FAKE, keyed by "module action",
// with " --help" appended for help calls. An array value is a sequence: each call consumes the next entry.
// AK_FAKE_LOG, when set, receives one JSON line of argv per call; AK_FAKE_ENVLOG receives the OKX_UPDATE_CHECK
// value of each call; AK_FAKE_ENVDUMP, when set, receives one JSON line per call with the value of every
// variable named in AK_FAKE_ENVDUMP_KEYS (a comma-separated list), so a test can check what the runner did or
// did not pass through to the child.
import fs from 'node:fs';

const argv = process.argv.slice(2);
if (process.env.AK_FAKE_LOG) fs.appendFileSync(process.env.AK_FAKE_LOG, JSON.stringify(argv) + '\n');
if (process.env.AK_FAKE_ENVLOG) fs.appendFileSync(process.env.AK_FAKE_ENVLOG, String(process.env.OKX_UPDATE_CHECK) + '\n');
if (process.env.AK_FAKE_ENVDUMP) {
  const keys = String(process.env.AK_FAKE_ENVDUMP_KEYS || '').split(',').filter(Boolean);
  fs.appendFileSync(process.env.AK_FAKE_ENVDUMP, JSON.stringify(Object.fromEntries(keys.map((k) => [k, process.env[k] ?? null]))) + '\n');
}
const args = argv.filter((a) => !['--json', '--env', '--demo'].includes(a));
const p = args.indexOf('--profile');
if (p >= 0) args.splice(p, 2);
const help = args.includes('--help');
const words = args.filter((a) => a !== '--help');
const base = words.slice(0, 2).join(' ');
const key = help ? `${base} --help`.trim() : base;
const spec = process.env.AK_FAKE ? JSON.parse(fs.readFileSync(process.env.AK_FAKE, 'utf8')) : {};
let entry = spec[key];
if (Array.isArray(entry)) {
  const counter = `${process.env.AK_FAKE}.${key.replace(/[^a-z0-9]+/gi, '_')}.n`;
  const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
  fs.writeFileSync(counter, String(n + 1));
  entry = entry[Math.min(n, entry.length - 1)];
}
if (!entry) {
  if (help) {
    process.stdout.write(`Usage: okx ${base}\n`);
    process.exit(0);
  }
  process.stderr.write(`Error: fake okx has no reply for "${key}"\n`);
  process.exit(1);
}
if (entry.stderr) process.stderr.write(entry.stderr);
if (entry.stdout !== undefined) process.stdout.write(typeof entry.stdout === 'string' ? entry.stdout : JSON.stringify(entry.stdout));
process.exit(entry.code || 0);
