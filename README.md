# tug: Claude vs Codex tug-of-war

Claude and Codex argue opposite sides of a motion. Both judge every round
without knowing whose argument is whose, and the averaged verdict pulls the
rope. The first side to drag the flag over its line wins. At the end, a
decision record sums up the strongest case for each side, the open risks, and
a recommendation.

```
              CLAUDE wins                         CODEX wins
  [o_o][o_o][o_o]─━┃━─━━━─━━━─━━━─◆━━┊━━━─━━━─━━━─━━━─━┃━─[o_o][o_o][o_o]
```

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

## As an agent skill

`SKILL.md` makes this a skill for both Claude Code and Codex. Link the folder
into each tool's skills directory:

```bash
ln -s ~/agent-tug-of-war ~/.claude/skills/tug-of-war
ln -s ~/agent-tug-of-war ~/.codex/skills/tug-of-war
```

Then ask either agent things like "should we switch to pnpm? run a tug of war
on it" or "get Codex to argue against my plan".

## Fairness

- Judges see arguments labelled A and B in random order, never the authors.
- Both models judge every round, so each model's bias toward its own style
  pulls against the other's.
- The AGAINST side speaks second and gets to rebut directly. For decisions
  that matter, run a second match with `--swap` and compare.
