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

4. **Read the record, then answer the user.** Open the `--out` file. Lead with the
   recommendation and who won (and how decisively), then the strongest point on each
   side and the open risks. Don't paste the whole transcript; offer the file path.
   Treat the debate result as evidence, not a verdict: if the arguments were weak or
   the judges split, say so.

## Exit codes

| code | meaning |
| --- | --- |
| 0 | the FOR side won |
| 10 | the AGAINST side won |
| 11 | draw |
| 1 | runtime error (CLI missing, auth, network) |
| 2 | bad usage (unknown flag, bad number, missing path) |

## Troubleshooting

- `tug doctor` shows which CLIs are missing.
- If a judge can't be reached, that judge abstains for the round and the match goes on.
- When this runs inside Codex, its sandbox may block the network calls the
  `claude` and `codex` CLIs make. Ask to run the command with network access
  or outside the sandbox.
- `--demo` plays with canned arguments and coin-flip judges, for trying the
  interface without any model calls.
