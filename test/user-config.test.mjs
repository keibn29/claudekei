import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { EFFORT_LEVELS, loadLimits, PRIMARY_AGENTS } from '../hooks/lib/config.mjs';
import { applyAgentConfig } from '../hooks/lib/sessions.mjs';
import { getPrimaryAgentPreset, loadUserConfig, parseJsonc } from '../hooks/lib/user-config.mjs';

const ROOT = mkdtempSync(join(tmpdir(), 'claudekei-config-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

function writeConfig(dir, name, text) {
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude', name), text);
}

test('parseJsonc strips comments and trailing commas but not string contents', () => {
  const parsed = parseJsonc(`{
    // line comment
    "url": "https://x.dev/a//b", /* block */
    "odd": "keep ,} and // here",
    "list": [1, 2,],
  }`);
  assert.deepEqual(parsed, { url: 'https://x.dev/a//b', odd: 'keep ,} and // here', list: [1, 2] });
});

test('loadUserConfig reads the subAgents map with project overrides per field', () => {
  const home = join(ROOT, 'home');
  const project = join(ROOT, 'project');
  writeConfig(home, 'claudekei.jsonc', `{
    "subAgents": {
      "oracle": { "model": "opus", "effort": "xhigh" },
      "explorer": { "model": "haiku" },
      "debugger": { "model": "Sonnet", "effort": "HIGH" },
      "librarian": { "model": "openai/gpt-5" }, // not a Claude alias: ignored
    },
    "sessionManager": { "maxSessionsPerAgent": 3 },
  }`);
  writeConfig(project, 'claudekei.json', '{ "subAgents": { "oracle": { "model": "fable" } } }');

  const config = loadUserConfig(project, home);
  assert.deepEqual(config.agents.oracle, { model: 'fable', effort: 'xhigh' });
  assert.deepEqual(config.agents.explorer, { model: 'haiku' });
  assert.deepEqual(config.agents.debugger, { model: 'sonnet', effort: 'high' });
  assert.deepEqual(config.agents.librarian, {});
  assert.equal(loadLimits(config.sessionManager).maxSessionsPerAgent, 3);
});

test('loadUserConfig ignores the removed preset/agents keys', () => {
  const home = join(ROOT, 'legacy-home');
  writeConfig(home, 'claudekei.jsonc', `{
    "preset": "default",
    "agents": { "oracle": { "model": "haiku" } },
  }`);
  assert.deepEqual(loadUserConfig(join(ROOT, 'missing'), home).agents, {});
});

test('loadUserConfig ignores missing or broken files', () => {
  const home = join(ROOT, 'broken-home');
  writeConfig(home, 'claudekei.jsonc', '{ nope');
  assert.deepEqual(loadUserConfig(join(ROOT, 'missing'), home), {
    agents: {},
    primaryAgents: {},
    agentScope: 'project',
    sessionManager: {},
    warnings: [],
  });
});

test('applyAgentConfig fills model/effort for claudekei agents only, explicit values win', () => {
  const agents = { oracle: { model: 'opus', effort: 'max' }, explorer: { model: 'haiku' } };
  assert.deepEqual(applyAgentConfig({ subagent_type: 'claudekei:oracle', prompt: 'p' }, agents), {
    subagent_type: 'claudekei:oracle',
    prompt: 'p',
    model: 'opus',
    effort: 'max',
  });
  assert.deepEqual(
    applyAgentConfig({ subagent_type: 'claudekei:oracle', model: 'sonnet' }, agents),
    { subagent_type: 'claudekei:oracle', model: 'sonnet', effort: 'max' },
  );
  assert.equal(applyAgentConfig({ subagent_type: 'claudekei:explorer', model: 'haiku' }, agents), null);
  assert.equal(applyAgentConfig({ subagent_type: 'other:oracle' }, agents), null);
  assert.equal(applyAgentConfig({ subagent_type: 'claudekei:designer' }, agents), null);
});

test('environment variables still override the config file', () => {
  process.env.KEI_MAX_SESSIONS_PER_AGENT = '5';
  process.env.KEI_PHASE_REMINDER = '0';
  try {
    const limits = loadLimits({ maxSessionsPerAgent: 3, phaseReminder: true });
    assert.equal(limits.maxSessionsPerAgent, 5);
    assert.equal(limits.phaseReminder, false);
  } finally {
    delete process.env.KEI_MAX_SESSIONS_PER_AGENT;
    delete process.env.KEI_PHASE_REMINDER;
  }
  assert.equal(loadLimits({ phaseReminder: false }).phaseReminder, false);
  assert.equal(loadLimits().maxSessionsPerAgent, 1);
});

test('claudekei.jsonc template lists every specialist with its agents/*.md defaults', () => {
  const repo = new URL('..', import.meta.url);
  const template = parseJsonc(readFileSync(new URL('claudekei.jsonc', repo), 'utf8'));
  const listed = template.subAgents;

  const frontmatter = (name) => {
    const text = readFileSync(new URL(`agents/${name}.md`, repo), 'utf8');
    const block = /^---\n([\s\S]*?)\n---/.exec(text)[1];
    const field = (key) => new RegExp(`^${key}:\\s*(\\S+)`, 'm').exec(block)?.[1];
    return { model: field('model'), effort: field('effort') };
  };
  const agents = readdirSync(new URL('agents/', repo))
    .map((file) => file.replace(/\.md$/, ''))
    .filter((name) => !PRIMARY_AGENTS.has(name))
    .sort();

  assert.deepEqual(Object.keys(listed).sort(), agents);
  for (const name of agents) {
    const { model, effort } = frontmatter(name);
    assert.equal(listed[name].model, model, `${name} model`);
    assert.equal(listed[name].effort, effort, `${name} effort`);
  }
  // The template deliberately recommends 3 remembered sessions (code default: 1).
  assert.deepEqual(loadLimits(template.sessionManager), { ...loadLimits(), maxSessionsPerAgent: 3 });
});

test('agentScope defaults to project; a valid project value wins over the user value', () => {
  const home = join(ROOT, 'scope-home');
  const project = join(ROOT, 'scope-project');
  writeConfig(home, 'claudekei.jsonc', '{ "agentScope": "global" }');
  assert.equal(loadUserConfig(join(ROOT, 'missing'), home).agentScope, 'global');
  writeConfig(project, 'claudekei.jsonc', '{ "agentScope": "project" }');
  assert.equal(loadUserConfig(project, home).agentScope, 'project');
  writeConfig(project, 'claudekei.jsonc', '{ "agentScope": "everywhere" }');
  assert.equal(loadUserConfig(project, home).agentScope, 'global');
  assert.equal(loadUserConfig(join(ROOT, 'missing'), join(ROOT, 'no-home')).agentScope, 'project');
});

test('primaryAgents merges per field with project winning, accepts model ids, warns on invalid entries', () => {
  const home = join(ROOT, 'pa-home');
  const project = join(ROOT, 'pa-project');
  writeConfig(home, 'claudekei.jsonc', `{
    "primaryAgents": {
      "orchestrator": { "model": "Opus", "effort": "HIGH" },
      "planner": { "model": "claude-opus-5-5" },
      "sprinter": { "model": "gpt 5", "effort": "max" },  // bad model: effort kept
      "business-analyst": { "effort": "turbo" },          // bad effort: entry ends up empty
      "oracle": { "model": "opus" },                      // specialist: not a primary agent
      "ghost": "opus",
    },
  }`);
  writeConfig(project, 'claudekei.jsonc', `{
    "primaryAgents": { "orchestrator": { "effort": "xhigh" }, "planner": { "model": "sonnet" } },
  }`);

  const config = loadUserConfig(project, home);
  assert.deepEqual(config.primaryAgents.orchestrator, { model: 'opus', effort: 'xhigh' });
  assert.deepEqual(config.primaryAgents.planner, { model: 'sonnet' });
  assert.deepEqual(config.primaryAgents.sprinter, { effort: 'max' });
  assert.deepEqual(config.primaryAgents['business-analyst'], {});
  assert.equal('oracle' in config.primaryAgents, false);
  assert.equal('ghost' in config.primaryAgents, false);
  assert.equal(config.warnings.length, 4);
  assert.match(config.warnings.join('\n'), /sprinter\.model "gpt 5" ignored/);
  assert.match(config.warnings.join('\n'), /business-analyst\.effort "turbo" ignored/);
  assert.match(config.warnings.join('\n'), /oracle is not a primary agent/);

  assert.deepEqual(getPrimaryAgentPreset('planner', project, home), { model: 'sonnet' });
  assert.equal(getPrimaryAgentPreset('business-analyst', project, home), null);
  assert.equal(getPrimaryAgentPreset('orchestrator', join(ROOT, 'missing'), join(ROOT, 'no-home')), null);
});

test('primaryAgents that is not an object is ignored with a warning', () => {
  const home = join(ROOT, 'pa-bad-home');
  writeConfig(home, 'claudekei.jsonc', '{ "primaryAgents": ["opus"] }');
  const config = loadUserConfig(join(ROOT, 'missing'), home);
  assert.deepEqual(config.primaryAgents, {});
  assert.equal(config.warnings.length, 1);
});

test('claudekei.jsonc template lists every primary agent with its agents/*.md model', () => {
  const repo = new URL('..', import.meta.url);
  const template = parseJsonc(readFileSync(new URL('claudekei.jsonc', repo), 'utf8'));
  const listed = template.primaryAgents;
  assert.deepEqual(Object.keys(listed).sort(), [...PRIMARY_AGENTS].sort());
  for (const name of PRIMARY_AGENTS) {
    const text = readFileSync(new URL(`agents/${name}.md`, repo), 'utf8');
    const block = /^---\n([\s\S]*?)\n---/.exec(text)[1];
    const field = (key) => new RegExp(`^${key}:\\s*(\\S+)`, 'm').exec(block)?.[1];
    assert.equal(listed[name].model, field('model'), `${name} model`);
    // Primary agents have no `effort:` frontmatter on purpose: it would override the session
    // effort and break the effort picker and /effort. The template effort is therefore only
    // checked for validity, not compared to frontmatter.
    assert.equal(field('effort'), undefined, `${name} must not set effort in frontmatter`);
    assert.ok(EFFORT_LEVELS.has(listed[name].effort), `${name} effort`);
  }
});

test('subAgents warn about invalid fields and non-object entries but still keep valid ones', () => {
  const home = join(ROOT, 'subagent-warn-home');
  writeConfig(home, 'claudekei.jsonc', `{
    "subAgents": { "oracle": { "model": "gpt-5", "effort": "max" }, "explorer": "haiku" },
  }`);
  const config = loadUserConfig(join(ROOT, 'missing'), home);
  assert.deepEqual(config.agents, { oracle: { effort: 'max' } });
  assert.equal(config.warnings.length, 2);
  assert.match(config.warnings.join('\n'), /subAgents\.oracle\.model "gpt-5" ignored/);
  assert.match(config.warnings.join('\n'), /subAgents\.explorer must be an object/);
});

test('presets stays a deprecated alias of subAgents with a warning', () => {
  const home = join(ROOT, 'alias-home');
  const project = join(ROOT, 'alias-project');
  writeConfig(home, 'claudekei.jsonc', `{
    "presets": { "oracle": { "model": "haiku", "effort": "low" }, "explorer": { "model": "haiku" } },
    "subAgents": { "oracle": { "model": "opus" }, "debugger": { "effort": "max" } },
  }`);
  const config = loadUserConfig(join(ROOT, 'missing'), home);
  // Same file: a subAgents entry replaces the presets entry of that agent; others coexist.
  assert.deepEqual(config.agents.oracle, { model: 'opus' });
  assert.deepEqual(config.agents.explorer, { model: 'haiku' });
  assert.deepEqual(config.agents.debugger, { effort: 'max' });
  assert.deepEqual(config.warnings, ['`presets` is deprecated, rename to `subAgents`']);

  // Across files the project still wins per field, whichever key either file uses.
  writeConfig(project, 'claudekei.jsonc', '{ "presets": { "oracle": { "effort": "high" } } }');
  assert.deepEqual(loadUserConfig(project, home).agents.oracle, { model: 'opus', effort: 'high' });
  writeConfig(project, 'claudekei.jsonc', '{ "subAgents": { "explorer": { "effort": "medium" } } }');
  assert.deepEqual(loadUserConfig(project, home).agents.explorer, { model: 'haiku', effort: 'medium' });

  // No deprecation warning when only subAgents is used.
  const clean = join(ROOT, 'alias-clean-home');
  writeConfig(clean, 'claudekei.jsonc', '{ "subAgents": { "oracle": { "model": "opus" } } }');
  assert.deepEqual(loadUserConfig(join(ROOT, 'missing'), clean).warnings, []);
});
