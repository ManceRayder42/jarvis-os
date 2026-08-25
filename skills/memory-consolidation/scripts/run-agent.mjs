#!/usr/bin/env node
// run-agent.mjs — the sanctioned shape for a scheduled job that invokes this
// skill:
//
//     launchd/cron  →  node  →  the real command
//
// Why node in the middle: on macOS, launchd-spawned SHELLS are denied TCC
// access to directories like ~/Desktop, so `launchd → zsh → script-under-
// Desktop` can die with "Operation not permitted" (exit 126/127) before the
// script runs. A node binary that already holds Full Disk Access passes that
// access down to a child process it spawns. Never `launchd → shell →
// command` if your hub lives somewhere TCC-gated.
//
// It also fails loud in a way a bare shell wrapper doesn't: any non-zero
// exit, or an API-error string appearing in the output, is treated as a
// failure and written clearly to the log — but this script has NO
// notification dependency of its own (no chat bridge, no webhook). If you
// want a failure alert, wire your own notification command into your
// launchd plist or cron entry; that choice belongs to you, not this plugin.
//
// Usage (from a plist or crontab):
//   node run-agent.mjs <job-name> <command> [args...]
//
// Logs to ~/Library/Logs/<job-name>.log on macOS (falls back to
// ~/.local/state/<job-name>.log elsewhere) — not /tmp, which gets cleared.

import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const [jobName, ...cmd] = process.argv.slice(2);

if (!jobName || cmd.length === 0) {
  console.error("usage: run-agent.mjs <job-name> <command> [args...]");
  process.exit(2);
}

const HOME = os.homedir();

function resolveHub() {
  if (process.env.JARVIS_HUB && process.env.JARVIS_HUB.trim()) {
    return process.env.JARVIS_HUB.trim();
  }
  try {
    const p = readFileSync(path.join(HOME, ".jarvis-hub-path"), "utf8").trim();
    if (p) return p;
  } catch {}
  return path.join(HOME, "jarvis-hub");
}
const HUB = resolveHub();

const logDir = process.platform === "darwin"
  ? path.join(HOME, "Library", "Logs")
  : path.join(HOME, ".local", "state");
mkdirSync(logDir, { recursive: true });
const log = createWriteStream(path.join(logDir, `${jobName}.log`), { flags: "a" });

const stamp = () => new Date().toISOString();
log.write(`\n${stamp()}  === start ${jobName} ===\n`);

let output = "";
const child = spawn(cmd[0], cmd.slice(1), {
  cwd: process.env.AGENT_CWD || HUB,
  // stdin closed: headless `claude -p` waits 3s for piped stdin that a
  // scheduled job never sends, and logs a warning every run.
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    // launchd hands over an almost-empty PATH; rebuild the one a login shell has.
    PATH: `${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
  },
});

const capture = (chunk) => {
  log.write(chunk);
  output += chunk;
  // Don't hold an unbounded transcript in memory for a long-running job; the
  // tail is all a human needs when reading the log, and the full text is
  // already on disk.
  if (output.length > 200_000) output = output.slice(-100_000);
};
child.stdout.on("data", capture);
child.stderr.on("data", capture);

child.on("error", (err) => {
  log.write(`${stamp()}  spawn failed: ${err.message}\n`);
  process.exit(1);
});

child.on("close", (code) => {
  // An exit code of 0 is not proof of success: a headless `claude` run can print
  // an API error and still exit clean. Treat that text as failure.
  const apiError = /API Error|Unable to connect to API|ConnectionRefused|Authentication expired|invalid_grant/i.test(output);
  const rc = apiError ? 1 : (code ?? 1);

  // process.exit() drops whatever is still buffered in the log stream, so close
  // it first and exit from the callback — otherwise the final line (the one that
  // records the exit code) is exactly the line that goes missing.
  log.end(
    `${stamp()}  === end ${jobName}, exit=${rc}${apiError ? " (api-error in output)" : ""} ===\n`,
    () => process.exit(rc),
  );
});
