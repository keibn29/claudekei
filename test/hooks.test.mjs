// Drives hooks/claudekei.mjs as a subprocess with payload shapes captured from a
// real Claude Code session (v2.1.x), using an isolated CLAUDE_PLUGIN_DATA.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HOOK = fileURLToPath(new URL('../hooks/claudekei.mjs', import.meta.url));
const DATA = mkdtempSync(join(tmpdir(), 'claudekei-hooks-'));
after(() => rmSync(DATA, { recursive: true, force: true }));

let sessionCounter = 0;
const newSession = () => `sess-${process.pid}-${++sessionCounter}`;

// An empty HOME keeps the developer's own ~/.claude/claudekei.jsonc out of tests.
const EMPTY_HOME = join(DATA, 'empty-home');

function run(payload, env = {}) {
  const result = spawnSync('node', [HOOK], {
    input: JSON.stringify(payload),
    env: { ...process.env, HOME: EMPTY_HOME, CLAUDE_PLUGIN_DATA: DATA, ...env },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout ? JSON.parse(result.stdout) : null;
}

const base = (session, extra = {}) => ({
  session_id: session,
  cwd: '/repo',
  agent_type: 'claudekei:orchestrator',
  ...extra,
});

function launch(session, agentId, subagentType, status = 'completed') {
  return run(
    base(session, {
      hook_event_name: 'PostToolUse',
      tool_name: 'Agent',
      tool_input: { description: `Task ${agentId}`, prompt: 'x', subagent_type: subagentType },
      tool_response: { status, agentId, agentType: subagentType },
    }),
  );
}

const state = (session) =>
  JSON.parse(readFileSync(join(DATA, 'sessions', `${session}.json`), 'utf8'));

test('PostToolUse Agent registers an alias and tells the model', () => {
  const s = newSession();
  const out = launch(s, 'ab4798b070eca6b7e', 'claudekei:explorer', 'async_launched');
  assert.match(out.hookSpecificOutput.additionalContext, /`exp-1`/);
  assert.equal(state(s).children[0].status, 'running');
});

test('PreToolUse SendMessage rewrites alias to agent id, keeping other fields', () => {
  const s = newSession();
  launch(s, 'ab4798b070eca6b7e', 'claudekei:explorer');
  const out = run(
    base(s, {
      hook_event_name: 'PreToolUse',
      tool_name: 'SendMessage',
      tool_input: {
        to: 'exp-1',
        summary: 'Follow up',
        message: 'what next?',
        recipient: 'exp-1',
        content: 'what next?',
      },
    }),
  );
  const hso = out.hookSpecificOutput;
  assert.equal(hso.permissionDecision, 'allow');
  assert.deepEqual(hso.updatedInput, {
    to: 'ab4798b070eca6b7e',
    summary: 'Follow up',
    message: 'what next?',
    recipient: 'ab4798b070eca6b7e',
    content: 'what next?',
  });
});

test('PreToolUse SendMessage denies unknown aliases and passes raw ids through', () => {
  const s = newSession();
  launch(s, 'a1', 'claudekei:oracle');
  const denied = run(
    base(s, {
      hook_event_name: 'PreToolUse',
      tool_name: 'SendMessage',
      tool_input: { to: 'exp-9', message: 'hi' },
    }),
  );
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /ora-1/);

  const raw = run(
    base(s, {
      hook_event_name: 'PreToolUse',
      tool_name: 'SendMessage',
      tool_input: { to: 'a1', message: 'hi' },
    }),
  );
  assert.equal(raw, null);
});

const sendMessage = (session, agentType, to, extra = {}) =>
  base(session, {
    agent_type: agentType,
    hook_event_name: 'PreToolUse',
    tool_name: 'SendMessage',
    tool_input: { to, message: 'hi' },
    ...extra,
  });

test('sprinter cannot delegate: real agent and soft /sprint mode deny Agent', () => {
  const real = run(agentCall(newSession(), 'claudekei:sprinter', 'claudekei:explorer'));
  assert.equal(real.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(real.hookSpecificOutput.permissionDecisionReason, /^sprinter cannot delegate/);

  const s = newSession();
  run(prompt(s, 'claudekei:orchestrator', '/claudekei:sprint go'));
  const soft = run(agentCall(s, 'claudekei:orchestrator', 'claudekei:explorer'));
  assert.equal(soft.hookSpecificOutput.permissionDecision, 'deny');
  // Subagent-originated calls are not main-thread and stay unaffected.
  assert.equal(run({ ...agentCall(s, 'claudekei:orchestrator'), agent_id: 'sub1' }), null);
});

test('sprinter cannot resume known children via SendMessage; unknown targets pass', () => {
  const s = newSession();
  launch(s, 'ab4798b070eca6b7e', 'claudekei:explorer');
  for (const to of ['exp-1', 'ab4798b070eca6b7e']) {
    const denied = run(sendMessage(s, 'claudekei:sprinter', to));
    assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(denied.hookSpecificOutput.permissionDecisionReason, /^sprinter cannot delegate/);
  }
  assert.equal(run(sendMessage(s, 'claudekei:sprinter', 'teammate-lead')), null);

  // Soft sprint mode on an orchestrator session behaves the same.
  const t = newSession();
  launch(t, 'a1', 'claudekei:oracle');
  run(prompt(t, 'claudekei:orchestrator', '/claudekei:sprint go'));
  const soft = run(sendMessage(t, 'claudekei:orchestrator', 'ora-1'));
  assert.equal(soft.hookSpecificOutput.permissionDecision, 'deny');

  // Orchestrator still resumes children normally.
  const u = newSession();
  launch(u, 'a2', 'claudekei:oracle');
  assert.equal(run(sendMessage(u, 'claudekei:orchestrator', 'ora-1')).hookSpecificOutput.permissionDecision, 'allow');
});

test('SubagentStop settles a child; SendMessage marks it running again', () => {
  const s = newSession();
  launch(s, 'a1', 'claudekei:explorer', 'async_launched');
  run({ session_id: s, hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'claudekei:explorer' });
  assert.equal(state(s).children[0].status, 'idle');
  run(
    base(s, {
      hook_event_name: 'PostToolUse',
      tool_name: 'SendMessage',
      tool_input: { to: 'a1', message: 'more' },
      tool_response: { success: true, resumedAgentId: 'a1' },
    }),
  );
  assert.equal(state(s).children[0].status, 'running');
});

test('subagent Read calls feed read context into the resumable list', () => {
  const s = newSession();
  launch(s, 'a1', 'claudekei:explorer');
  run({
    session_id: s,
    hook_event_name: 'PostToolUse',
    tool_name: 'Read',
    agent_id: 'a1',
    agent_type: 'claudekei:explorer',
    tool_input: { file_path: '/repo/src/app.ts' },
    tool_response: { type: 'text', file: { filePath: '/repo/src/app.ts', numLines: 42 } },
  });
  const out = run(base(s, { hook_event_name: 'UserPromptSubmit', prompt: 'continue' }));
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /<reminder>/);
  assert.match(ctx, /- explorer: exp-1 Task a1/);
  assert.match(ctx, /Context read by exp-1: src\/app\.ts \(42 lines\)/);
});

test('UserPromptSubmit is silent outside claudekei primary agents and for task notifications', () => {
  const s = newSession();
  assert.equal(
    run({ session_id: s, hook_event_name: 'UserPromptSubmit', prompt: 'hello' }),
    null,
  );
  assert.equal(
    run(base(s, { hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>\n<task-id>x</task-id>' })),
    null,
  );
});

test('mode switch via /claudekei:plan enables planner delegation rules', () => {
  const s = newSession();
  run({ session_id: s, hook_event_name: 'UserPromptSubmit', prompt: '/claudekei:plan add billing' });
  const denied = run({
    session_id: s,
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'claudekei:backend-developer', prompt: 'x', description: 'y' },
  });
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  const allowed = run({
    session_id: s,
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'claudekei:explorer', prompt: 'x', description: 'y' },
  });
  assert.equal(allowed, null);
});

const agentCall = (session, agentType, subagent = 'claudekei:backend-developer') => ({
  session_id: session,
  agent_type: agentType,
  hook_event_name: 'PreToolUse',
  tool_name: 'Agent',
  tool_input: { subagent_type: subagent, prompt: 'x', description: 'y' },
});
const prompt = (session, agentType, text) => ({
  session_id: session,
  agent_type: agentType,
  hook_event_name: 'UserPromptSubmit',
  prompt: text,
});

test('soft switch then real agent change: the real agent wins and the stale mode is cleared', () => {
  const s = newSession();
  run(prompt(s, 'claudekei:orchestrator', '/claudekei:sprint go'));
  assert.deepEqual([state(s).mode, state(s).modeBaseAgentType], ['sprinter', 'orchestrator']);
  // Same process: soft mode (sprinter) still applies, so delegation is denied.
  const soft = run(agentCall(s, 'claudekei:orchestrator'));
  assert.equal(soft.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(soft.hookSpecificOutput.permissionDecisionReason, /^sprinter cannot delegate/);
  // Resumed as planner: planner delegation rules apply.
  const denied = run(agentCall(s, 'claudekei:planner'));
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /^planner may only/);
  assert.equal(state(s).mode, null);
  // Stays planner even if the payload later looks like the old base again.
  assert.equal(run(agentCall(s, 'claudekei:orchestrator')), null);
});

test('soft switch with the same agent keeps the soft mode', () => {
  const s = newSession();
  run(prompt(s, 'claudekei:orchestrator', '/claudekei:plan go'));
  for (let i = 0; i < 2; i++) {
    const denied = run(agentCall(s, 'claudekei:orchestrator'));
    assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  }
  assert.equal(state(s).mode, 'planner');
});

test('a prompt under a new real agent clears the stale mode before applying a new switch', () => {
  const s = newSession();
  run(prompt(s, 'claudekei:orchestrator', '/claudekei:plan go'));
  run(prompt(s, 'claudekei:sprinter', 'hello'));
  assert.equal(state(s).mode, null);
  run(prompt(s, 'claudekei:sprinter', '/claudekei:analyze x'));
  assert.deepEqual([state(s).mode, state(s).modeBaseAgentType], ['business-analyst', 'sprinter']);
});

test('SessionStart resume clears a stale mode and re-advertises under the real agent', () => {
  const s = newSession();
  launch(s, 'ab4798b070eca6b7e', 'claudekei:explorer');
  run(prompt(s, 'claudekei:orchestrator', '/claudekei:plan go'));
  const out = run({
    session_id: s,
    agent_type: 'claudekei:sprinter',
    source: 'resume',
    hook_event_name: 'SessionStart',
    cwd: '/repo',
  });
  assert.match(out.hookSpecificOutput.additionalContext, /exp-1/);
  assert.equal(state(s).mode, null);
});

test('legacy state file without modeBaseAgentType', () => {
  const dir = join(DATA, 'sessions');
  mkdirSync(dir, { recursive: true });
  const legacy = (id) =>
    writeFileSync(
      join(dir, `${id}.json`),
      JSON.stringify({ version: 1, mode: 'planner', counters: {}, children: [] }),
    );
  // Real agent differs from the legacy soft mode: dropped.
  const a = newSession();
  legacy(a);
  assert.equal(run(agentCall(a, 'claudekei:orchestrator')), null);
  assert.equal(state(a).mode, null);
  // Real agent equals the soft mode, or none is reported: kept.
  const b = newSession();
  legacy(b);
  assert.equal(run(agentCall(b, 'claudekei:planner')).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(state(b).mode, 'planner');
  const c = newSession();
  legacy(c);
  assert.equal(run({ ...agentCall(c, undefined) }).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(state(c).mode, 'planner');
});

test('subagent threads never clear the soft mode', () => {
  const s = newSession();
  run(prompt(s, 'claudekei:orchestrator', '/claudekei:plan go'));
  run({ ...agentCall(s, 'claudekei:sprinter'), agent_id: 'sub1' });
  assert.equal(state(s).mode, 'planner');
});

test('post-file nudge only for orchestrator/planner main thread', () => {
  const s = newSession();
  const nudge = run(base(s, { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_response: {} }));
  assert.match(nudge.hookSpecificOutput.additionalContext, /Recall the workflow rules/);
  const none = run(
    base(s, {
      agent_type: 'claudekei:sprinter',
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_response: {},
    }),
  );
  assert.equal(none, null);
  const off = run(
    base(s, { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_response: {} }),
    { KEI_PHASE_REMINDER: '0' },
  );
  assert.equal(off, null);
});

test('SessionStart re-advertises aliases after compaction and clears on /clear', () => {
  const s = newSession();
  launch(s, 'a1', 'claudekei:oracle');
  const resumed = run(base(s, { hook_event_name: 'SessionStart', source: 'compact' }));
  assert.match(resumed.hookSpecificOutput.additionalContext, /ora-1/);
  run(base(s, { hook_event_name: 'SessionStart', source: 'clear' }));
  const after = run(base(s, { hook_event_name: 'UserPromptSubmit', prompt: 'hi' }));
  assert.doesNotMatch(after.hookSpecificOutput.additionalContext, /ora-1/);
});

test('parallel PostToolUse hooks do not lose registrations', async () => {
  const s = newSession();
  const { spawn } = await import('node:child_process');
  const runAsync = (payload) =>
    new Promise((resolve, reject) => {
      const child = spawn('node', [HOOK], {
        env: { ...process.env, CLAUDE_PLUGIN_DATA: DATA },
      });
      child.on('error', reject);
      child.on('exit', resolve);
      child.stdin.end(JSON.stringify(payload));
    });
  await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      runAsync(
        base(s, {
          hook_event_name: 'PostToolUse',
          tool_name: 'Agent',
          tool_input: { description: `p${i}`, subagent_type: 'claudekei:backend-developer' },
          tool_response: { status: 'async_launched', agentId: `p${i}` },
        }),
      ),
    ),
  );
  const aliases = state(s).children.map((c) => c.alias).sort();
  assert.deepEqual(aliases, ['bed-1', 'bed-2', 'bed-3', 'bed-4', 'bed-5', 'bed-6']);
});

test('malformed input never fails the hook', () => {
  const result = spawnSync('node', [HOOK], { input: '{not json', encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('/claudekei:agent writes settings.local.json, keeps other keys, and blocks the prompt', () => {
  const project = join(DATA, 'project');
  mkdirSync(join(project, '.claude'), { recursive: true });
  const file = join(project, '.claude', 'settings.local.json');
  writeFileSync(file, JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }));
  const env = { CLAUDE_PROJECT_DIR: project };
  const prompt = (text) =>
    run(base(newSession(), { hook_event_name: 'UserPromptSubmit', prompt: text }), env);

  const set = prompt('/claudekei:agent plan');
  assert.equal(set.decision, 'block');
  assert.match(set.reason, /claudekei:planner/);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
    permissions: { allow: ['Bash(ls)'] },
    agent: 'claudekei:planner',
  });

  assert.match(prompt('/claudekei:agent').reason, /claudekei:planner \(set in/);
  assert.match(prompt('/claudekei:agent oracle').reason, /Unknown agent "oracle"/);

  prompt('/claudekei:agent reset');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { permissions: { allow: ['Bash(ls)'] } });
});

test('/claudekei:agent mentions the primaryAgents model/effort configured for the agent', () => {
  const home = join(DATA, 'pa-home');
  const project = join(DATA, 'pa-project');
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(project, '.claude'), { recursive: true });
  writeFileSync(
    join(home, '.claude', 'claudekei.jsonc'),
    '{ "primaryAgents": { "planner": { "model": "opus", "effort": "high" }, "sprinter": { "model": "bad model" } } }',
  );
  const env = { HOME: home, CLAUDE_PROJECT_DIR: project };
  const prompt = (text) =>
    run(base(newSession(), { hook_event_name: 'UserPromptSubmit', prompt: text }), env);

  const set = prompt('/claudekei:agent plan');
  assert.match(set.reason, /primaryAgents\.planner: model opus, effort high/);
  assert.match(prompt('/claudekei:agent').reason, /primaryAgents\.planner: model opus, effort high/);
  assert.doesNotMatch(prompt('/claudekei:agent sprinter').reason, /primaryAgents\.[\w-]+: /);
  assert.doesNotMatch(prompt('/claudekei:agent reset').reason, /primaryAgents\.[\w-]+: /);
});

test('/claudekei:agent appends claudekei.jsonc warnings to its reply', () => {
  const home = join(DATA, 'warn-home');
  const project = join(DATA, 'warn-project');
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(project, '.claude'), { recursive: true });
  writeFileSync(
    join(home, '.claude', 'claudekei.jsonc'),
    '{ "presets": { "oracle": { "effort": "turbo" } }, "primaryAgents": { "ghost": {}, "planner": { "model": "a b" } } }',
  );
  const env = { HOME: home, CLAUDE_PROJECT_DIR: project };
  const prompt = (text) =>
    run(base(newSession(), { hook_event_name: 'UserPromptSubmit', prompt: text }), env);

  for (const text of ['/claudekei:agent plan', '/claudekei:agent', '/claudekei:agent reset']) {
    const { reason } = prompt(text);
    assert.match(reason, /Ignored in claudekei\.jsonc: .*presets\.oracle\.effort "turbo" ignored/, text);
    assert.match(reason, /`presets` is deprecated, rename to `subAgents`/, text);
    assert.match(reason, /primaryAgents\.ghost is not a primary agent/, text);
    assert.match(reason, /primaryAgents\.planner\.model "a b" ignored/, text);
  }
});

test('/claudekei:agent never overwrites an unreadable settings file', () => {
  const project = join(DATA, 'broken');
  mkdirSync(join(project, '.claude'), { recursive: true });
  const file = join(project, '.claude', 'settings.local.json');
  writeFileSync(file, '{ not json');
  const out = run(
    base(newSession(), { hook_event_name: 'UserPromptSubmit', prompt: '/claudekei:agent sprinter' }),
    { CLAUDE_PROJECT_DIR: project },
  );
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /Could not update/);
  assert.equal(readFileSync(file, 'utf8'), '{ not json');
});

test('PreToolUse Agent applies claudekei.jsonc model/effort, delegation rules still first', () => {
  const home = join(DATA, 'cfg-home');
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(
    join(home, '.claude', 'claudekei.jsonc'),
    '{ "subAgents": { "explorer": { "model": "sonnet", "effort": "low" }, "backend-developer": { "model": "opus" } } }',
  );
  const env = { HOME: home, CLAUDE_PROJECT_DIR: join(DATA, 'cfg-project') };
  const s = newSession();
  const call = (subagentType, extra = {}) =>
    run(
      base(s, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Agent',
        tool_input: { subagent_type: subagentType, prompt: 'x', description: 'y', ...extra },
      }),
      env,
    );

  const out = call('claudekei:explorer');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(out.hookSpecificOutput.updatedInput.model, 'sonnet');
  assert.equal(out.hookSpecificOutput.updatedInput.effort, 'low');
  assert.equal(out.hookSpecificOutput.updatedInput.prompt, 'x');
  assert.equal(call('claudekei:designer'), null);

  run(base(s, { hook_event_name: 'UserPromptSubmit', prompt: '/claudekei:plan x' }), env);
  assert.equal(call('claudekei:backend-developer').hookSpecificOutput.permissionDecision, 'deny');
});

test('/claudekei:agent only sets agent and removes unchanged model/effort left by v0.4.0', () => {
  const data = join(DATA, 'legacy-data');
  const project = join(DATA, 'legacy-project');
  mkdirSync(join(project, '.claude'), { recursive: true });
  mkdirSync(data, { recursive: true });
  const file = join(project, '.claude', 'settings.local.json');
  writeFileSync(file, JSON.stringify({ model: 'opus', effortLevel: 'sonnet-hand-set', other: 1 }));
  writeFileSync(
    join(data, 'project-defaults.json'),
    JSON.stringify({ [project]: { model: 'opus', effortLevel: 'xhigh' } }),
  );
  const env = { CLAUDE_PLUGIN_DATA: data, CLAUDE_PROJECT_DIR: project };
  const out = run(
    base(newSession(), { hook_event_name: 'UserPromptSubmit', prompt: '/claudekei:agent planner' }),
    env,
  );
  assert.match(out.reason, /now claudekei:planner/);
  // model matched what v0.4.0 wrote -> removed; effortLevel was changed by hand -> kept.
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
    effortLevel: 'sonnet-hand-set',
    other: 1,
    agent: 'claudekei:planner',
  });
  assert.deepEqual(JSON.parse(readFileSync(join(data, 'project-defaults.json'), 'utf8')), {});
});

test('"agentScope": "global" makes /claudekei:agent use ~/.claude/settings.json and never touch the project', () => {
  const home = join(DATA, 'global-home');
  const project = join(DATA, 'global-project');
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(home, '.claude', 'claudekei.jsonc'), '{ "agentScope": "global" }');
  const userSettings = join(home, '.claude', 'settings.json');
  writeFileSync(userSettings, JSON.stringify({ theme: 'dark', enabledPlugins: { 'claudekei@claudekei': true } }));
  const env = { HOME: home, CLAUDE_PROJECT_DIR: project };
  const prompt = (text) =>
    run(base(newSession(), { hook_event_name: 'UserPromptSubmit', prompt: text }), env);

  const set = prompt('/claudekei:agent sprinter');
  assert.match(set.reason, /in all projects is now claudekei:sprinter \(saved to ~\/\.claude\/settings\.json\)/);
  assert.deepEqual(JSON.parse(readFileSync(userSettings, 'utf8')), {
    theme: 'dark',
    enabledPlugins: { 'claudekei@claudekei': true },
    agent: 'claudekei:sprinter',
  });
  assert.equal(existsSync(join(project, '.claude')), false);

  // A project-level agent still wins; the message says so.
  mkdirSync(join(project, '.claude'));
  writeFileSync(join(project, '.claude', 'settings.local.json'), '{ "agent": "claudekei:planner" }');
  assert.match(prompt('/claudekei:agent').reason, /claudekei:sprinter \(set in ~\/\.claude\/settings\.json\)\. Note: this project sets "agent": "claudekei:planner"/);

  prompt('/claudekei:agent reset');
  assert.deepEqual(JSON.parse(readFileSync(userSettings, 'utf8')), {
    theme: 'dark',
    enabledPlugins: { 'claudekei@claudekei': true },
  });
  assert.equal(readFileSync(join(project, '.claude', 'settings.local.json'), 'utf8'), '{ "agent": "claudekei:planner" }');
});

test('PreToolUse file edits: @designer may only write design specs', () => {
  const s = newSession();
  const edit = (agentType, toolName, toolInput, agentId = 'a1') =>
    run({
      session_id: s,
      cwd: '/repo',
      hook_event_name: 'PreToolUse',
      tool_name: toolName,
      tool_input: toolInput,
      ...(agentType ? { agent_id: agentId, agent_type: agentType } : { agent_type: 'claudekei:orchestrator' }),
    });

  const denied = edit('claudekei:designer', 'Edit', {
    file_path: '/repo/src/App.tsx',
    old_string: 'a',
    new_string: 'b',
  });
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /decision-only.*src\/App\.tsx/);
  assert.equal(edit('designer', 'Write', { file_path: '/repo/a.css', content: '' }).hookSpecificOutput.permissionDecision, 'deny');

  assert.equal(edit('claudekei:designer', 'Write', { file_path: '/repo/.designer/spec.md', content: 'x' }), null);
  assert.equal(edit('claudekei:designer', 'Write', { file_path: '/repo/.designer/tokens.json', content: 'x' }), null);
  assert.equal(edit('claudekei:designer', 'Write', { file_path: '/repo/docs/x.md', content: 'x' }), null);
  assert.equal(edit('claudekei:designer', 'Write', { file_path: '/repo/docs/x.mdx', content: 'x' }), null);

  const notebook = edit('claudekei:designer', 'NotebookEdit', { notebook_path: '/repo/a.ipynb', new_source: 'x' });
  assert.equal(notebook.hookSpecificOutput.permissionDecision, 'deny');

  // Fail open on odd shapes, and never touch other agents or the main thread.
  assert.equal(edit('claudekei:designer', 'Edit', {}), null);
  assert.equal(edit('claudekei:designer', 'Edit', undefined), null);
  assert.equal(edit('claudekei:frontend-developer', 'Edit', { file_path: '/repo/src/App.tsx' }), null);
  assert.equal(edit(null, 'Edit', { file_path: '/repo/src/App.tsx' }), null);
});
