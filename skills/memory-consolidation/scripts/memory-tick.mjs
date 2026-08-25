#!/usr/bin/env node
// memory-tick.mjs — an OPT-IN scheduler front-end for the memory-consolidation
// skill. This file is never installed or wired up automatically by this
// plugin — see references/scheduling.md for how to hook it into launchd or
// cron yourself, if you want a nightly consolidation pass at all.
//
// The naive shape — a scheduled job that fires once a day and reads a
// hardcoded 24h window — loses data on every day the machine is off or
// asleep: the job never fires, and even when it does, a fixed 24h window can
// only ever see the last day. A missed day is gone for good, with no
// catch-up path.
//
// This shape ticks frequently (e.g. every 2h) and each tick asks three
// questions, usually answering "not now":
//
//   1. Did a run already succeed today (calendar day, local time)? -> exit quiet.
//   2. Is the network up? -> if not, exit quiet; the next tick retries.
//   3. Otherwise run, and stamp ONLY on success.
//
// Because the window is derived from the last-success stamp rather than from
// the clock, a machine that was off for five days produces one run that
// covers all five — the gap closes itself. This is the fix Or and the team
// shipped for the original jarvis-memory-consolidation skill; it's carried
// over here rather than reintroducing the old hardcoded-24h bug.
//
// Wrapped in `caffeinate -i` on macOS so idle sleep can't kill a run
// mid-response. caffeinate cannot wake a machine that's fully off — that
// case is handled by the catch-up window above, not by keeping anything
// awake.

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

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

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const STATE = path.join(HUB, ".consolidation-state.json");
const RUN_AGENT = path.join(SCRIPT_DIR, "run-agent.mjs");
const NODE_BIN = process.env.NODE_BIN || process.execPath;
const CLAUDE = process.env.CLAUDE_BIN || path.join(HOME, ".local/bin/claude");

const FORCE = process.argv.includes("--force");
const SINCE_ARG = (() => {
  const i = process.argv.indexOf("--since");
  return i !== -1 ? process.argv[i + 1] : null;
})();

// Local calendar day, not UTC: the whole point is "did this happen today
// from the user's point of view", and UTC disagrees with that for the first
// hours of the morning — exactly when a boot-triggered tick is most likely
// to fire.
const localDay = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const readState = () => {
  try {
    return JSON.parse(readFileSync(STATE, "utf8"));
  } catch {
    return {};
  }
};

const writeState = (state) => {
  mkdirSync(path.dirname(STATE), { recursive: true });
  writeFileSync(STATE, JSON.stringify(state, null, 2) + "\n");
};

const online = async () => {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 6000);
  try {
    // HEAD to the API host: a 401/403 still proves the network is up. Any
    // response at all is a pass; only a throw (DNS/socket/timeout) is offline.
    await fetch("https://api.anthropic.com/", { method: "HEAD", signal: ctl.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
};

const state = readState();
const today = localDay();

if (!FORCE && state.last_success_day === today) {
  process.exit(0); // already consolidated today
}

if (!FORCE && !(await online())) {
  process.exit(0); // no network — next tick retries, window keeps widening
}

// The window: everything since the last SUCCESSFUL run. First run ever (or a
// wiped state file) falls back to 24h, matching a simple daily job rather
// than trying to swallow the machine's entire Claude Code history on install.
const since =
  SINCE_ARG ||
  state.last_success_iso ||
  new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

const daysCovered = Math.max(
  1,
  Math.ceil((Date.now() - new Date(since).getTime()) / (24 * 60 * 60 * 1000))
);

const prompt = `Invoke the memory-consolidation skill and run the consolidation.

WINDOW — this overrides the skill's default 24h scope:
Consolidate every conversation exchange with a timestamp at or after ${since} (ISO 8601, UTC) up to now. That is a ${daysCovered}-day window, not one day, because scheduled runs are skipped whenever this machine is off or offline and the missed days are covered by the next successful run instead.

Read logs matching ~/.claude/projects/*/*.jsonl — every Claude Code project directory, not just one. Select files by modification time covering the whole window (not -mtime -1), then filter individual exchanges by their own timestamps against ${since}. If the glob matches zero files that is a failure, not a quiet day: say so and exit non-zero instead of taking the sparse-day path.

Scale the sparse-day rule to the window: the skill's "fewer than 10 user messages" floor is written for a single day, so apply it as 10 per day covered (${daysCovered * 10} across this window). Keep every hard cap on tokens as written — if a multi-day window would exceed them, prioritise the most recent days and say explicitly in conversation-log.md which days were summarised only shallowly.

Update the hub's memory files per the skill.`;

const spawnArgs = process.platform === "darwin"
  ? ["-i", NODE_BIN, RUN_AGENT, "memory-consolidation", CLAUDE, "--dangerously-skip-permissions", "-p", prompt]
  : null;

const child = process.platform === "darwin"
  ? spawn("/usr/bin/caffeinate", spawnArgs, {
      cwd: HUB,
      stdio: "inherit",
      env: { ...process.env, AGENT_CWD: HUB },
    })
  : spawn(NODE_BIN, [RUN_AGENT, "memory-consolidation", CLAUDE, "--dangerously-skip-permissions", "-p", prompt], {
      cwd: HUB,
      stdio: "inherit",
      env: { ...process.env, AGENT_CWD: HUB },
    });

child.on("exit", (code) => {
  if (code === 0) {
    writeState({
      last_success_day: localDay(),
      last_success_iso: new Date().toISOString(),
      last_window_start: since,
      last_days_covered: daysCovered,
      last_exit: 0,
    });
  } else {
    // Deliberately does NOT stamp: a failed run must leave the window open so
    // the next tick retries the same span instead of silently skipping it.
    writeState({
      ...state,
      last_attempt_iso: new Date().toISOString(),
      last_exit: code,
    });
  }
  process.exit(code ?? 1);
});
