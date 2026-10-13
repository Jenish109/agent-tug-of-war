# tug: Claude vs Codex tug-of-war

Claude and Codex argue opposite sides of a motion. Both judge every round
without knowing whose argument is whose, and the averaged verdict pulls the
rope. The first side to drag the flag over its line wins. At the end, a
decision record sums up the strongest case for each side, the open risks, and
a recommendation.

<p align="center"><img src="docs/demo.svg" alt="A real tug of war match in the terminal: Claude and Codex argue, both judge blind, and the rope moves" width="680"></p>

## Install

```bash
git clone https://github.com/Jenish109/agent-tug-of-war.git ~/agent-tug-of-war
cd ~/agent-tug-of-war
npm install -g .  # puts `tug` on your PATH
tug doctor        # checks node, claude, codex, git
```

No install needed to try it: `node tug.mjs --demo` plays with canned
arguments and no model calls.

You need Node 18.3+ and the `claude` and `codex` CLIs, both signed in. If
`ANTHROPIC_API_KEY` is set, Claude calls go to the API instead of the CLI.

## Use

```bash
tug "Pineapple belongs on pizza"
tug "This PR is safe to merge" --diff main --out decision.md
tug "We should rewrite billing in Go" -c services/billing -c docs/adr -r 8
cat proposal.md | tug "We should adopt this proposal" -c - --quiet
tug "I should take the Berlin offer" -c notes.md --swap --out berlin.md
tug "Remote work beats office work" --json > result.json
```

Run `tug --help` for every option. Defaults can live in `~/.tugrc.json` or
`./tug.config.json`, for example `{"rounds": 8, "claude-model": "opus"}`.

### Exit codes

`0` FOR wins · `10` AGAINST wins · `11` draw · `1` error · `2` bad usage.
That makes it usable as a CI gate:

```bash
tug "This change is safe to ship" --diff origin/main --quiet --fast --out review.md \
  || echo "Codex argued it down; see review.md"
```

Colors follow your terminal (truecolor or 256-color) and respect `NO_COLOR`.
Force them with `--color` or turn them off with `--no-color`.

## As an agent skill

`SKILL.md` makes this a skill for both Claude Code and Codex. Link the folder
into each tool's skills directory:

```bash
ln -s ~/agent-tug-of-war ~/.claude/skills/tug-of-war
ln -s ~/agent-tug-of-war ~/.codex/skills/tug-of-war
```

Then ask either agent things like "should we switch to pnpm? run a tug of war
on it" or "get Codex to argue against my plan".

The agent runs a short match and answers in one consistent format: the rope,
a scoreboard, the best point on each side, a recommendation, and what's still
open. The full decision record (with a scoreboard table and transcript) is
saved to a file.

**Codex note:** Codex's default sandbox stops the nested `claude` CLI from
reaching its login. Approve the command when Codex asks to run it outside the
sandbox, or use `codex exec --sandbox danger-full-access` for scripted runs.

## Fairness

- Judges see arguments labelled A and B in random order, never the authors.
- Both models judge every round, so each model's bias toward its own style
  pulls against the other's.
- The AGAINST side speaks second and gets to rebut directly. For decisions
  that matter, run a second match with `--swap` and compare.
