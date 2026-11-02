# Skills

Agent skills by Tim Wolf · [timwolf.com](https://timwolf.com) · GitHub [@theamazingwolf](https://github.com/theamazingwolf) · X/IG @realtimwolf

Each skill is a self-contained folder under `plugins/wlf-skills/skills/` (`SKILL.md` plus its
references, scripts and assets) that works in any agent that reads skills.
The whole pack also installs as one plugin, `wlf-skills`, which adds slash
commands as entry points. Install the pack once; each skill below lists its
own requirements.

## Install

### Any agent via `npx skills`

```bash
npx skills add theamazingwolf/skills
```

List the skills without installing:

```bash
npx skills add theamazingwolf/skills --list
```

Install one skill only:

```bash
npx skills add theamazingwolf/skills --skill wlf-jev
```

### Claude Code

```
/plugin marketplace add theamazingwolf/skills
/plugin install wlf-skills@theamazingwolf
```

From your shell: `claude plugin marketplace add theamazingwolf/skills`,
then `claude plugin install wlf-skills@theamazingwolf`.

### Codex

```bash
codex plugin marketplace add theamazingwolf/skills
codex plugin add wlf-skills@theamazingwolf
```

### GitHub Copilot CLI

```bash
copilot plugin marketplace add theamazingwolf/skills
copilot plugin install wlf-skills@theamazingwolf
```

Pick one route per agent. Installing the same skill through both
`npx skills` and the plugin loads it twice.

## Skills

| Skill | What it does |
|---|---|
| [wlf-jev](plugins/wlf-skills/skills/wlf-jev/) | Design, code, calibrate and run TypeSafe Jev typed-judgment questions in your codebase |

### wlf-jev

#### What it does

Turns "classify / check / score / route X" into TypeSafe Jev questions,
working TypeScript in your repo, and a calibration report that says how far
to trust them. It picks the primitive (noul, choice, score, box), writes the
wording and state, measures agreement against a small set of human labels,
and wires the result in as an agent tool, in-app classifier, agent guard
check or batch run. Ships a calibration script, a question runner with an
offline mock mode, TypeScript starters and a visual explainer.

The rule it follows: Jev makes judgments and code makes decisions, and no
threshold ships without agreement measured against human labels.

#### What you need

- Node 22 or newer.
- A [TypeSafe](https://typesafe.ai) account and an API key in
  `TYPESAFE_API_KEY` (environment or a git-ignored `.env`). Without a key,
  the question runner's `--mock` mode still supports offline design and
  pipeline tests.
- **Data notice:** whatever goes into a Jev question's `state` (and its
  `instructions` or `criteria`) is sent to TypeSafe, a third-party service.
  Keep secrets out, and check that the data's owner is fine with that.

#### Commands

Plugin commands (Claude Code):

| Command | Skill mode |
|---|---|
| `/wlf-skills:jev-setup [client-project-path]` | Check Node, SDK and key; make a smoke call |
| `/wlf-skills:jev-explain [question]` | Open the visual explainer |
| `/wlf-skills:jev-design <what-to-judge>` | Pick primitives, write questions, state and a confidence plan |
| `/wlf-skills:jev-calibrate [spec] [labelled-items]` | Measure agreement against human labels, pick thresholds |
| `/wlf-skills:jev-integrate [shape] [spec]` | Wire in as agent tool, classifier, guard check or batch run |
| `/wlf-skills:jev-run <spec> <data>` | Estimate cost, then run at scale |

Or just ask ("add a Jev check for...") and the skill triggers on its own.

_Not affiliated with or endorsed by TypeSafe. TypeSafe and Jev are trademarks of their respective owners._

## Layout

```
.claude-plugin/marketplace.json        marketplace "theamazingwolf"
plugins/wlf-skills/
  .claude-plugin/plugin.json           plugin "wlf-skills" (bundles every skill)
  commands/                            slash commands (plugin installs only)
  skills/<skill>/                      each skill: SKILL.md, references, scripts, assets
```

`npx skills` finds every skill under `plugins/wlf-skills/skills/` through
the marketplace file, so each one is installable on its own.

## License

[MIT](LICENSE) © 2026 Tim Wolf
