// Hook event handlers. Each returns the JSON object to print on stdout, or
// null for "no opinion". All state access goes through the injected store so
// tests can point it at a temporary directory.

import {
  NUDGE_AGENTS,
  PHASE_REMINDER_TEXT,
  FILE_EDIT_TOOLS,
  PLUGIN_NAME,
  PRIMARY_AGENTS,
  REMINDER_AGENTS,
} from './config.mjs';
import {
  projectSettingsPaths,
  readAgent,
  userSettingsPath,
  writeAgent,
} from './project-settings.mjs';
import {
  applyAgentConfig,
  applyModeSwitch,
  checkDelegation,
  checkResume,
  checkDesignerEdit,
  clearStaleMode,
  detectModeSwitch,
  effectiveMode,
  findChild,
  isAliasLike,
  isSoftModeStale,
  parseAgentCommand,
  recordRead,
  registerChild,
  renderAvailableAliases,
  renderResumable,
  touchChild,
} from './sessions.mjs';

const TASK_NOTIFICATION = /^\s*<task-notification>/;

function context(eventName, text) {
  if (!text) return null;
  return {
    hookSpecificOutput: { hookEventName: eventName, additionalContext: text },
  };
}

function deny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

// Stops the prompt before it reaches the model; `reason` is shown to the user.
function block(reason) {
  return { decision: 'block', reason };
}

const isMainThread = (input) => !input.agent_id;

// Reads the session state for a main-thread hook. A soft mode left over from
// a different real agent is removed from disk first, so the real `agent_type`
// wins from then on (see isSoftModeStale in sessions.mjs).
function readMainState(input, store) {
  const state = store.readState(input.session_id);
  if (!isMainThread(input)) return state;
  if (!isSoftModeStale(state, input.agent_type)) return state;
  return store.withState(input.session_id, (s) =>
    clearStaleMode(s, input.agent_type) ? undefined : false,
  ).state;
}

function onSessionStart(input, { store, limits }) {
  store.pruneStale();
  if (input.source === 'clear') {
    store.deleteState(input.session_id);
    return null;
  }
  if (input.source === 'startup') return null;
  // resume / compact: re-advertise remembered aliases.
  const state = readMainState(input, store);
  if (!effectiveMode(state, input.agent_type)) return null;
  return context('SessionStart', renderResumable(state, { cwd: input.cwd, limits }));
}

const AGENT_USAGE = `Usage: /${PLUGIN_NAME}:agent <${[...PRIMARY_AGENTS].join('|')}|reset>`;

// A project-level `agent` wins over ~/.claude/settings.json; report it so a
// global change is not silently ignored here.
function projectOverride(projectDir) {
  for (const file of projectSettingsPaths(projectDir)) {
    try {
      const agent = readAgent(file);
      if (agent) return { agent, file: file.slice(projectDir.length + 1) };
    } catch {
      // Unreadable project settings: nothing to report.
    }
  }
  return null;
}

// One sentence about the model/effort claudekei.jsonc configures for a primary agent.
// Hooks cannot apply it to the main thread: the ClaudeKei VS Code extension does.
function primaryPresetNote(agent, primaryAgents) {
  const preset = primaryAgents?.[agent];
  if (!preset?.model && !preset?.effort) return '';
  const parts = [preset.model && `model ${preset.model}`, preset.effort && `effort ${preset.effort}`];
  return (
    ` claudekei.jsonc primaryAgents.${agent}: ${parts.filter(Boolean).join(', ')}, applied by the ` +
    'ClaudeKei VS Code extension; elsewhere the model picked in the app or with /model and /effort wins.'
  );
}

// claudekei.jsonc entries that were ignored, so a typo shows up where users look.
function configWarningNote(warnings) {
  return warnings?.length ? ` Ignored in claudekei.jsonc: ${warnings.join('; ')}.` : '';
}

// `/claudekei:agent <name>` sets the default agent for NEW sessions, in this
// project or (with "agentScope": "global") in all projects. The hook does the
// write itself so no model turn is spent. Model and effort stay with the app's
// pickers: the desktop app starts every session with explicit --model/--effort
// flags, which beat any settings value.
function onAgentCommand(command, input, { store, agentScope, primaryAgents, warnings }) {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd;
  const global = agentScope === 'global';
  const file = global ? userSettingsPath() : projectSettingsPaths(projectDir)[0];
  const label = global ? '~/.claude/settings.json' : '.claude/settings.local.json';
  const scope = global ? 'in all projects' : 'in this project';
  const fallback = `${PLUGIN_NAME}:orchestrator (plugin default)`;
  const override = global ? projectOverride(projectDir) : null;
  const overrideNote = override
    ? ` Note: this project sets "agent": "${override.agent}" in ${override.file}, which wins here; ` +
      'delete that key to use the global default.'
    : '';
  try {
    if (command.action === 'invalid') {
      return block(`Unknown agent "${command.arg}". ${AGENT_USAGE}`);
    }
    if (command.action === 'show') {
      const current = readAgent(file);
      const where = current ? `set in ${label}` : `not set in ${label}`;
      const bare = (current ?? `${PLUGIN_NAME}:orchestrator`).slice(PLUGIN_NAME.length + 1);
      return block(
        `Default agent for new sessions ${scope}: ${current ?? fallback} (${where}).${overrideNote}` +
          `${primaryPresetNote(bare, primaryAgents)}${configWarningNote(warnings)} ${AGENT_USAGE}`,
      );
    }
    const agent = command.action === 'reset' ? null : `${PLUGIN_NAME}:${command.agent}`;
    writeAgent(file, agent, global ? {} : store.readLegacyDefaults(projectDir));
    if (!global) store.forgetLegacyDefaults(projectDir);
    return block(
      `Default agent for new sessions ${scope} is now ${agent ?? fallback} (saved to ${label}). ` +
        'Start a new session (Cmd+N in the desktop app) to use it; pick its model and effort in ' +
        `the app as usual. This conversation keeps its current agent.${overrideNote}` +
        (command.action === 'set' ? primaryPresetNote(command.agent, primaryAgents) : '') +
        configWarningNote(warnings),
    );
  } catch (error) {
    return block(
      `Could not update ${label}: ${error?.message ?? error}. ` +
        `Set "agent": "${PLUGIN_NAME}:<name>" there by hand.`,
    );
  }
}

function onUserPrompt(input, deps) {
  const { store, limits } = deps;
  if (!isMainThread(input)) return null;
  const agentCommand = parseAgentCommand(input.prompt);
  if (agentCommand) return onAgentCommand(agentCommand, input, deps);
  const switched = detectModeSwitch(input.prompt);
  const { state } = store.withState(input.session_id, (s) => {
    // Drop a soft mode that belongs to a previous real agent, then record
    // the new switch against the agent running now.
    const cleared = clearStaleMode(s, input.agent_type);
    const switchedNow = switched ? applyModeSwitch(s, switched, input.agent_type) : false;
    return cleared || switchedNow ? undefined : false;
  });
  if (TASK_NOTIFICATION.test(input.prompt ?? '')) return null;

  const mode = effectiveMode(state, input.agent_type);
  if (!mode) return null;

  const parts = [];
  if (limits.phaseReminder && REMINDER_AGENTS.has(mode)) {
    parts.push(`<reminder>${PHASE_REMINDER_TEXT}</reminder>`);
  }
  const resumable = renderResumable(state, { cwd: input.cwd });
  if (resumable) parts.push(resumable);
  return context('UserPromptSubmit', parts.join('\n\n'));
}

function onPreAgent(input, { store, agents }) {
  if (isMainThread(input)) {
    const state = readMainState(input, store);
    const mode = effectiveMode(state, input.agent_type);
    const reason = mode && checkDelegation(mode, input.tool_input?.subagent_type);
    if (reason) return deny(reason);
  }
  const updatedInput = applyAgentConfig(input.tool_input, agents);
  if (!updatedInput) return null;
  const applied = ['model', 'effort']
    .filter((key) => updatedInput[key] !== input.tool_input[key])
    .map((key) => `${key}=${updatedInput[key]}`)
    .join(', ');
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: `claudekei.jsonc: ${applied} for ${input.tool_input.subagent_type}`,
      updatedInput,
    },
  };
}

// Subagent-only guard: @designer may write design specs but not source code.
function onPreFileEdit(input) {
  if (isMainThread(input)) return null;
  const reason = checkDesignerEdit(input.agent_type, input.tool_input);
  return reason ? deny(reason) : null;
}

function onPreSendMessage(input, { store }) {
  const toolInput = input.tool_input ?? {};
  const target = toolInput.to;
  if (typeof target !== 'string') return null;

  const state = store.readState(input.session_id);
  const child = findChild(state, target);
  if (child) {
    if (isMainThread(input)) {
      const mode = effectiveMode(readMainState(input, store), input.agent_type);
      const reason = mode && checkResume(mode, child);
      if (reason) return deny(reason);
    }
    if (child.alias !== target) return null; // already a raw agent id
    const updatedInput = { ...toolInput, to: child.agentId };
    if (toolInput.recipient === target) updatedInput.recipient = child.agentId;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: `Resolved session alias ${target} -> ${child.agentId}`,
        updatedInput,
      },
    };
  }

  if (isAliasLike(target, state)) {
    return deny(
      `Unknown or evicted session alias "${target}". Available aliases: ${renderAvailableAliases(state)}. ` +
        'Start a fresh child with the Agent tool instead.',
    );
  }
  return null;
}

function onPostAgent(input, { store, limits }) {
  if (!isMainThread(input)) return null;
  const response = input.tool_response ?? {};
  const agentId = response.agentId;
  if (typeof agentId !== 'string' || !agentId) return null;

  const agentType =
    input.tool_input?.subagent_type || response.agentType || 'general-purpose';
  const status = response.status === 'async_launched' ? 'running' : 'idle';
  const { result: child } = store.withState(input.session_id, (state) =>
    registerChild(
      state,
      { agentId, agentType, description: input.tool_input?.description, status },
      limits,
    ),
  );
  return context(
    'PostToolUse',
    `[claudekei] Child session registered as \`${child.alias}\` (${child.agentType}). ` +
      `To continue this same thread later, call SendMessage with to: "${child.alias}". ` +
      'For new or unrelated work, launch a fresh Agent call instead.',
  );
}

function onPostSendMessage(input, { store, limits }) {
  const response = input.tool_response ?? {};
  const agentId = response.resumedAgentId ?? input.tool_input?.to;
  if (typeof agentId !== 'string' || response.success === false) return null;
  store.withState(input.session_id, (state) =>
    touchChild(state, agentId, 'running', limits) ? undefined : false,
  );
  return null;
}

function onPostFileTool(input, { store, limits }) {
  if (!isMainThread(input)) {
    if (input.tool_name !== 'Read') return null;
    const file = input.tool_response?.file;
    if (!file?.filePath) return null;
    store.withState(input.session_id, (state) =>
      recordRead(state, input.agent_id, file.filePath, file.numLines, limits)
        ? undefined
        : false,
    );
    return null;
  }

  if (!limits.phaseReminder) return null;
  const state = readMainState(input, store);
  const mode = effectiveMode(state, input.agent_type);
  if (!mode || !NUDGE_AGENTS.has(mode)) return null;
  return context('PostToolUse', PHASE_REMINDER_TEXT);
}

function onSubagentStop(input, { store, limits }) {
  if (!input.agent_id) return null;
  store.withState(input.session_id, (state) =>
    touchChild(state, input.agent_id, 'idle', limits) ? undefined : false,
  );
  return null;
}

export function handle(input, deps) {
  if (!input?.session_id) return null;
  switch (input.hook_event_name) {
    case 'SessionStart':
      return onSessionStart(input, deps);
    case 'UserPromptSubmit':
      return onUserPrompt(input, deps);
    case 'PreToolUse':
      if (input.tool_name === 'Agent') return onPreAgent(input, deps);
      if (input.tool_name === 'SendMessage') return onPreSendMessage(input, deps);
      if (FILE_EDIT_TOOLS.has(input.tool_name)) return onPreFileEdit(input);
      return null;
    case 'PostToolUse':
      if (input.tool_name === 'Agent') return onPostAgent(input, deps);
      if (input.tool_name === 'SendMessage') return onPostSendMessage(input, deps);
      if (input.tool_name === 'Read' || input.tool_name === 'Write') {
        return onPostFileTool(input, deps);
      }
      return null;
    case 'SubagentStop':
      return onSubagentStop(input, deps);
    default:
      return null;
  }
}
