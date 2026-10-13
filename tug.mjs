#!/usr/bin/env node
// tug: Claude vs Codex tug-of-war debates.
//
// Two model families argue opposite sides of a motion, both judge every round
// blind (arguments shown as A/B in random order), and the averaged verdict
// pulls the rope. At the end a decision record sums up the case for each side.
// Run `tug --help` for usage.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

const VERSION = "0.3.0";
const MAX_CONTEXT = 40_000; // chars of context sent with every prompt
const EXIT = { FOR: 0, ERROR: 1, USAGE: 2, AGAINST: 10, DRAW: 11 };

const HELP = `tug ${VERSION}: Claude vs Codex tug-of-war debates

Usage
  tug "<motion>" [options]
  tug doctor

Context (what both sides argue about)
  -c, --context <path>     File or folder to include. Repeatable. Use - for stdin.
  -d, --diff <ref>         Include \`git diff <ref>\` (e.g. main, HEAD, HEAD~3).

Match
  -r, --rounds <n>         Round cap (default 15)
  -w, --win <n>            Notches needed to win (default 6)
  -s, --swap               Codex argues FOR, Claude argues AGAINST
      --words <n>          Max words per argument (default 50)
      --fast               Haiku for Claude, low reasoning effort for Codex
      --claude-model <m>   haiku | sonnet | opus | full model id (default sonnet)
      --codex-model <m>    Codex model (default: your Codex config)
      --demo               Canned arguments and coin-flip judges, no CLIs needed

Output
  -o, --out <file>         Write the decision record as Markdown
      --no-record          Skip the decision record (saves one model call)
  -q, --quiet              No animation; print only the final verdict
      --json               Print the full result as JSON on stdout
  -h, --help               Show this help
  -v, --version            Show the version

Exit codes
  0 FOR side wins · 10 AGAINST side wins · 11 draw · 1 error · 2 bad usage

Config
  Defaults are read from ~/.tugrc.json, then ./tug.config.json, then flags.
  Keys match the long flag names, e.g. {"rounds": 8, "claude-model": "opus"}.

Examples
  tug "Pineapple belongs on pizza"
  tug "This PR is safe to merge" --diff main --out decision.md
  tug "Rewrite the billing service in Go" -c services/billing -c docs/adr -r 8
  cat proposal.md | tug "We should adopt this proposal" -c - --quiet
  tug "Remote work beats office work" --json > result.json`;

const MOTIONS = [
  "Pineapple belongs on pizza",
  "A hot dog is a sandwich",
  "Tabs are better than spaces",
  "Cats would make better managers than dogs",
  "Every meeting should be an email",
  "Dark mode is objectively superior",
  "The cereal goes in before the milk",
];

// ---------- args + config ----------
const OPTIONS = {
  context: { type: "string", short: "c", multiple: true },
  diff: { type: "string", short: "d" },
  rounds: { type: "string", short: "r" },
  win: { type: "string", short: "w" },
  swap: { type: "boolean", short: "s" },
  words: { type: "string" },
  fast: { type: "boolean" },
  "claude-model": { type: "string" },
  "codex-model": { type: "string" },
  demo: { type: "boolean" },
  out: { type: "string", short: "o" },
  "no-record": { type: "boolean" },
  quiet: { type: "boolean", short: "q" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  model: { type: "string" }, // old alias for --claude-model
};

function usageError(msg) {
  process.stderr.write(`tug: ${msg}\nRun \`tug --help\` for usage.\n`);
  process.exit(EXIT.USAGE);
}

let parsed;
try {
  parsed = parseArgs({ args: process.argv.slice(2), options: OPTIONS, allowPositionals: true, strict: true });
} catch (e) {
  usageError(e.message.replace(/\. To specify a positional.*$/s, ""));
}

function loadConfig(path) {
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (e) { usageError(`could not parse ${path}: ${e.message}`); }
}
const cfg = { ...loadConfig(join(homedir(), ".tugrc.json")), ...loadConfig(resolve("tug.config.json")), ...parsed.values };

const int = (name, def, min, max) => {
  if (cfg[name] === undefined) return def;
  const n = Number(cfg[name]);
  if (!Number.isInteger(n) || n < min || n > max) usageError(`--${name} must be a whole number from ${min} to ${max}`);
  return n;
};

if (cfg.help) { console.log(HELP); process.exit(0); }
if (cfg.version) { console.log(VERSION); process.exit(0); }

const DEMO = !!cfg.demo;
const SWAP = !!cfg.swap;
const FAST = !!cfg.fast;
const JSON_OUT = !!cfg.json;
const QUIET = !!cfg.quiet || JSON_OUT;
const RECORD = !cfg["no-record"];
const MAX_ROUNDS = int("rounds", 15, 1, 100);
const WIN = int("win", 6, 1, 12);
const WORDS = int("words", 50, 10, 300);
const CLAUDE_MODEL = cfg["claude-model"] || cfg.model || (FAST ? "haiku" : "sonnet");
const CODEX_MODEL = cfg["codex-model"] || null;

// ---------- terminal ----------
const tty = process.stdout.isTTY && !QUIET;
const color = tty && !process.env.NO_COLOR;
const c = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const red = c("1;31"), blue = c("1;34"), dim = c("2"), bold = c("1"), yellow = c("1;33"), green = c("32");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = Math.min(process.stdout.columns || 80, 100);
const log = (...a) => { if (!QUIET) console.log(...a); };
const progress = QUIET && !JSON_OUT && process.stderr.isTTY; // "round n…" ticker on stderr
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

function wrap(text, width, indent) {
  const out = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if ((line + " " + word).trim().length > width) { out.push(line); line = word; }
    else line = (line + " " + word).trim();
  }
  if (line) out.push(line);
  return out.map((l, i) => (i ? indent : "") + l).join("\n");
}

async function typewrite(prefix, text) {
  if (QUIET) return;
  const body = wrap(text, W - 12, " ".repeat(10));
  if (!tty) return void console.log(prefix + body);
  process.stdout.write(prefix);
  for (const ch of body) { process.stdout.write(ch); await sleep(ch === "\n" ? 0 : 8); }
  process.stdout.write("\n");
}

function spinner(label) {
  if (QUIET) return () => {};
  if (!tty) { console.log(dim("  " + label)); return () => {}; }
  const frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
  let i = 0;
  const t = setInterval(() => process.stdout.write(`\r  ${yellow(frames[i++ % frames.length])} ${dim(label)}   `), 80);
  return () => { clearInterval(t); process.stdout.write("\r\x1b[2K"); };
}

// ---------- players ----------
// red pulls left and argues FOR; blue pulls right and argues AGAINST
const P = {
  red: { name: SWAP ? "CODEX" : "CLAUDE", ask: (q) => (SWAP ? askCodex(q) : askClaude(q)), paint: red },
  blue: { name: SWAP ? "CLAUDE" : "CODEX", ask: (q) => (SWAP ? askClaude(q) : askCodex(q)), paint: blue },
};
const tag = (team) => P[team].paint(P[team].name.padEnd(6));
const sideOf = (team) => (team === "red" ? "FOR" : "AGAINST");

// ---------- arena ----------
// Win lines sit exactly WIN notches from the centre; the ◆ flag moves 3 cols per notch.
const NOTCH = 3, HALF = WIN * NOTCH, CENTER = HALF + 2, ROPE_LEN = CENTER * 2 + 1, OFFSET = 17;
function arena(pos, strain = 0) {
  const flagAt = CENTER + pos * NOTCH;
  let rope = "";
  for (let i = 0; i < ROPE_LEN; i++) {
    if (i === flagAt) rope += yellow("◆");
    else if (i === CENTER - HALF) rope += red("┃");
    else if (i === CENTER + HALF) rope += blue("┃");
    else if (i === CENTER) rope += dim("┊");
    else rope += (i + strain) % 4 === 0 ? dim("─") : "━";
  }
  const team = (paint) => Array(3).fill(paint("[o_o]")).join("");
  return `  ${team(red)}${rope}${team(blue)}`;
}

function drawArena(pos) {
  if (QUIET) return;
  // centre each "X wins" label over its win line
  const redCol = OFFSET + CENTER - HALF, blueCol = OFFSET + CENTER + HALF;
  const l = `${P.red.name} wins`, r = `${P.blue.name} wins`;
  const lStart = Math.max(0, redCol - Math.floor(l.length / 2)), rStart = blueCol - Math.floor(r.length / 2);
  console.log(" ".repeat(lStart) + red(l) + " ".repeat(Math.max(1, rStart - lStart - l.length)) + blue(r));
  console.log(arena(pos));
}

async function animatePull(from, to) {
  if (QUIET) return;
  if (!tty) return drawArena(to);
  drawArena(from);
  const step = to > from ? 1 : -1;
  const up = "\x1b[1A\x1b[2K";
  for (let p = from; p !== to; p += step) {
    for (let s = 0; s < 4; s++) { process.stdout.write(up + arena(p, s) + "\n"); await sleep(50); }
    process.stdout.write(up + arena(p + step) + "\n");
    await sleep(120);
  }
}

// ---------- model backends ----------
function run(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], cwd: tmpdir() });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => reject(new Error(`${cmd} is not installed or not on PATH (${e.code}). Run \`tug doctor\`.`)));
    p.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`${cmd}: ${err.trim().split("\n").pop() || "exit " + code}`))));
    p.stdin.end(input);
  });
}

async function askClaude(prompt) {
  if (!process.env.ANTHROPIC_API_KEY) return run("claude", ["-p", "--model", CLAUDE_MODEL], prompt);
  const model = { haiku: "claude-haiku-5-5", sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5" }[CLAUDE_MODEL] || CLAUDE_MODEL;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 2000, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}

async function askCodex(prompt) {
  const dir = mkdtempSync(join(tmpdir(), "tug-"));
  const outFile = join(dir, "last.txt");
  const args = ["exec", "--skip-git-repo-check", "-s", "read-only", "--color", "never", "--output-last-message", outFile];
  if (CODEX_MODEL) args.push("-m", CODEX_MODEL);
  if (FAST) args.push("-c", "model_reasoning_effort=low");
  args.push("-");
  try {
    const stdout = await run("codex", args, prompt);
    try { return readFileSync(outFile, "utf8").trim(); } catch { return stdout; }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- context ----------
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", "vendor", "__pycache__", ".venv", "target"]);

function looksBinary(buf) {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function collectFiles(path, acc) {
  const st = statSync(path);
  if (st.isDirectory()) {
    for (const name of readdirSync(path).sort()) {
      if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
      collectFiles(join(path, name), acc);
    }
  } else if (st.isFile() && st.size < 500_000) {
    const buf = readFileSync(path);
    if (!looksBinary(buf)) acc.push({ name: relative(process.cwd(), path) || path, text: buf.toString("utf8") });
  }
}

async function readStdin() {
  if (process.stdin.isTTY) usageError("`-c -` reads from stdin, but nothing was piped in");
  const chunks = [];
  for await (const ch of process.stdin) chunks.push(ch);
  return Buffer.concat(chunks).toString("utf8");
}

async function buildContext() {
  const parts = [];
  for (const p of cfg.context || []) {
    if (p === "-") { parts.push({ name: "stdin", text: await readStdin() }); continue; }
    if (!existsSync(p)) usageError(`context path not found: ${p}`);
    collectFiles(resolve(p), parts);
  }
  if (cfg.diff) {
    const r = spawnSync("git", ["diff", cfg.diff], { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
    if (r.status !== 0) usageError(`git diff ${cfg.diff} failed: ${(r.stderr || "").trim() || "not a git repository?"}`);
    if (!r.stdout.trim()) usageError(`git diff ${cfg.diff} is empty, so there is nothing to debate`);
    parts.push({ name: `git diff ${cfg.diff}`, text: r.stdout });
  }
  if (!parts.length) return { text: "", files: [], truncated: false };
  let text = parts.map((p) => `--- ${p.name} ---\n${p.text}`).join("\n\n");
  const truncated = text.length > MAX_CONTEXT;
  if (truncated) text = text.slice(0, MAX_CONTEXT) + "\n[... context truncated ...]";
  return { text, files: parts.map((p) => p.name), truncated };
}

const contextBlock = (ctx) => (ctx.text ? `\nShared context (both sides and the judges see this):\n<context>\n${ctx.text}\n</context>\n` : "");

// ---------- agents ----------
const CANNED = {
  red: ["The motion holds up, and my opponent hasn't laid a finger on the core point.",
        "Popularity is a vote, and this side keeps winning it.",
        "Every objection so far is taste dressed up as a rule.",
        "History is on my side. The skeptics always fold eventually."],
  blue: ["Popularity proves nothing. Plenty of popular things are terrible ideas.",
         "Strip away the novelty and there's nothing left to defend.",
         "My opponent keeps confusing 'some people like it' with 'it's right'.",
         "Every argument so far from the other side has been a feeling, not a fact."],
};

function transcript(rounds) {
  if (!rounds.length) return "(none yet, this is the opening round)";
  return rounds.slice(-4)
    .map((h) => `Round ${h.n}\nFOR: ${h.for}\nAGAINST: ${h.against}\nJudges: ${h.net === 0 ? "split, no movement" : (h.net < 0 ? "FOR" : "AGAINST") + " +" + Math.abs(h.net)}`)
    .join("\n\n");
}

async function argue(team, state, ctx, forLine) {
  if (DEMO) { await sleep(400); const pool = CANNED[team]; return pool[state.rounds.length % pool.length]; }
  const mine = team === "red" ? -state.pos : state.pos;
  const score = state.pos === 0 ? "dead even" : mine > 0 ? `you lead by ${mine}` : `you trail by ${-mine}`;
  const prompt = `You are a contestant in a tug-of-war debate against another AI. Each round two judges score both arguments, and the winner pulls the rope. First to ${WIN} notches wins.

Motion: "${state.motion}"
Your side: ${sideOf(team)} the motion.
Score: ${score}.
${contextBlock(ctx)}
Recent rounds:
${transcript(state.rounds)}
${forLine ? `\nYour opponent (FOR) just said: "${forLine}"\n` : ""}
Write your argument for this round in at most ${WORDS} words. Be persuasive and concrete${ctx.text ? ", cite specifics from the shared context," : ""} rebut your opponent's latest point if there is one, and don't repeat earlier points. Wit is welcome but substance wins. Do not use tools or read files. Output only the argument: no name prefix, no quotes, no preamble.`;
  return (await P[team].ask(prompt)).replace(/^["'\s]+|["'\s]+$/g, "");
}

function parseVerdict(raw) {
  const m = raw.match(/\{[\s\S]*?\}/);
  let v;
  try { v = JSON.parse(m ? m[0] : raw); } catch { return null; }
  const w = String(v.winner).toUpperCase();
  if (w !== "A" && w !== "B") return null;
  return { winner: w, pull: Math.max(1, Math.min(3, Math.round(Number(v.pull) || 1))), reason: String(v.reason || "").slice(0, 160) };
}

// Each model judges blind: arguments are labelled A/B in random order, sides
// are named but contestants aren't. Returns signed pull (negative = FOR).
async function judgeWith(judgeTeam, state, ctx, forLine, againstLine) {
  if (DEMO) {
    await sleep(300);
    return { judge: P[judgeTeam].name, signed: (Math.random() < 0.5 ? -1 : 1) * (1 + Math.floor(Math.random() * 3)), reason: "Demo mode: coin toss." };
  }
  const forIsA = Math.random() < 0.5;
  const A = forIsA ? forLine : againstLine, B = forIsA ? againstLine : forLine;
  const prompt = `You are an impartial judge in a debate. Motion: "${state.motion}".
One argument is FOR the motion and one is AGAINST. You don't know who wrote either.
${contextBlock(ctx)}
Argument A (${forIsA ? "FOR" : "AGAINST"}): ${A}
Argument B (${forIsA ? "AGAINST" : "FOR"}): ${B}

Pick the more persuasive argument on logic, evidence${ctx.text ? " (accuracy against the shared context)" : ""} and rebuttal. Ignore which side you personally agree with. No ties. Do not use tools or read files.
Reply with only one line of JSON, nothing else:
{"winner":"A" or "B","pull":1,2 or 3,"reason":"at most 15 words"}
pull = 1 narrow win, 2 clear win, 3 knockout.`;
  let v = null;
  try { v = parseVerdict(await P[judgeTeam].ask(prompt)); } catch (e) { return { judge: P[judgeTeam].name, signed: 0, reason: `abstained (${e.message.slice(0, 80)})` }; }
  if (!v) return { judge: P[judgeTeam].name, signed: 0, reason: "abstained (unreadable verdict)" };
  const forWon = (v.winner === "A") === forIsA;
  return { judge: P[judgeTeam].name, signed: (forWon ? -1 : 1) * v.pull, reason: v.reason };
}

async function writeRecord(state, ctx, result) {
  if (DEMO) return `## Summary\n\nDemo mode: no decision record is written without the model CLIs.`;
  const all = state.rounds.map((h) => `Round ${h.n}\nFOR (${P.red.name}): ${h.for}\nAGAINST (${P.blue.name}): ${h.against}\nJudges: ${h.judges.map((j) => `${j.judge}: ${j.signed === 0 ? "abstain" : (j.signed < 0 ? "FOR" : "AGAINST") + " +" + Math.abs(j.signed)} (${j.reason})`).join("; ")}`).join("\n\n");
  const prompt = `You are writing a neutral decision record for a debate. Do not take a side beyond what the evidence supports, and do not favour either AI contestant.

Motion: "${state.motion}"
Outcome: ${result.summary}
${contextBlock(ctx)}
Full transcript:
${all}

Write concise Markdown with exactly these sections and nothing before them:
## Summary
(2-3 sentences: what was decided and how decisively)
## Strongest case FOR
(3 bullets max)
## Strongest case AGAINST
(3 bullets max)
## Risks and open questions
(3 bullets max: what neither side settled, what to verify)
## Recommendation
(1 short paragraph. The debate winner is evidence, not a mandate: recommend what a careful person should actually do.)

Do not use tools or read files.`;
  return askClaude(prompt);
}

function recordMarkdown(state, ctx, result, body) {
  const lines = [
    `# ${state.motion}`,
    "",
    `**Result:** ${result.summary}  `,
    `**Players:** FOR ${P.red.name} · AGAINST ${P.blue.name} · both judging blind  `,
    `**Date:** ${new Date().toISOString().slice(0, 10)}${ctx.files.length ? `  \n**Context:** ${ctx.files.slice(0, 12).map((f) => "`" + f + "`").join(", ")}${ctx.files.length > 12 ? ` and ${ctx.files.length - 12} more` : ""}${ctx.truncated ? " (truncated)" : ""}` : ""}`,
    "",
    body.trim(),
    "",
    "## Transcript",
    "",
    ...state.rounds.flatMap((h) => [
      `**Round ${h.n}**`,
      "",
      `- **FOR (${P.red.name}):** ${h.for}`,
      `- **AGAINST (${P.blue.name}):** ${h.against}`,
      ...h.judges.map((j) => `- *Judge ${j.judge.toLowerCase()}:* ${j.signed === 0 ? "abstained" : (j.signed < 0 ? "FOR" : "AGAINST") + " +" + Math.abs(j.signed)}. ${j.reason}`),
      `- **Rope:** ${h.net === 0 ? "no movement" : (h.net < 0 ? "FOR" : "AGAINST") + " +" + Math.abs(h.net)} → position ${h.pos}`,
      "",
    ]),
  ];
  return lines.join("\n");
}

// ---------- doctor ----------
function doctor() {
  const check = (label, cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: "utf8" });
    const ok = r.status === 0;
    console.log(`  ${ok ? green("✓") : red("✗")} ${label.padEnd(8)} ${ok ? dim((r.stdout || r.stderr).trim().split("\n")[0]) : red("not found on PATH")}`);
    return ok;
  };
  console.log(`\n  tug ${VERSION} doctor\n`);
  console.log(`  ${green("✓")} ${"node".padEnd(8)} ${dim(process.version)}`);
  const a = check("claude", "claude", ["--version"]);
  const b = check("codex", "codex", ["--version"]);
  check("git", "git", ["--version"]);
  console.log(`  ${dim("•")} ${"api key".padEnd(8)} ${process.env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY set: Claude calls use the API" : dim("not set: Claude calls use the claude CLI")}`);
  console.log(a && b ? `\n  Ready. Try: tug "Tabs are better than spaces" -r 3\n` : `\n  Install the missing CLIs and sign in, or play with --demo.\n`);
  process.exit(a && b ? 0 : EXIT.ERROR);
}

// ---------- match ----------
async function main() {
  const [first, ...rest] = parsed.positionals;
  if (first === "doctor" && !rest.length) return doctor();
  const motion = parsed.positionals.join(" ").trim() || MOTIONS[Math.floor(Math.random() * MOTIONS.length)];

  const ctx = await buildContext();
  const state = { motion, pos: 0, rounds: [] };
  const tally = { red: 0, blue: 0 };

  // Ctrl+C still keeps what was played so far
  process.on("SIGINT", () => {
    if (cfg.out && state.rounds.length) {
      writeFileSync(cfg.out, recordMarkdown(state, ctx, { summary: `Abandoned after ${state.rounds.length} rounds at position ${state.pos}.` }, "## Summary\n\nMatch abandoned before the end; no record was written."));
      process.stderr.write(`\n  Partial transcript saved to ${cfg.out}\n`);
    }
    process.stderr.write("\n  Match abandoned. Both robots fall in the mud.\n");
    process.exit(130);
  });

  const backend = DEMO ? "demo mode" : `claude ${CLAUDE_MODEL} · codex ${CODEX_MODEL || "default"}${FAST ? " · fast" : ""}`;
  log();
  log(`  ${bold("AGENT TUG OF WAR")}  ${dim("·")}  ${P.red.paint(P.red.name)} ${dim("vs")} ${P.blue.paint(P.blue.name)}  ${dim("· " + backend)}`);
  log(`  ${dim("Motion:")} ${bold(motion)}`);
  if (ctx.files.length) log(`  ${dim("Context:")} ${ctx.files.length} source${ctx.files.length > 1 ? "s" : ""}${ctx.truncated ? dim(` (truncated to ${MAX_CONTEXT / 1000}k chars)`) : ""}`);
  log(`  ${P.red.paint(P.red.name)} argues ${green("FOR")}, ${P.blue.paint(P.blue.name)} argues ${red("AGAINST")}. Both judge every round blind. First to ${WIN} notches wins.\n`);
  drawArena(0);

  for (let n = 1; n <= MAX_ROUNDS; n++) {
    log(`\n  ${dim("─".repeat(8))} ${bold("ROUND " + n)} ${dim("─".repeat(8))}`);
    if (progress) process.stderr.write(`\r\x1b[2K  round ${n}…`);

    let stop = spinner(`${P.red.name} is winding up…`);
    const forLine = await argue("red", state, ctx, null).finally(stop);
    await typewrite(`  ${tag("red")}  `, forLine);

    stop = spinner(`${P.blue.name} is plotting a rebuttal…`);
    const againstLine = await argue("blue", state, ctx, forLine).finally(stop);
    await typewrite(`  ${tag("blue")}  `, againstLine);

    stop = spinner("Both judges are deliberating…");
    const judges = await Promise.all([judgeWith("red", state, ctx, forLine, againstLine), judgeWith("blue", state, ctx, forLine, againstLine)]).finally(stop);
    for (const j of judges) {
      const pick = j.signed === 0 ? dim("abstains") : j.signed < 0 ? P.red.paint(`${P.red.name} +${-j.signed}`) : P.blue.paint(`${P.blue.name} +${j.signed}`);
      log(`  ${yellow("JUDGE")} ${dim(j.judge.toLowerCase().padEnd(6))} → ${pick} ${dim("·")} ${j.reason}`);
    }

    const avg = (judges[0].signed + judges[1].signed) / 2;
    const net = Math.sign(avg) * Math.round(Math.abs(avg));
    const next = Math.max(-WIN, Math.min(WIN, state.pos + net));
    state.rounds.push({ n, for: forLine, against: againstLine, judges, net, pos: next });

    if (net === 0) { log(`  ${dim("Split decision. The rope doesn't budge.")}\n`); drawArena(state.pos); continue; }
    const winner = net < 0 ? "red" : "blue";
    tally[winner]++;
    log(`  ${bold("PULL")}  ${P[winner].paint(P[winner].name)} +${Math.abs(net)}  ${dim(["", "heave!", "HEAVE!!", "HEAAAAVE!!!"][Math.abs(net)])}\n`);
    await animatePull(state.pos, next);
    state.pos = next;
    if (Math.abs(state.pos) >= WIN) break;
  }
  if (progress) process.stderr.write("\r\x1b[2K");

  // ---------- result ----------
  const won = state.pos < 0 ? "red" : state.pos > 0 ? "blue" : null;
  const ko = Math.abs(state.pos) >= WIN;
  const result = {
    winner: won ? sideOf(won) : "DRAW",
    winnerModel: won ? P[won].name : null,
    knockout: ko,
    summary: !won
      ? `Draw after ${plural(state.rounds.length, "round")}.`
      : `${sideOf(won)} (${P[won].name}) wins ${ko ? "by pulling the flag over the line" : `on position after the ${MAX_ROUNDS}-round cap`} in ${plural(state.rounds.length, "round")}, rounds won ${P.red.name} ${tally.red} · ${P.blue.name} ${tally.blue}.`,
  };

  log();
  if (won) log(`  🏆  ${P[won].paint(P[won].name)} ${bold(ko ? "pulls the flag over the line and WINS" : "is ahead when the rounds run out")} ${dim(`(${sideOf(won)}, ${plural(state.rounds.length, "round")}, won ${tally[won]} of them)`)}`);
  else log(`  🤝  ${bold("Dead heat.")} Nobody moved the flag far enough.`);

  let record = null;
  if (RECORD && (cfg.out || QUIET)) {
    const stop = spinner("Writing the decision record…");
    try { record = recordMarkdown(state, ctx, result, await writeRecord(state, ctx, result)); }
    catch (e) { process.stderr.write(`  Could not write the decision record: ${e.message}\n`); }
    finally { stop(); }
    if (record && cfg.out) { writeFileSync(cfg.out, record + "\n"); log(`  ${dim("Decision record saved to")} ${cfg.out}`); }
  }
  log();

  if (JSON_OUT) {
    console.log(JSON.stringify({
      version: VERSION, motion, players: { FOR: P.red.name, AGAINST: P.blue.name },
      models: { claude: CLAUDE_MODEL, codex: CODEX_MODEL || "default" },
      settings: { rounds: MAX_ROUNDS, win: WIN, words: WORDS, demo: DEMO },
      context: { sources: ctx.files, truncated: ctx.truncated },
      result: { ...result, position: state.pos, roundsWon: { FOR: tally.red, AGAINST: tally.blue } },
      rounds: state.rounds, record,
    }, null, 2));
  } else if (QUIET) {
    console.log(record ?? result.summary);
  }
  process.exit(won === "red" ? EXIT.FOR : won === "blue" ? EXIT.AGAINST : EXIT.DRAW);
}

main().catch((e) => {
  process.stderr.write(`\n  tug: ${e.message}\n  Run \`tug doctor\` to check your setup, or try --demo.\n`);
  process.exit(EXIT.ERROR);
});
