import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  aliasPrefix,
  checkDelegation,
  createState,
  detectModeSwitch,
  applyModeSwitch,
  clearStaleMode,
  effectiveMode,
  isAliasLike,
  parseAgentCommand,
  recordRead,
  registerChild,
  renderResumable,
  shortType,
  touchChild,
} from '../hooks/lib/sessions.mjs';

const limits = {
  maxSessionsPerAgent: 2,
  readContextMinLines: 10,
  readContextMaxFiles: 2,
  phaseReminder: true,
};

test('shortType strips the plugin namespace', () => {
  assert.equal(shortType('claudekei:explorer'), 'explorer');
  assert.equal(shortType('general-purpose'), 'general-purpose');
  assert.equal(shortType(undefined), '');
});

test('aliasPrefix uses known prefixes and falls back to 3 letters', () => {
  assert.equal(aliasPrefix('claudekei:frontend-developer'), 'fed');
  assert.equal(aliasPrefix('claudekei:oracle'), 'ora');
  assert.equal(aliasPrefix('my-plugin:reviewer'), 'rev');
});

test('registerChild assigns incrementing aliases per prefix', () => {
  const state = createState();
  const a = registerChild(state, { agentId: 'a1', agentType: 'claudekei:explorer', status: 'idle' }, limits, 1);
  const b = registerChild(state, { agentId: 'a2', agentType: 'claudekei:explorer', status: 'idle' }, limits, 2);
  const c = registerChild(state, { agentId: 'a3', agentType: 'claudekei:oracle', status: 'idle' }, limits, 3);
  assert.deepEqual([a.alias, b.alias, c.alias], ['exp-1', 'exp-2', 'ora-1']);
});

test('re-registering an agent id refreshes instead of duplicating', () => {
  const state = createState();
  registerChild(state, { agentId: 'a1', agentType: 'claudekei:explorer', status: 'running' }, limits, 1);
  const again = registerChild(state, { agentId: 'a1', agentType: 'claudekei:explorer', status: 'idle' }, limits, 5);
  assert.equal(state.children.length, 1);
  assert.equal(again.alias, 'exp-1');
  assert.equal(again.status, 'idle');
});

test('settled history is capped per type, oldest evicted first', () => {
  const state = createState();
  for (let i = 1; i <= 3; i++) {
    registerChild(state, { agentId: `a${i}`, agentType: 'claudekei:explorer', status: 'idle' }, limits, i);
  }
  assert.deepEqual(state.children.map((c) => c.alias), ['exp-2', 'exp-3']);
  // Counters never reuse an evicted alias.
  const next = registerChild(state, { agentId: 'a4', agentType: 'claudekei:explorer', status: 'idle' }, limits, 4);
  assert.equal(next.alias, 'exp-4');
});

test('running children are protected from eviction', () => {
  const state = createState();
  registerChild(state, { agentId: 'r1', agentType: 'claudekei:explorer', status: 'running' }, limits, 1);
  registerChild(state, { agentId: 'r2', agentType: 'claudekei:explorer', status: 'running' }, limits, 2);
  registerChild(state, { agentId: 'r3', agentType: 'claudekei:explorer', status: 'running' }, limits, 3);
  assert.equal(state.children.length, 3);
  touchChild(state, 'r1', 'idle', limits, 4);
  touchChild(state, 'r2', 'idle', limits, 5);
  touchChild(state, 'r3', 'idle', limits, 6);
  assert.deepEqual(state.children.map((c) => c.agentId), ['r2', 'r3']);
});

test('recordRead respects min lines, dedupes, and caps files', () => {
  const state = createState();
  registerChild(state, { agentId: 'a1', agentType: 'claudekei:explorer', status: 'running' }, limits, 1);
  assert.equal(recordRead(state, 'a1', '/r/small.ts', 3, limits), false);
  recordRead(state, 'a1', '/r/a.ts', 20, limits);
  recordRead(state, 'a1', '/r/b.ts', 30, limits);
  recordRead(state, 'a1', '/r/a.ts', 25, limits);
  recordRead(state, 'a1', '/r/c.ts', 40, limits);
  assert.deepEqual(state.children[0].reads, [
    { path: '/r/a.ts', lines: 25 },
    { path: '/r/c.ts', lines: 40 },
  ]);
  assert.equal(recordRead(state, 'unknown', '/r/a.ts', 99, limits), false);
});

test('renderResumable lists most recent first with read context', () => {
  const state = createState();
  registerChild(state, { agentId: 'a1', agentType: 'claudekei:explorer', description: 'Search routes', status: 'idle' }, limits, 1);
  registerChild(state, { agentId: 'a2', agentType: 'claudekei:oracle', description: 'Review auth', status: 'running' }, limits, 2);
  recordRead(state, 'a1', '/repo/src/router.ts', 120, limits);
  const text = renderResumable(state, { cwd: '/repo' });
  assert.match(text, /### Resumable Sessions/);
  assert.ok(text.indexOf('ora-1') < text.indexOf('exp-1'));
  assert.match(text, /- oracle: ora-1 \(running\) Review auth/);
  assert.match(text, /Context read by exp-1: src\/router\.ts \(120 lines\)/);
  assert.equal(renderResumable(createState()), '');
});

test('isAliasLike only matches known prefixes', () => {
  const state = createState();
  assert.equal(isAliasLike('exp-9', state), true);
  assert.equal(isAliasLike('worker-1', state), false);
  assert.equal(isAliasLike('a4fbfe340d0524859', state), false);
  state.counters.rev = 1;
  assert.equal(isAliasLike('rev-3', state), true);
});

test('checkDelegation enforces planner and business-analyst sets', () => {
  assert.equal(checkDelegation('orchestrator', 'claudekei:backend-developer'), null);
  assert.equal(checkDelegation('planner', 'claudekei:explorer'), null);
  assert.match(checkDelegation('planner', 'claudekei:backend-developer'), /may only delegate/);
  assert.match(checkDelegation('business-analyst', 'claudekei:designer'), /may only delegate/);
  assert.match(checkDelegation('sprinter', 'claudekei:oracle'), /^sprinter cannot delegate/);
});

test('detectModeSwitch recognises claudekei mode commands only', () => {
  assert.equal(detectModeSwitch('/claudekei:plan add auth'), 'planner');
  assert.equal(detectModeSwitch('  /sprint'), 'sprinter');
  assert.equal(detectModeSwitch('/claudekei:analyze market'), 'business-analyst');
  assert.equal(detectModeSwitch('/claudekei:orchestrate'), 'orchestrator');
  // Bare /plan is Claude Code's built-in plan mode.
  assert.equal(detectModeSwitch('/plan'), null);
  assert.equal(detectModeSwitch('please /claudekei:plan'), null);
  assert.equal(detectModeSwitch('/claudekei:planx'), null);
});

test('effectiveMode prefers explicit mode, then claudekei main-thread agent', () => {
  const state = createState();
  assert.equal(effectiveMode(state, 'claudekei:orchestrator'), 'orchestrator');
  assert.equal(effectiveMode(state, 'orchestrator'), 'orchestrator');
  assert.equal(effectiveMode(state, 'other:planner'), null);
  assert.equal(effectiveMode(state, undefined), null);
  state.mode = 'planner';
  state.modeBaseAgentType = 'orchestrator';
  assert.equal(effectiveMode(state, 'claudekei:orchestrator'), 'planner');
});

test('soft mode set under another real agent is stale: the real agent wins', () => {
  const state = createState();
  applyModeSwitch(state, 'sprinter', 'claudekei:orchestrator');
  assert.deepEqual([state.mode, state.modeBaseAgentType], ['sprinter', 'orchestrator']);
  assert.equal(effectiveMode(state, 'claudekei:orchestrator'), 'sprinter');
  // Resumed as a different primary agent.
  assert.equal(effectiveMode(state, 'claudekei:planner'), 'planner');
  assert.equal(clearStaleMode(state, 'claudekei:planner'), true);
  assert.deepEqual([state.mode, state.modeBaseAgentType], [null, null]);
  assert.equal(clearStaleMode(state, 'claudekei:planner'), false);
});

test('soft mode without a payload agent_type, or with a foreign one, is kept', () => {
  const state = createState();
  applyModeSwitch(state, 'sprinter', undefined);
  assert.equal(state.modeBaseAgentType, null);
  assert.equal(effectiveMode(state, undefined), 'sprinter');
  assert.equal(effectiveMode(state, 'other:planner'), 'sprinter');
  // A real primary agent appearing later differs from "no agent": it wins.
  assert.equal(effectiveMode(state, 'claudekei:planner'), 'planner');
});

test('legacy state without modeBaseAgentType: kept only when the real agent equals the mode', () => {
  const legacy = () => ({ version: 1, mode: 'sprinter', counters: {}, children: [] });
  assert.equal(effectiveMode(legacy(), 'claudekei:sprinter'), 'sprinter');
  assert.equal(effectiveMode(legacy(), 'claudekei:planner'), 'planner');
  assert.equal(effectiveMode(legacy(), undefined), 'sprinter');
  const state = legacy();
  assert.equal(clearStaleMode(state, 'claudekei:planner'), true);
  assert.equal(state.mode, null);
});

test('parseAgentCommand maps names and mode aliases', () => {
  assert.equal(parseAgentCommand('/claudekei:plan x'), null);
  assert.equal(parseAgentCommand('please /claudekei:agent planner'), null);
  assert.deepEqual(parseAgentCommand('/claudekei:agent'), { action: 'show' });
  assert.deepEqual(parseAgentCommand(' /claudekei:agent planner '), { action: 'set', agent: 'planner' });
  assert.deepEqual(parseAgentCommand('/claudekei:agent sprint'), { action: 'set', agent: 'sprinter' });
  assert.deepEqual(parseAgentCommand('/claudekei:agent claudekei:business-analyst'), {
    action: 'set',
    agent: 'business-analyst',
  });
  assert.deepEqual(parseAgentCommand('/claudekei:agent reset'), { action: 'reset' });
  assert.deepEqual(parseAgentCommand('/claudekei:agent oracle'), { action: 'invalid', arg: 'oracle' });
  assert.equal(parseAgentCommand('/claudekei:agent planner now'), null);
});
