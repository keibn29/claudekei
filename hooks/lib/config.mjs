// Static configuration shared by the hook handlers.

export const PLUGIN_NAME = 'claudekei';

export const PRIMARY_AGENTS = new Set([
  'orchestrator',
  'planner',
  'sprinter',
  'business-analyst',
]);

// Slash commands (skills/<command>/SKILL.md) that switch the primary agent
// mode inside the current conversation.
export const MODE_COMMANDS = {
  orchestrate: 'orchestrator',
  plan: 'planner',
  sprint: 'sprinter',
  analyze: 'business-analyst',
};

// Primary agents that receive the workflow reminder before each user prompt.
export const REMINDER_AGENTS = new Set(['orchestrator', 'planner', 'sprinter']);

// Primary agents that receive the delegation nudge after Read/Write.
export const NUDGE_AGENTS = new Set(['orchestrator', 'planner']);

// Which specialists each primary agent may delegate to. `null` = no limit, an empty Set = no delegation.
export const DELEGATE_SETS = {
  orchestrator: null,
  sprinter: new Set(),
  planner: new Set(['explorer', 'librarian', 'oracle', 'designer']),
  'business-analyst': new Set(['explorer', 'librarian', 'oracle']),
};

// Specialist that may only write design specs, never source code (enforced by
// the PreToolUse file-edit hook), and the file tools that hook inspects.
export const DECISION_ONLY_AGENT = 'designer';
export const FILE_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export const ALIAS_PREFIXES = {
  explorer: 'exp',
  librarian: 'lib',
  oracle: 'ora',
  debugger: 'dbg',
  designer: 'des',
  'frontend-developer': 'fed',
  'backend-developer': 'bed',
  'general-purpose': 'gen',
};

export const PHASE_REMINDER_TEXT = `!IMPORTANT! Recall the workflow rules:
Understand → choose the best parallelized path based on your capabilities and agents delegation rules → recall session reuse rules → execute → verify.
If delegating, launch the specialist in the same turn you mention it !END!`;

// Values the Agent tool accepts for its `model` and `effort` parameters.
export const MODEL_ALIASES = new Set(['opus', 'sonnet', 'haiku', 'fable']);
export const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

export const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Environment variable first, then the config file value, then the default.
function intSetting(envName, fileValue, fallback, min, max) {
  const raw = process.env[envName];
  const value =
    raw !== undefined && raw !== '' ? Number.parseInt(raw, 10) : Number(fileValue ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** `fileSettings` is the `sessionManager` object from claudekei.jsonc. */
export function loadLimits(fileSettings = {}) {
  const file = fileSettings;
  const reminderEnv = process.env.KEI_PHASE_REMINDER;
  return {
    maxSessionsPerAgent: intSetting('KEI_MAX_SESSIONS_PER_AGENT', file.maxSessionsPerAgent, 1, 1, 10),
    readContextMinLines: intSetting('KEI_READ_CONTEXT_MIN_LINES', file.readContextMinLines, 10, 0, 1000),
    readContextMaxFiles: intSetting('KEI_READ_CONTEXT_MAX_FILES', file.readContextMaxFiles, 8, 0, 50),
    phaseReminder: reminderEnv ? reminderEnv !== '0' : file.phaseReminder !== false,
  };
}
