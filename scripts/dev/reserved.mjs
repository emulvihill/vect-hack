// reserved.mjs <name> -- <command...>: run a command under this account's
// reservation wrapper for <name>, or directly when it has none (vect-hack-v63n).
//
// The wrappers live in ${XDG_CONFIG_HOME:-~/.config}/vect-hack/reserve.json, a
// map from name to argv prefix, e.g. {"test": ["nice", "-n", "10"]}. It is per
// account rather than a gitignored file in the checkout because gitignored files
// do not follow a checkout into its git worktrees. scripts/dev/reserve.example.json
// is the format by example.
//
// No file, or no entry for <name>: the command runs on this host as it is.
// A file that cannot be read or parsed is exit 2, never a direct run: a broken
// config must not silently drop a reservation someone set up. Likewise a
// wrapper that fails (a busy or unreachable queue) is its exit code, not a
// reason to run without it.
import { spawn } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [name, sep, ...command] = process.argv.slice(2);
const fail = (msg) => { console.error(`reserved: ${msg}`); process.exit(2); };
if (!name || sep !== "--" || !command.length) fail("usage: reserved.mjs <name> -- <command...>");

const file = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "vect-hack", "reserve.json");
let config = {};
try {
  config = JSON.parse(readFileSync(file, "utf8"));
} catch (err) {
  if (err.code !== "ENOENT") fail(`${file}: ${err.message}; fix or remove it`);
  // ENOENT through a link that exists is a config gone missing, not no config.
  if (lstatSync(file, { throwIfNoEntry: false })) fail(`${file}: a dangling symlink; fix or remove it`);
}
if (config === null || typeof config !== "object" || Array.isArray(config)) fail(`${file}: not a JSON object`);
// Every entry, not just <name>'s: a bad "gates" must not wait for check:gates to surface.
for (const [key, value] of Object.entries(config)) {
  const valid = Array.isArray(value) && value.length && value.every((a) => typeof a === "string");
  if (!valid) fail(`${file}: "${key}" must be a non-empty array of strings`);
}
const prefix = Object.hasOwn(config, name) ? config[name] : undefined;
if (!prefix) console.error(`reserved: no reservation configured for ${name}; running on this host`);

const argv = [...(prefix ?? []), ...command];
const child = spawn(argv[0], argv.slice(1), { stdio: "inherit" });
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => child.kill(sig));
child.on("error", (err) => { console.error(`reserved: ${argv[0]}: ${err.message}`); process.exit(127); });
child.on("exit", (code, signal) => {
  if (!signal) process.exit(code);
  process.removeAllListeners(signal);
  process.kill(process.pid, signal);
});
