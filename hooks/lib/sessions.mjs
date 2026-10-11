// Pure session-alias logic. No I/O here so it stays unit-testable.
//
// A "child" is a subagent launched from the main thread. Claude Code keeps
// every subagent resumable via SendMessage(to: agentId); this module only
// maps short aliases (exp-1, ora-2, ...) onto those agent ids and decides
// which ones are worth advertising to the primary agent.

import {
  ALIAS_PREFIXES,
  DECISION_ONLY_AGENT,
  DELEGATE_SETS,
  MODE_COMMANDS,
  PLUGIN_NAME,
  PRIMARY_AGENTS,
} from './config.mjs';

export function createState() {
  return { version: 1, mode: null, modeBaseAgentType: null, counters: {}, children: [] };
}

/** `claudekei:explorer` -> `explorer`; `general-purpose` stays as is. */
export function shortType(agentType) {
  if (typeof agentType !== 'string') return '';
  const idx = agentType.lastIndexOf(':');
  return idx === -1 ? agentType : agentType.slice(idx + 1);
}

export function aliasPrefix(agentType) {
  const type = shortType(agentType);
  if (ALIAS_PREFIXES[type]) return ALIAS_PREFIXES[type];
  const letters = type.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (letters || 'agt').slice(0, 3);
}

export function isAliasLike(value, state) {
  const match = /^([a-z0-9]{2,6})-(\d+)$/.exec(value ?? '');
  if (!match) return false;
  const prefix = match[1];
  return (
    Object.values(ALIAS_PREFIXES).includes(prefix) ||
    Object.hasOwn(state.counters, prefix)
  );
}

export function findChild(state, ref) {
  if (!ref) return undefined;
  return state.children.find((c) => c.alias === ref || c.agentId === ref);
}

/**
 * Remember a freshly launched child (or refresh an existing one) and apply
 * the per-specialist history cap.
 */
export function registerChild(state, entry, limits, now = Date.now()) {
  const existing = findChild(state, entry.agentId);
  if (existing) {
    existing.status = entry.status;
    existing.lastUsedAt = now;
    if (entry.description) existing.description = entry.description;
    return existing;
  }

  const prefix = aliasPrefix(entry.agentType);
  const next = (state.counters[prefix] ?? 0) + 1;
  state.counters[prefix] = next;

  const child = {
    alias: `${prefix}-${next}`,
    agentId: entry.agentId,
    agentType: shortType(entry.agentType),
    description: entry.description ?? '',
    status: entry.status,
    createdAt: now,
    lastUsedAt: now,
    reads: [],
  };
  state.children.push(child);
  evict(state, child.agentType, limits.maxSessionsPerAgent);
  return child;
}

/**
 * Keep at most `max` settled children per specialist type. Running children
 * are protected: they do not count toward the cap and are never evicted.
 */
export function evict(state, agentType, max) {
  const settled = state.children
    .filter((c) => c.agentType === agentType && c.status !== 'running')
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  const drop = new Set(settled.slice(max).map((c) => c.agentId));
  if (drop.size === 0) return [];
  state.children = state.children.filter((c) => !drop.has(c.agentId));
  return [...drop];
}

export function touchChild(state, ref, status, limits, now = Date.now()) {
  const child = findChild(state, ref);
  if (!child) return undefined;
  child.status = status;
  child.lastUsedAt = now;
  if (status !== 'running') evict(state, child.agentType, limits.maxSessionsPerAgent);
  return child;
}

export function recordRead(state, agentId, filePath, lines, limits) {
  const child = findChild(state, agentId);
  if (!child || !filePath) return false;
  if (limits.readContextMaxFiles === 0) return false;
  if ((lines ?? 0) < limits.readContextMinLines) return false;
  child.reads = child.reads.filter((r) => r.path !== filePath);
  child.reads.push({ path: filePath, lines });
  if (child.reads.length > limits.readContextMaxFiles) {
    child.reads = child.reads.slice(-limits.readContextMaxFiles);
  }
  return true;
}

function displayPath(filePath, cwd) {
  if (cwd && filePath.startsWith(`${cwd}/`)) {
    return filePath.slice(cwd.length + 1);
  }
  return filePath;
}

export function renderResumable(state, { cwd } = {}) {
  if (state.children.length === 0) return '';
  const sorted = [...state.children].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  const lines = [
    '### Resumable Sessions',
    'Child sessions you already ran in this conversation. Reuse is always explicit:',
    '- Continue the same thread: call `SendMessage` with to="<alias>" (load it via ToolSearch `select:SendMessage` if needed).',
    '- New or unrelated topic: launch a fresh child with the `Agent` tool.',
    '- If several aliases fit, use the most recently used one for that specialist.',
    '- Never reuse an alias blindly; an alias that is unknown or evicted fails the call.',
    '',
  ];
  for (const child of sorted) {
    const running = child.status === 'running' ? ' (running)' : '';
    lines.push(
      `- ${child.agentType}: ${child.alias}${running} ${child.description}`.trimEnd(),
    );
    if (child.reads.length > 0) {
      const files = child.reads
        .map((r) => `${displayPath(r.path, cwd)} (${r.lines} lines)`)
        .join(', ');
      lines.push(`  Context read by ${child.alias}: ${files}`);
    }
  }
  return lines.join('\n');
}

export function renderAvailableAliases(state) {
  if (state.children.length === 0) return 'none';
  return state.children
    .map((c) => `${c.alias} (${c.agentType}: ${c.description || 'no description'})`)
    .join(', ');
}

/** Returns a deny reason, or null when the delegation is allowed. */
export function checkDelegation(mode, subagentType) {
  const allowed = DELEGATE_SETS[mode];
  if (!allowed) return null;
  const type = shortType(subagentType);
  if (allowed.has(type)) return null;
  if (allowed.size === 0) {
    return `${mode} cannot delegate to subagents ("${subagentType}" denied). Do the work yourself.`;
  }
  const list = [...allowed].map((t) => `claudekei:${t}`).join(', ');
  return `${mode} may only delegate to: ${list}. "${subagentType}" is not allowed in ${mode} mode.`;
}

/** Returns a deny reason when the mode forbids all delegation (resuming a child included). */
export function checkResume(mode, child) {
  if (DELEGATE_SETS[mode]?.size !== 0) return null;
  return checkDelegation(mode, child.agentType);
}

const SPEC_EXTENSION = /\.mdx?$/i;
const SPEC_DIRECTORY = /(^|[\\/])\.designer[\\/]/;

/** Design-spec files @designer may write: `*.md`, `*.mdx`, or anything under `.designer/`. */
export function isDesignSpecPath(path) {
  return SPEC_EXTENSION.test(path) || SPEC_DIRECTORY.test(path);
}

/**
 * Deny reason when a decision-only specialist (@designer) tries to edit a
 * non-spec file, otherwise null. Anything unexpected (no path, other agents)
 * yields null so the hook fails open.
 */
export function checkDesignerEdit(agentType, toolInput) {
  if (shortType(agentType) !== DECISION_ONLY_AGENT) return null;
  const path = toolInput?.file_path ?? toolInput?.notebook_path;
  if (typeof path !== 'string' || !path) return null;
  if (isDesignSpecPath(path)) return null;
  return (
    `${PLUGIN_NAME}: @${DECISION_ONLY_AGENT} is decision-only and cannot edit code (${path}). ` +
    'Put the spec in your report or in .designer/*.md; the orchestrator will route ' +
    'implementation to @frontend-developer.'
  );
}

/**
 * Detects mode-switch commands typed by the user (`/claudekei:plan ...`). Bare
 * `/plan` is Claude Code's own plan mode, so only `claudekei:`-prefixed commands
 * and unambiguous bare names count.
 */
export function detectModeSwitch(prompt) {
  const match = /^\s*\/(claudekei:)?(orchestrate|plan|sprint|analyze)(?:\s|$)/.exec(
    prompt ?? '',
  );
  if (!match) return null;
  if (!match[1] && match[2] === 'plan') return null;
  return MODE_COMMANDS[match[2]];
}

/**
 * The claudekei primary agent named by a hook payload's `agent_type`
 * (`claudekei:planner` -> `planner`), or null for no agent, another plugin's
 * agent, or a non-primary agent.
 */
export function primaryAgentOf(agentType) {
  if (typeof agentType !== 'string') return null;
  const idx = agentType.lastIndexOf(':');
  // Ignore same-named agents that belong to other plugins.
  if (idx !== -1 && agentType.slice(0, idx) !== PLUGIN_NAME) return null;
  const type = shortType(agentType);
  return PRIMARY_AGENTS.has(type) ? type : null;
}

/**
 * A soft mode (set by `/claudekei:plan` etc.) only describes the agent that
 * was running when it was set. The real main-thread agent can change later
 * (the ClaudeKei extension restarts Claude Code with `--resume --agent ...`),
 * and then the real agent must win over the stale soft mode.
 *
 * Rule: stale when the payload names a primary agent that differs from
 * `state.modeBaseAgentType` (the primary agent active when the mode was set;
 * null = none). A payload without a claudekei primary agent never makes a
 * soft mode stale: it carries no information about the real agent.
 *
 * Legacy state (`modeBaseAgentType` missing, written before this field
 * existed) means "set under an unknown agent". The least surprising reading
 * is to keep the soft mode only when the real agent already equals it (the
 * switch is then redundant), and drop it otherwise.
 */
export function isSoftModeStale(state, agentType) {
  const real = primaryAgentOf(agentType);
  if (!state.mode || !real) return false;
  if (state.modeBaseAgentType === undefined) return real !== state.mode;
  return real !== state.modeBaseAgentType;
}

/** Drops a stale soft mode in place. Returns true when `state` changed. */
export function clearStaleMode(state, agentType) {
  if (!isSoftModeStale(state, agentType)) return false;
  state.mode = null;
  state.modeBaseAgentType = null;
  return true;
}

/** Records a soft mode switch together with the real agent it was set under. */
export function applyModeSwitch(state, mode, agentType) {
  const base = primaryAgentOf(agentType);
  if (state.mode === mode && state.modeBaseAgentType === base) return false;
  state.mode = mode;
  state.modeBaseAgentType = base;
  return true;
}

/**
 * The primary agent driving the main thread: a soft mode switch wins while
 * the real agent is the one it was set under, otherwise the real main-thread
 * agent (`--agent` / settings `agent`). Pure: callers that need the stale
 * mode removed from disk use `clearStaleMode`.
 */
export function effectiveMode(state, agentType) {
  if (state.mode && !isSoftModeStale(state, agentType)) return state.mode;
  return primaryAgentOf(agentType);
}

/**
 * Parses `/claudekei:agent [name]`, which sets the default main-thread agent
 * for new sessions. Returns null when the prompt is not that command,
 * otherwise `{ action: 'show' | 'set' | 'reset' | 'invalid', agent?, arg? }`.
 */
export function parseAgentCommand(prompt) {
  const match = new RegExp(`^\\s*\\/${PLUGIN_NAME}:agent(?:\\s+(\\S+))?\\s*$`).exec(
    prompt ?? '',
  );
  if (!match) return null;
  const arg = match[1]?.toLowerCase();
  if (!arg) return { action: 'show' };
  if (arg === 'reset' || arg === 'default') return { action: 'reset' };
  const name = shortType(arg);
  const agent = PRIMARY_AGENTS.has(name) ? name : MODE_COMMANDS[name];
  return agent ? { action: 'set', agent } : { action: 'invalid', arg: match[1] };
}

/**
 * Applies claudekei.jsonc `model`/`effort` to an Agent call for one of this
 * plugin's agents. Values the caller passed explicitly win. Returns the
 * updated tool input, or null when nothing changes.
 */
export function applyAgentConfig(toolInput, agents) {
  const type = toolInput?.subagent_type;
  if (typeof type !== 'string' || !type.startsWith(`${PLUGIN_NAME}:`)) return null;
  const entry = agents?.[shortType(type)];
  if (!entry) return null;
  const updated = { ...toolInput };
  if (entry.model && !toolInput.model) updated.model = entry.model;
  if (entry.effort && !toolInput.effort) updated.effort = entry.effort;
  const changed = updated.model !== toolInput.model || updated.effort !== toolInput.effort;
  return changed ? updated : null;
}
