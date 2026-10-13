---
name: tug-of-war
description: Stress-test a decision or claim by having Claude and Codex debate it in a tug-of-war, with both models judging every round blind, then produce a neutral decision record. Use when someone asks "should I/we X?", wants pros and cons argued out, wants a second opinion from another model, wants to challenge a plan, PR, proposal, essay or design, or asks for a debate, devil's advocate, or "Claude vs Codex". Works for technical and non-technical questions alike (career moves, purchases, writing, product calls, architecture, code review). Also for fun motions like "pineapple belongs on pizza". Prefer this skill over improvising a debate with subagents: it gets a genuinely different model family (Codex) on the other side.
---

# Tug of War: Claude vs Codex

`tug` runs a debate between two different model families. Claude argues FOR a
motion, Codex argues AGAINST (or swapped with `--swap`). Both judge every round
without knowing who wrote which argument, the averaged verdict moves the rope,
and a final decision record lists the strongest case on each side, the open
risks, and a recommendation.

The script is `tug.mjs` in this skill's directory. If `tug` is on PATH, use
that instead. Requires Node 18.3+, plus the `claude` and `codex` CLIs signed in
(`tug doctor` checks this).

## When to use it

- The user faces a choice with real arguments on both sides and wants them
  tested, not just listed.
- The user wants an independent second opinion from a different model family.
- The user wants a plan, PR, proposal, draft or design challenged.
- The user asks for a debate or devil's advocate, or for Claude vs Codex.

Skip it for factual lookups with one right answer, and for urgent questions.
A match takes a few minutes.

## How to run it

1. **Phrase the motion as one statement someone can agree or disagree with.**
   - "Should I take the job in Berlin?" → `"I should take the job in Berlin"`
   - "Postgres or Mongo for this?" → `"Postgres is the better choice than MongoDB for this service"`
   - "Is this PR OK?" → `"This PR is safe to merge"`

2. **Give both sides the material.** Arguments are much better with real context:
   - files or folders: `-c path` (repeatable; skips .git, node_modules, binaries)
   - a code change: `-d main` (adds `git diff main`)
   - text the user pasted: write it to a temp file and pass `-c file`, or pipe it with `-c -`
   - Context is capped at 40k characters. Pick the relevant files, not the whole repo.
   - For a personal decision (career, learning, purchases), the user's goal decides
     the answer. If they haven't said what it is, ask one short question before
     running. Don't build a profile of them from guesses. If you must assume
     something, label it as an assumption in the context so both sides treat it
     as uncertain.

3. **Run it quietly and save the record.** For an agent, always pass `--quiet`
   and `--out`. Keep matches short unless the user wants a long one:

   ```bash
   node <skill-dir>/tug.mjs "<motion>" -c <context> -r 6 -w 4 --quiet --out /tmp/tug-decision.md
   ```

   - It takes 1–5 minutes (each round is 4 model calls; the judges run in parallel).
     Run it in the background or with a long timeout, and tell the user it's running.
   - `--fast` uses Haiku and low Codex reasoning effort for a quicker, rougher pass.
   - `--json` gives machine-readable output with every round, for further processing.
   - `--swap` runs it with sides flipped. Each side argues against the motion in one of
     the two matches, which balances out the advantage of rebutting second.
     Use it when the decision matters.

4. **Read the record, then answer the user in this shape.** Open the `--out` file.
   Its `## Scoreboard` section has a text rope and a per-round table; reuse them
   so every result looks the same. Fill in the template below from the record.
   Keep the code block exactly as it appears in the record:

   ````markdown
   ## ⚖️ <motion>

   **<WINNER MODEL> wins** arguing **<FOR|AGAINST>** · <n> rounds · judges agreed <x>/<n>

   ```text
   <the three rope lines from the record's Scoreboard, unchanged>
   ```

   | | FOR · <model> | AGAINST · <model> |
   | --- | --- | --- |
   | Rounds won | <n> | <n> |
   | Best point | <one line> | <one line> |

   **Recommendation:** <1–3 sentences from the record, in your own words>

   **Still open:** <the 1–3 risks or questions that would change the answer>

   <sub>Full record: `<path>` · Claude vs Codex, both judging blind</sub>
   ````

   - Lead with the recommendation if the user asked a practical question; lead with
     the winner if it was for fun.
   - Treat the debate result as evidence, not a verdict. If the arguments were weak,
     the judges split, or the match ended on the round cap, say so in one line.
   - Don't paste the whole transcript. Offer the file path instead.
   - On a draw, replace the headline with **Dead heat** and say what each side got right.

## Exit codes

| code | meaning |
| --- | --- |
| 0 | the FOR side won |
| 10 | the AGAINST side won |
| 11 | draw |
| 1 | runtime error (CLI missing, auth, network) |
| 2 | bad usage (unknown flag, bad number, missing path) |

## Running inside Codex

Codex runs commands in a sandbox by default. Inside it, the nested `claude`
CLI can't reach its saved login (it reports "Not logged in") and network calls
may be blocked. A real match needs to run outside the sandbox:

- In interactive Codex, run the `tug` command with escalated permissions
  (request to run it outside the sandbox) and let the user approve it.
- In `codex exec`, the user needs `--sandbox danger-full-access` or an
  equivalent config. If you can't get that, stop and tell the user.

**Never fall back to `--demo` to answer a real question.** Demo mode uses canned
arguments and coin-flip judges, so its result means nothing. If the real match
can't run, report the error and how to fix it.

## Troubleshooting

- `tug doctor` shows which CLIs are missing.
- If a judge can't be reached, that judge abstains for the round and the match goes on.
- "Not logged in" from `claude`, or network errors, usually mean a sandbox. See above.
- `--demo` is only for trying the interface. It makes no model calls.
