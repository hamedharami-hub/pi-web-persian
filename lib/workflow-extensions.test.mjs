import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';

const root = '/home/ubuntu/.pi/agent/extensions';
const jiti = createJiti(import.meta.url, {
  alias: { '@earendil-works/pi-tui': new URL('../node_modules/@earendil-works/pi-tui/dist/index.js', import.meta.url).pathname },
});
const { default: plan } = await jiti.import(`${root}/plan-mode/index.ts`);
const { default: goal } = await jiti.import(`${root}/goal.ts`);
const { extractTodoItems, cleanStepText, markCompletedSteps } = await jiti.import(`${root}/plan-mode/utils.ts`);
const assistant = (text, stopReason = 'stop') => ({ role: 'assistant', content: [{ type: 'text', text }], stopReason });

function harness(extension, { ui = true, entries = [], flag = false } = {}) {
  let branch = structuredClone(entries);
  let active = ['read', 'bash', 'edit', 'write', 'codemode', 'custom'];
  const events = new Map(), commands = new Map(), statuses = new Map(), widgets = new Map();
  const sent = [], users = [], notices = [], selects = [], editors = [];
  let choice, edited;
  const ctx = {
    hasUI: ui, mode: ui ? 'rpc' : 'print',
    sessionManager: { getBranch: () => branch },
    ui: {
      theme: { fg: (_color, text) => text, strikethrough: text => text },
      setStatus: (key, value) => statuses.set(key, value),
      setWidget: (key, value) => widgets.set(key, value),
      notify: (...args) => notices.push(args),
      select: async (...args) => { selects.push(args); return choice; },
      editor: async (...args) => { editors.push(args); return edited; },
    },
  };
  extension({
    on: (name, fn) => events.set(name, fn),
    registerCommand: (name, command) => commands.set(name, command.handler),
    registerFlag() {}, registerShortcut() {}, getFlag: () => flag,
    getActiveTools: () => [...active], setActiveTools: tools => { active = [...tools]; },
    appendEntry: (customType, data) => branch.push({ type: 'custom', customType, data: structuredClone(data) }),
    sendMessage: (...args) => sent.push(args), sendUserMessage: (...args) => users.push(args),
  });
  return {
    ctx, sent, users, notices, selects, editors, statuses, widgets, events,
    emit: async (name, event = {}) => events.get(name)?.(event, ctx),
    command: async (name, args = '') => commands.get(name)(args, ctx),
    setBranch: value => { branch = structuredClone(value); },
    choose: value => { choice = value; }, edit: value => { edited = value; },
    active: () => active, entries: () => structuredClone(branch),
    state: () => branch.filter(e => e.customType === 'plan-mode').at(-1)?.data,
  };
}

test('parser: multilingual headers/digits, full text, nesting and section boundaries', () => {
  const long = 'Run `npm test` and verify **all** output without dropping this long description or its verb';
  assert.equal(cleanStepText(long), long);
  for (const header of ['Plan:', '## **برنامه:**', 'برنامه پیشنهادی:', '**برنامهٔ اجرا:**', 'مراحل اجرا:', 'طرح اجرا:', '### خطة التنفيذ：']) {
    const steps = extractTodoItems(`${header}\n۱. ${long}\n   More detail\n   ١. Nested detail\n۲) /src/a.ts\n٣. تست\n\n## Risks\n1. Not a step`);
    assert.equal(steps.length, 3, header);
    assert.equal(steps[0].text, `${long}\nMore detail\n١. Nested detail`);
    assert.equal(steps[1].text, '/src/a.ts');
    assert.equal(steps[2].step, 3);
  }
  assert.deepEqual(extractTodoItems('No plan\n1. unrelated'), []);
  assert.deepEqual(extractTodoItems('```\nPlan:\n1. example\n```'), []);
  assert.equal(extractTodoItems('Plan:\n1. Read\n2. Verify:\n   detail\nNotes:\n1. unrelated').length, 2);
});

test('parser rejects arbitrary numbers and non-sequential top-level lists', () => {
  for (const text of ['Plan:\n2026 was a year\n42 files', 'Plan:\n2026. A year', 'مراحل اجرا:\n۴۲ مورد', 'Plan:\n2. Not a list starting at one']) {
    assert.deepEqual(extractTodoItems(text), [], text);
  }
  assert.equal(extractTodoItems('Plan:\n1. Inspect\n2026. Not a step').length, 1);
});

test('markers: explicit claims only; idempotent, bounded and multilingual', () => {
  const steps = extractTodoItems('Plan:\n1. Read\n2. Test');
  assert.equal(markCompletedSteps('`[DONE:1]`\n> [DONE:2]\n```\n[DONE:1]\n```', steps), 0);
  assert.equal(markCompletedSteps('[DONE:۱] [DONE:1] [DONE:99]', steps), 1);
  assert.equal(markCompletedSteps('[DONE:٢]', steps), 1);
  assert.equal(markCompletedSteps('all done', steps), 0);
});

test('explicit on/off/status, bare toggle, preserved todos and fail-closed nested gate', async () => {
  const h = harness(plan); await h.emit('session_start');
  const original = [...h.active()];
  await h.command('plan', 'on'); await h.command('plan', 'on');
  assert.deepEqual(h.active(), ['read', 'grep', 'find', 'ls']);
  for (const toolName of ['bash', 'write', 'edit', 'codemode', 'Agent', 'mcp_tool', 'unknown']) {
    assert.equal((await h.emit('tool_call', { toolName, parentToolCallId: 'parent' })).block, true);
  }
  assert.equal(await h.emit('tool_call', { toolName: 'read' }), undefined);
  await h.emit('agent_end', { messages: [assistant('برنامه:\n۱. بررسی\n۲. تست')] });
  assert.equal(h.state().todos.length, 2);
  await h.command('plan', 'status'); assert.equal(h.state().enabled, true);
  await h.command('plan', 'off'); await h.command('plan', 'off');
  assert.deepEqual(h.active(), original); assert.equal(h.state().todos.length, 2);
  assert.match(h.widgets.get('plan-todos')[0], /SAVED/);
  await h.command('plan', 'invalid'); assert.equal(h.state().enabled, false);
  await h.command('plan'); assert.equal(h.state().enabled, true);
  await h.command('plan'); assert.equal(h.state().enabled, false);
  assert.equal(h.sent.length, 0); assert.equal(h.selects.length, 0);
});

test('mode button maps to bare /plan, preserves checklist and pauses execution read-only', async () => {
  const h = harness(plan);
  h.statuses.set('command:/plan status', 'Legacy toast button');
  await h.emit('session_start');
  const key = 'command:/plan';
  const clickMode = () => h.command(key.slice('command:/'.length));
  assert.equal(h.statuses.get(key), 'Plan OFF · toggle');
  assert.equal(h.statuses.get('command:/plan status'), undefined);
  await clickMode();
  assert.equal(h.statuses.get(key), 'Plan ON · toggle');
  await h.emit('agent_end', { messages: [assistant('Plan:\n1. Inspect\n2. Verify')] });
  await h.command('plan', 'execute');
  await h.emit('turn_end', { outcome: 'completed', message: assistant('[DONE:1]') });
  const checklist = structuredClone(h.state().todos);
  assert.match(h.statuses.get('plan-mode'), /1\/2/);
  assert.equal(h.statuses.get(key), 'Plan OFF · toggle');
  await clickMode();
  assert.equal(h.state().executing, false); assert.equal(h.state().enabled, true);
  assert.equal(h.statuses.get(key), 'Plan ON · toggle');
  assert.deepEqual(h.state().todos, checklist);
  assert.deepEqual(h.active(), ['read', 'grep', 'find', 'ls']);
  assert.equal((await h.emit('tool_call', { toolName: 'write' })).block, true);
  await h.command('plan', 'status'); assert.equal(h.state().enabled, true);
  await clickMode();
  assert.equal(h.state().executing, false); assert.equal(h.state().enabled, false);
  assert.deepEqual(h.state().todos, checklist); assert.ok(h.active().includes('write'));
  assert.equal(h.sent.length, 1); // Toggle/off never resumes automatically.
  h.statuses.set('command:/plan status', 'Stale');
  await h.command('plan', 'status'); assert.equal(h.statuses.get('command:/plan status'), undefined);
  h.statuses.set('command:/plan status', 'Stale again');
  await h.emit('session_shutdown');
  assert.equal(h.statuses.get(key), undefined);
  assert.equal(h.statuses.get('command:/plan status'), undefined);
});

test('agent_end never prompts or executes, missing formats do not hang; todos explicit choices', async () => {
  const h = harness(plan); await h.command('plan', 'on');
  await h.emit('agent_end', { messages: [assistant('Ask a question, no plan.')] });
  assert.equal(h.selects.length, 0);
  await h.emit('agent_end', { messages: [assistant('Plan:\n1. Inspect\n2. Verify')] });
  assert.equal(h.selects.length, 0); assert.equal(h.sent.length, 0);
  assert.equal(h.statuses.get('command:/plan execute'), '▶ Execute');
  assert.equal(h.statuses.get('command:/todos'), '📋 Todos');
  await h.command('todos');
  assert.deepEqual(h.selects[0][1], ['Status / close', 'Refine the plan', 'Execute the plan']);
  assert.equal(h.sent.length, 0);
  h.choose('Refine the plan'); h.edit('Please add focused tests'); await h.command('todos');
  assert.equal(h.users[0][0], 'Please add focused tests'); assert.equal(h.state().enabled, true);
  h.choose('Execute the plan'); await h.command('todos');
  assert.equal(h.sent.length, 1); assert.equal(h.state().executing, true);
  assert.equal(h.statuses.get('command:/plan execute'), undefined);
  assert.match(h.widgets.get('plan-todos')[0], /EXECUTING/);
});

test('off/execution: current authority overrides compacted history and custom triggers; no user deletion', async () => {
  const h = harness(plan); await h.command('plan', 'on');
  await h.emit('agent_end', { messages: [assistant('Plan:\n1. Inspect\n2. Test')] });
  const history = [
    { role: 'custom', customType: 'plan-mode-context', content: '[PLAN MODE ACTIVE]' },
    { role: 'custom', customType: 'plan-execution-context', content: 'old execution' },
    { role: 'compactionSummary', summary: 'Historical [PLAN MODE ACTIVE]' },
    { role: 'user', content: 'Explain [PLAN MODE ACTIVE]' },
  ];
  await h.command('plan', 'off');
  const restoredTools = [...h.active()];
  assert.ok(restoredTools.includes('bash')); assert.ok(restoredTools.includes('custom'));
  let result = await h.emit('context', { messages: history });
  assert.equal(result.messages.length, 3);
  assert.equal(result.messages[1], history[3]);
  assert.match(result.messages.at(-1).content, /Planning is OFF/);
  assert.match(result.messages.at(-1).content, /not authorization/);
  assert.equal(result.messages[0], history[2]); // Retain the summary, supersede only extension reminders.
  assert.match(result.messages.at(-1).content, /only this extension's historical mode reminders/);
  assert.match(result.messages.at(-1).content, /never overrides system or higher-priority instructions/);
  for (const event of [{ messageType: 'user' }, { messageType: 'custom', message: { customType: 'background' } }]) {
    assert.match((await h.emit('before_agent_start', event)).message.content, /Planning is OFF/);
  }
  await h.command('plan', 'execute');
  assert.deepEqual(h.active(), restoredTools);
  assert.equal(await h.emit('tool_call', { toolName: 'bash' }), undefined);
  assert.equal(h.sent[0][1].triggerTurn, true);
  assert.match((await h.emit('before_agent_start', { messageType: 'custom', message: h.sent[0][0] })).message.content, /explicitly approved/);
  // Model the idle custom execution trigger lifecycle through both hooks.
  const injected = await h.emit('before_agent_start', { messageType: 'custom', message: h.sent[0][0] });
  result = await h.emit('context', { messages: [...history, { role: 'custom', ...injected.message }] });
  assert.equal(result.messages.filter(m => m.customType === 'plan-current-mode').length, 1);
  assert.match(result.messages.at(-1).content, /Planning is OFF/);
  assert.equal(result.messages.some(m => m.customType === 'plan-mode-context'), false);
  assert.match(result.messages.at(-1).content, /1\. Inspect/);
  await h.command('plan', 'execute'); assert.equal(h.sent.length, 1);
});

test('progress: failed/aborted turns do not count, all-done never invents success or clears evidence', async () => {
  const h = harness(plan); await h.command('plan', 'on');
  await h.emit('agent_end', { messages: [assistant('Plan:\n1. Inspect\n2. Test')] });
  await h.command('plan', 'execute');
  for (const outcome of ['error', 'aborted']) {
    await h.emit('turn_end', { outcome, message: assistant('[DONE:1] [DONE:2]', outcome) });
    assert.equal(h.state().todos.some(t => t.completed), false);
  }
  await h.emit('turn_end', { outcome: 'completed', message: assistant('Looks finished') });
  assert.equal(h.state().todos.some(t => t.completed), false);
  await h.emit('turn_end', { outcome: 'completed', message: assistant('[DONE:1]') });
  assert.equal(h.state().todos[0].completed, true);
  await h.emit('turn_end', { outcome: 'completed', message: assistant('[DONE:2]') });
  await h.emit('agent_end', { messages: [assistant('Finished')] });
  assert.equal(h.state().todos.length, 2); assert.equal(h.sent.length, 1);
  assert.match(h.statuses.get('plan-mode'), /2\/2/);
  assert.equal(h.state().executing, false);
  assert.equal(h.statuses.get('command:/plan'), 'Plan OFF · toggle');
  assert.equal(h.statuses.get('command:/plan status'), undefined);
  assert.match(h.widgets.get('plan-todos')[0], /not independently verified/);
  await h.command('plan', 'execute'); await h.command('todos', 'execute');
  assert.equal(h.sent.length, 1);
  const resumed = harness(plan, { entries: h.entries() }); await resumed.emit('session_start', { reason: 'resume' });
  assert.equal(resumed.state().executing, false);
  assert.equal(resumed.state().todos.length, 2);
  assert.match(resumed.statuses.get('plan-mode'), /not independently verified/);
  await resumed.command('plan', 'execute'); assert.equal(resumed.sent.length, 0);
  assert.match((await resumed.emit('context', { messages: [] })).messages.at(-1).content, /not independent proof/);
});

test('resume repairs legacy executing-at-100 snapshots once without losing checklist', async () => {
  const entry = { type: 'custom', customType: 'plan-mode', data: { enabled: false, executing: true,
    todos: [{ step: 1, text: 'Inspect', completed: true }] } };
  const h = harness(plan, { entries: [entry] });
  await h.emit('session_start', { reason: 'resume' });
  assert.equal(h.state().executing, false); assert.equal(h.state().todos[0].text, 'Inspect');
  const count = h.entries().length;
  await h.emit('session_tree'); assert.equal(h.entries().length, count);
  await h.command('plan', 'execute'); assert.equal(h.sent.length, 0);
  assert.equal(h.statuses.get('command:/plan execute'), undefined);
});

test('truncated planning responses never replace a saved plan or expose partial execution', async () => {
  const h = harness(plan); await h.command('plan', 'on');
  await h.emit('agent_end', { messages: [assistant('Plan:\n1. Partial', 'length')] });
  assert.equal(h.state().todos.length, 0);
  assert.equal(h.statuses.get('command:/plan execute'), undefined);
  await h.emit('agent_end', { messages: [assistant('Plan:\n1. Original')] });
  await h.emit('agent_end', { messages: [assistant('Plan:\n1. Truncated replacement', 'length')] });
  assert.equal(h.state().todos[0].text, 'Original');
  assert.equal(h.selects.length, 0); assert.equal(h.sent.length, 0);
});

test('branch/resume/new reconstruction uses snapshots, never historical markers, and restores tools', async () => {
  const h = harness(plan); await h.command('plan', 'on');
  await h.emit('agent_end', { messages: [assistant('Plan:\n1. Inspect')] });
  const planning = h.entries();
  await h.command('plan', 'execute');
  const execution = h.entries();
  execution.push({ type: 'message', message: assistant('[DONE:1] from unrelated old execution') });
  h.setBranch(execution); await h.emit('session_tree');
  assert.equal(h.state().todos[0].completed, false);
  assert.match(h.statuses.get('plan-mode'), /0\/1/);
  assert.equal(h.statuses.get('command:/plan'), 'Plan OFF · toggle');
  h.setBranch(planning); await h.emit('session_tree');
  assert.deepEqual(h.active(), ['read', 'grep', 'find', 'ls']);
  h.setBranch([]); await h.emit('session_tree');
  assert.ok(h.active().includes('bash')); assert.equal(h.widgets.get('plan-todos'), undefined);
  const resumed = harness(plan, { entries: planning }); await resumed.emit('session_start', { reason: 'resume' });
  assert.deepEqual(resumed.active(), ['read', 'grep', 'find', 'ls']);
  await resumed.emit('session_shutdown', { reason: 'new' });
  assert.ok(resumed.active().includes('bash')); assert.equal(resumed.statuses.get('command:/todos'), undefined);
  const fresh = harness(plan); await fresh.emit('session_start', { reason: 'new' });
  assert.equal(fresh.widgets.get('plan-todos'), undefined);
  assert.equal(fresh.events.has('session_switch'), false);
});

test('headless planning extracts todos without dialogs and execution needs pending steps', async () => {
  const h = harness(plan, { ui: false, flag: true }); await h.emit('session_start');
  await h.command('plan', 'execute'); assert.equal(h.sent.length, 0);
  await h.emit('agent_end', { messages: [assistant('Plan:\n1. Inspect', 'error')] });
  assert.equal(h.state(), undefined);
  await h.emit('agent_end', { messages: [assistant('Plan:\n1. Inspect')] });
  assert.equal(h.state().todos.length, 1);
  await h.command('todos'); assert.equal(h.selects.length, 0);
  assert.equal(h.sent.length, 0);
});

test('goal bare UI editor, cancel, direct set, clear and command status never start a run', async () => {
  const h = harness(goal); await h.emit('session_start');
  assert.match(h.statuses.get('command:/goal'), /Set goal/);
  h.edit('Verify the fix'); await h.command('goal');
  assert.deepEqual(h.editors[0], ['Set focus goal (no automatic execution):', '']);
  assert.match(h.statuses.get('command:/goal'), /Edit goal/);
  h.edit(undefined); await h.command('goal');
  assert.equal(h.editors[1][1], 'Verify the fix');
  await h.command('goal', 'New focus');
  assert.match((await h.emit('before_agent_start', { messageType: 'user' })).message.content, /New focus/);
  const branch = h.entries();
  await h.command('goal', 'done');
  assert.equal(await h.emit('before_agent_start', { messageType: 'user' }), undefined);
  const result = await h.emit('context', { messages: [{ role: 'custom', customType: 'focus-goal-context', content: 'stale' }] });
  assert.equal(result.messages.length, 1); assert.match(result.messages[0].content, /No active goal/);
  const quoted = { role: 'user', content: '[PI FOCUS GOAL] explain this marker' };
  assert.equal((await h.emit('context', { messages: [quoted] })).messages[0], quoted);
  const resumedGoal = harness(goal, { entries: branch }); await resumedGoal.emit('session_start', { reason: 'resume' });
  await resumedGoal.command('goal'); assert.equal(resumedGoal.editors[0][1], 'New focus');
  h.setBranch(branch); await h.emit('session_tree');
  h.edit(undefined); await h.command('goal'); assert.equal(h.editors.at(-1)[1], 'New focus');
  h.setBranch([]); await h.emit('session_tree');
  assert.match(h.statuses.get('command:/goal'), /Set goal/);
  await h.emit('session_shutdown'); assert.equal(h.statuses.get('command:/goal'), undefined);
  assert.equal(h.sent.length, 0); assert.equal(h.users.length, 0);
  const headless = harness(goal, { ui: false }); await headless.command('goal');
  assert.equal(headless.editors.length, 0); assert.equal(headless.sent.length, 0);
});
