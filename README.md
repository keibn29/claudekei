[🇻🇳 Tiếng Việt](README.vi.md)

# claudekei

**Delegation-first agent orchestration for Claude Code** · port of [oh-my-openkei](https://www.npmjs.com/package/oh-my-openkei) (OpenCode)

by **Kei**

---

## What it is

A Claude Code plugin (plugin name: `claudekei`) that turns the main conversation into an
**Orchestrator** that routes work to a team of specialist subagents, and remembers
each specialist's session under a short alias (`exp-1`, `ora-1`, `fed-2`) so
follow-up work continues in the same context instead of starting from scratch.

| Piece | How it works in Claude Code |
|---|---|
| Orchestrator as the main agent | `settings.json` → `"agent": "orchestrator"` |
| Specialists | `agents/*.md` subagents, invoked as `claudekei:<name>` via the `Agent` tool |
| Session reuse | Native `SendMessage` resume + hooks that map aliases → agent ids |
| Per-agent skills | `skills:` frontmatter (namespaced `claudekei:<name>`, preloaded; FE/BE/BA also verify and load them first via `Skill`) |
| Per-agent MCP access | `tools:` allowlists (`mcp__plugin_claudekei_context7__*`, …) |
| Planner / Sprinter / Business Analyst | `claude --agent claudekei:<name>` or `/claudekei:plan`, `/claudekei:sprint`, `/claudekei:analyze` in-session |
| Workflow reminders | `UserPromptSubmit` / `PostToolUse` hooks |

## What's new in v0.5.0

- **`/claudekei:agent <name>`** picks the primary agent for **new** sessions from inside the
  chat, no CLI needed. See [Switching the primary agent](#switching-the-primary-agent).
- **`claudekei.jsonc`** sets specialist models/effort, like `oh-my-openkei.jsonc`; a ready-to-copy
  template ships in the repo. The
  OpenCode key `variant` is now `effort`, matching Claude Code. See [Models and effort](#models-and-effort).
- **Removed** the `trigger-developer` and `observer` specialists.
- Primary-agent model/effort is no longer written by the plugin: choose it in the app.

## Install

Requirements: Claude Code ≥ 2.1, Node.js ≥ 18 (hooks run with `node`).

```bash
claude plugin marketplace add keibn29/claudekei-plugin
```

```bash
claude plugin install claudekei@claudekei
```

Or inside Claude Code: `/plugin marketplace add keibn29/claudekei-plugin`, then
`/plugin install claudekei@claudekei`.

Update to the latest release:

```bash
claude plugin marketplace update claudekei
```

```bash
claude plugin update claudekei@claudekei
```

To work from a local clone instead, add the folder: `claude plugin marketplace add ~/Projects/claudekei-plugin`.

Try it without installing:

```bash
claude --plugin-dir ~/Projects/claudekei-plugin
```

Verify: start a session and ask `ping all agents` — the orchestrator should launch each
specialist.

> The plugin makes **Orchestrator the default main agent** wherever it is enabled. To keep
> plain Claude in a project, disable the plugin there:
> `.claude/settings.json` → `{"enabledPlugins": {"claudekei@claudekei": false}}`.

## The team

### Primary agents (who you talk to)

| Agent | Start it with | Model (CLI default¹) | Role |
|---|---|---|---|
| **orchestrator** (default) | `claude` / `/claudekei:orchestrate` | opus | Delegation-first coordinator: routes, parallelizes, reuses sessions, integrates and verifies |
| **planner** | `claude --agent claudekei:planner` / `/claudekei:plan` | opus | Interview-first planning; delegates only to explorer/librarian/oracle/designer; returns `<planner-plan>` |
| **sprinter** | `claude --agent claudekei:sprinter` / `/claudekei:sprint` | sonnet | Fast self-executing agent; delegation (Agent) and resuming children (SendMessage) are blocked by a hook |
| **business-analyst** | `claude --agent claudekei:business-analyst` / `/claudekei:analyze` | opus | Research + requirements + strategy; delegates to explorer/librarian/oracle; saves analysis to `.business-analyst/*.md` |

¹ Used when nothing else picks the model, e.g. `claude --agent claudekei:sprinter`. The
desktop app always starts sessions with the model from its picker, which wins.

### Switching the primary agent

There is no Shift+Tab agent switcher in Claude Code. Use one of these, all typed in the chat:

| You want | Type | Takes effect |
|---|---|---|
| Change role **in this conversation**, keep the context | `/claudekei:plan`, `/claudekei:sprint`, `/claudekei:analyze`, `/claudekei:orchestrate` | Immediately |
| Change the agent **new sessions** start with (real tool restrictions, like `--agent`) | `/claudekei:agent planner` (or `orchestrator`, `sprinter`, `business-analyst`) | **Only in a new session** |
| Go back to the default (orchestrator) | `/claudekei:agent reset` | **Only in a new session** |
| See the current default | `/claudekei:agent` | — |

> [!WARNING]
> `/claudekei:agent` does **not** change the conversation you type it in. That one keeps
> its agent. After running it, **open a new session** (Cmd+N in the desktop app, or start
> `claude` again) to get the new agent.
>
> - The app shows **"A hook blocked your prompt"**. That is expected: the plugin saved the
>   choice and stopped the message so no model turn is spent. You don't need to edit or
>   resend it.
> - The choice stays until you change it or run `/claudekei:agent reset`. You don't need to
>   repeat it each session. By default it is saved **per project** in
>   `.claude/settings.local.json` (keep that file out of git).

**Prefer no `.claude/` folder in your projects?** Add `"agentScope": "global"` to
`~/.claude/claudekei.jsonc`. `/claudekei:agent` then saves the choice in
`~/.claude/settings.json` for **all projects** and never writes into the project. A project
that still sets its own `agent` wins; the command tells you when that happens.

Typical flow: `/claudekei:agent planner` → Cmd+N → plan → `/claudekei:agent reset` →
Cmd+N → implement with the orchestrator.

From the terminal, `claude --agent claudekei:<name>` starts a session with that agent directly.

### Specialists (`subagent_type: claudekei:<name>`)

| Agent | Default model | Access | Role |
|---|---|---|---|
| explorer | haiku, effort low | read-only (+ Serena if configured) | Locate files, symbols, patterns |
| librarian | haiku, effort low | read-only + `ToolSearch` + context7, grep_app, websearch (+ Atlassian); WebFetch/WebSearch only as fallback | Library docs, API references, GitHub examples |
| oracle | opus, effort high | read-only, skill `claudekei:simplify` | Architecture, trade-offs, code review, escalated bugs |
| debugger | sonnet, effort xhigh | read-only | Root-cause investigation, no fixes |
| designer | sonnet, effort high | read + spec-only writes (`*.md`/`*.mdx`, `.designer/`); no Bash, no subagents; a `PreToolUse` hook denies code edits | UI/UX direction, specs, and review; implementation goes to frontend-developer |
| frontend-developer | sonnet, effort high | full (no subagents), skills `claudekei:vercel-react-best-practices`, `claudekei:karpathy-guidelines` | Client-side implementation + tests |
| backend-developer | sonnet, effort high | full (no subagents), skills `claudekei:backend-developer`, `claudekei:karpathy-guidelines` | Server-side implementation + tests |

### Models and effort

**Primary agents** (orchestrator, planner, sprinter, business-analyst) run on the
session's model and effort. Pick them in the app's model menu (Cmd+Shift+I) and effort
menu (Cmd+Shift+E), or with `/model` and `/effort`; the app remembers your choice. The defaults
in the table (Opus for orchestrator, planner and business-analyst, Sonnet for sprinter) are
what we recommend picking. The plugin does not set these: the desktop app
starts every session with explicit `--model`/`--effort`, which beat any settings value.
`claudekei.jsonc` has a `primaryAgents` block with a default model/effort per primary agent;
the ClaudeKei VS Code extension applies it when you switch the main agent (the app and CLI
ignore it), and `/claudekei:agent <name>` mentions the configured values.

**Specialists** use the defaults in the table above. To change them without editing the
plugin, create `~/.claude/claudekei.jsonc` (all projects) or
`<project>/.claude/claudekei.jsonc` (one project, wins per field). It is like
`oh-my-openkei.jsonc` with a single `subAgents` map (agent → `{ "model", "effort" }`), no named presets.

Start from the template [`claudekei.jsonc`](claudekei.jsonc): it lists every specialist with
its default model/effort, so an unedited copy changes nothing. Copy it (skipped if you
already have one), then edit the values you want:

```bash
mkdir -p ~/.claude && [ -f ~/.claude/claudekei.jsonc ] || curl -fsSL https://raw.githubusercontent.com/keibn29/claudekei-plugin/main/claudekei.jsonc -o ~/.claude/claudekei.jsonc
```

From a local clone: `cp -n claudekei.jsonc ~/.claude/claudekei.jsonc`. For one project only,
copy it to `<project>/.claude/claudekei.jsonc` instead.


- Applies from the next delegation, even in an open session: no plugin update, no new session.
- `model`: `opus`, `sonnet`, `haiku` or `fable`. These names always mean the latest version
  (today Opus 5.5, Sonnet 5.5, Haiku 5.5). To pin one, set e.g.
  `"ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-5-5"` under `"env"` in `~/.claude/settings.json`.
- `effort`: `low`, `medium`, `high`, `xhigh`, `max`.
- Entries for the four primary agents are ignored in `subAgents`; use `primaryAgents` for those:
  `{ "orchestrator": { "model": "opus", "effort": "high" }, ... }`, model = alias or full
  model id, effort optional (omit = the model's default). Same user/project merge as `subAgents`;
  only the ClaudeKei VS Code extension applies it.
- `presets` is the deprecated former name of `subAgents`: still read, with a warning.

Details: [docs/configuration.md](docs/configuration.md#config-file-claudekeijsonc).

## Session reuse

```text
### Resumable Sessions
- explorer: exp-1 Find PHASE_REMINDER_TEXT usage
  Context read by exp-1: src/config/constants.ts (30 lines), src/hooks/phase-reminder/index.ts (95 lines)
- oracle: ora-1 Review auth architecture
```

- Every `Agent` call from the main thread is registered under an alias and the model is
  told the alias immediately.
- Same thread → `SendMessage` with `to: "exp-1"`; the hook rewrites the alias to the real
  agent id. New topic → a fresh `Agent` call.
- Unknown/evicted aliases are rejected before the call runs, with the list of valid ones.

Details: **[docs/session-management.md](docs/session-management.md)**.

## Documentation

| Doc | What it covers |
|---|---|
| [Session Management](docs/session-management.md) | Aliases, eviction, read context, limits |
| [Configuration](docs/configuration.md) | Models, env vars, MCP servers, skills, customizing agents |
| [Migrating from oh-my-openkei](docs/migration-from-opencode.md) | What maps 1:1, what changed, what was dropped |

## Development

```bash
npm test                # hook unit + integration tests (node:test)
npm run sync:modes      # regenerate /claudekei:* mode skills from agents/*.md
npm run check           # sync check + tests + claude plugin validate
scripts/release.sh      # bump (patch), check, commit, tag, push, update local plugin
```

`skills/{orchestrate,plan,sprint,analyze}/SKILL.md` are generated from the matching
primary agent — edit `agents/*.md`, then run `npm run sync:modes`.

## License

MIT
