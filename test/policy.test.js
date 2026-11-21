import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_FIX_SIGNALS } from '../src/fix-signals.js';
import { readPolicy } from '../src/policy.js';
import { ToolError } from '../src/tool-error.js';

// readPolicy reads evidence.yml in a folder.
// The folder is removed when test t ends.
function folderWith(t, evidenceYml) {
  const cwd = mkdtempSync(join(tmpdir(), 'exhibit-policy-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  if (evidenceYml !== undefined) writeFileSync(join(cwd, 'evidence.yml'), evidenceYml);
  return cwd;
}

const readFixSignals = async (cwd) => (await readPolicy(cwd)).settings.fix_signals;

// The YAML block under "### 8.1 `evidence.yml`" in docs/spec.md, so the test reads the very
// example that people read.
function specExample() {
  const spec = readFileSync(new URL('../docs/spec.md', import.meta.url), 'utf8');
  const section = spec.slice(spec.indexOf('### 8.1 `evidence.yml`'));
  return /```yaml\n([\s\S]*?)```/.exec(section)[1];
}

// Asserts that readPolicy refuses the file with a ToolError whose message matches.
async function refuses(t, text, message) {
  await assert.rejects(readPolicy(folderWith(t, text)), (error) => {
    assert.ok(error instanceof ToolError, `not a ToolError: ${error.stack}`);
    assert.match(error.message, message);
    return true;
  }, text);
}

// A valid policy with one kind, for the tests to break one field at a time.
const kind = (fields) => `version: 3\nkinds:\n  relay-core:\n    match: ["relay/**"]\n    risk: high\n${fields ?? '    needs: [tests-before-after]\n'}`;

test('the example policy in spec 8.1 passes, and readPolicy returns it as written', async (t) => {
  const policy = await readPolicy(folderWith(t, specExample()));
  assert.equal(policy.version, 3);
  assert.deepEqual(policy.settings.fix_signals, ['label:bug', 'title:fix', 'branch:fix/', 'tracker:jira']);
  assert.deepEqual(policy.settings.jira, { site: 'https://acme.atlassian.net', issue_types: ['Bug'], found_field: 'customfield_10042', escaped_values: ['Production'] });
  assert.equal(policy.settings.mutation_budget_seconds, 300);
  assert.deepEqual(Object.keys(policy.kinds), ['relay-core', 'manual']);
  assert.deepEqual(policy.kinds['relay-core'].needs, [
    'tests-before-after',
    { 'failing-before': { when: ['fix', 'feature'] } },
    { mutation: { min: 0.85 } },
    { probe: { name: 'restart-run', run: 'npm run restart-check', artifacts: ['.exhibit/restart.log'] } }
  ]);
  assert.deepEqual(policy.kinds['relay-core'].source, ['D-004', 'D-011']);
  assert.equal(policy.kinds.manual.merge_without_reading, 'allowed');
  assert.deepEqual(policy.default, { risk: 'medium', needs: ['tests-before-after', { mutation: { min: 0.7 } }] });
  assert.deepEqual(policy.equivalent_mutants.map((mark) => mark.replacement), ['queue.length >= 0']);
});

// The evidence.yml block in docs/index.html, with the HTML escapes undone. CLAUDE.md tells
// readers to read that page first, so people copy this example too.
function pageExample() {
  const page = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
  const block = /<pre class="yaml">([\s\S]*?)<\/pre>/.exec(page)[1];
  return block.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

test('the example policy in docs/index.html passes', async (t) => {
  const policy = await readPolicy(folderWith(t, pageExample()));
  assert.deepEqual(Object.keys(policy.kinds), ['relay-core', 'office-visual', 'ticket-store', 'manual']);
  assert.deepEqual(policy.kinds['relay-core'].needs[2], { mutation: { min: 0.85 } });
  assert.equal(policy.default.risk, 'medium');
});

test('readPolicy accepts a hidden probe, a bare failing-before and a min of 0 or 1', async (t) => {
  const needs = '    needs:\n      - failing-before\n      - mutation: { min: 0 }\n      - mutation: { min: 1 }\n      - probe: { name: suite, run: "npm run hidden", author: hidden }\n';
  const policy = await readPolicy(folderWith(t, kind(needs)));
  assert.equal(policy.kinds['relay-core'].needs[3].probe.author, 'hidden');
});

test('readPolicy gives an empty policy with the default fix signals when there is no file', async (t) => {
  assert.deepEqual(await readPolicy(folderWith(t)), { settings: { fix_signals: [...DEFAULT_FIX_SIGNALS] }, kinds: {}, equivalent_mutants: [] });
});

test('readPolicy refuses an unknown item type, and names the item', async (t) => {
  await refuses(t, kind('    needs:\n      - tests-before-after\n      - mutaton: { min: 0.8 }\n'), /^evidence\.yml kinds\.relay-core\.needs\[1\] has the unknown item type "mutaton"\. The types are tests-before-after, failing-before, mutation and probe\.$/);
  await refuses(t, kind('    needs: [screenshots]\n'), /^evidence\.yml kinds\.relay-core\.needs\[0\] has the unknown item type "screenshots"\./);
  await refuses(t, kind('    needs: [mutation]\n'), /^evidence\.yml kinds\.relay-core\.needs\[0\] is a bare mutation, which needs a min/);
});

test('readPolicy refuses a mutation min outside 0 to 1', async (t) => {
  await refuses(t, kind('    needs:\n      - mutation: { min: 85 }\n'), /^evidence\.yml kinds\.relay-core\.needs\[0\]\.mutation\.min must be at most 1\.$/);
  await refuses(t, kind('    needs:\n      - mutation: { min: -0.1 }\n'), /^evidence\.yml kinds\.relay-core\.needs\[0\]\.mutation\.min must be at least 0\.$/);
  await refuses(t, kind('    needs:\n      - mutation: { min: high }\n'), /mutation\.min must be number, not string/);
});

test('readPolicy refuses a probe with no run', async (t) => {
  await refuses(t, kind('    needs:\n      - probe: { name: link-check }\n'), /^evidence\.yml kinds\.relay-core\.needs\[0\]\.probe misses the field run\.$/);
});

test('readPolicy refuses a bad risk', async (t) => {
  await refuses(t, 'kinds:\n  relay-core:\n    match: ["relay/**"]\n    risk: extreme\n    needs: []\n', /^evidence\.yml kinds\.relay-core\.risk must be low, medium or high, not "extreme"\.$/);
});

test('readPolicy refuses an unknown top-level key', async (t) => {
  await refuses(t, 'version: 3\nkind:\n  relay-core: {}\n', /^evidence\.yml has a field the schema does not allow: kind\.$/);
});

test('readPolicy refuses invalid YAML', async (t) => {
  await refuses(t, 'kinds:\n  relay-core:\n    match: ["relay/**"\n', /^evidence\.yml is not valid YAML: /);
});

test('readPolicy names every bad field at once, one on each line', async (t) => {
  const text = 'version: 2\ndefault:\n  risk: medium\n  needs:\n    - failing-before: { when: [bugfix] }\n    - probe: { run: "npm run x", author: builder }\n';
  await assert.rejects(readPolicy(folderWith(t, text)), (error) => {
    assert.deepEqual(error.message.split('\n'), [
      'evidence.yml version must be 3, not 2.',
      'evidence.yml default.needs[0].failing-before.when[0] must be fix or feature, not "bugfix".',
      'evidence.yml default.needs[1].probe misses the field name.',
      'evidence.yml default.needs[1].probe.author must be hidden, not "builder".'
    ]);
    return true;
  });
});

test('readPolicy refuses a kind with no match, risk or needs, and an unknown field in a kind', async (t) => {
  await refuses(t, 'kinds:\n  docs:\n    risk: low\n    needs: []\n', /^evidence\.yml kinds\.docs misses the field match\.$/);
  await refuses(t, kind('    needs: []\n    owner: ops\n'), /^evidence\.yml kinds\.relay-core has a field the schema does not allow: owner\.$/);
  await refuses(t, kind('    needs: []\n    merge_without_reading: sometimes\n'), /merge_without_reading must be never or allowed, not "sometimes"/);
});

test('readPolicy refuses an unknown setting', async (t) => {
  await refuses(t, 'settings:\n  test_comand: npm test\n', /^evidence\.yml settings has a field the schema does not allow: test_comand\.$/);
});

test('readPolicy reads the storage settings, and refuses a storage that is not data-branch or local', async (t) => {
  const policy = await readPolicy(folderWith(t, 'settings:\n  storage: local\n  data_branch: evidence\n  local_path: out\n'));
  assert.equal(policy.settings.storage, 'local');
  assert.equal(policy.settings.data_branch, 'evidence');
  assert.equal(policy.settings.local_path, 'out');
  await refuses(t, 'settings:\n  storage: s3\n', /^evidence\.yml settings\.storage must be data-branch or local, not "s3"\.$/);
  await refuses(t, 'settings:\n  data_branch: "-x"\n', /^evidence\.yml settings\.data_branch does not match/);
});

// The fix_signals tests below came from readFixSignals, which readPolicy replaces.
// Their messages are the same.

test('readPolicy uses the default fix signals when evidence.yml has no settings.fix_signals', async (t) => {
  assert.deepEqual(await readFixSignals(folderWith(t, 'version: 3\nsettings:\n  test_command: npm test\n')), DEFAULT_FIX_SIGNALS);
  assert.deepEqual(await readFixSignals(folderWith(t, 'version: 3\n')), DEFAULT_FIX_SIGNALS);
  assert.deepEqual(await readFixSignals(folderWith(t, '')), DEFAULT_FIX_SIGNALS);
  assert.deepEqual(await readFixSignals(folderWith(t, '# only a comment\n')), DEFAULT_FIX_SIGNALS);
});

test('readPolicy uses a custom fix_signals list in place of the defaults', async (t) => {
  const cwd = folderWith(t, 'settings:\n  fix_signals: [label:defect, title:hotfix]\n');
  assert.deepEqual(await readFixSignals(cwd), ['label:defect', 'title:hotfix']);
});

test('readPolicy accepts pr: with a PR number, like the other types', async (t) => {
  const cwd = folderWith(t, 'settings:\n  fix_signals: [label:bug, title:fix, branch:fix/, pr:96, pr:99, pr:1]\n');
  assert.deepEqual(await readFixSignals(cwd), ['label:bug', 'title:fix', 'branch:fix/', 'pr:96', 'pr:99', 'pr:1']);
});

test('readPolicy refuses a pr: value that is not a PR number, with a message for each', async (t) => {
  const cases = [
    ['settings:\n  fix_signals: ["pr:"]\n', /fix_signals\[0\] is "pr:", which needs a value after the colon\./],
    ['settings:\n  fix_signals: [label:bug, pr:abc]\n', /fix_signals\[1\] is "pr:abc"\. A pr: signal needs a PR number of 1 or more, with no leading zero, as in pr:96\./],
    ['settings:\n  fix_signals: ["pr:-3"]\n', /"pr:-3"\. A pr: signal needs a PR number of 1 or more, with no leading zero, as in pr:96\./],
    ['settings:\n  fix_signals: ["pr:0"]\n', /"pr:0"\. A pr: signal needs a PR number of 1 or more/],
    ['settings:\n  fix_signals: ["pr:9.5"]\n', /"pr:9\.5"\. A pr: signal needs a PR number/],
    ['settings:\n  fix_signals: ["pr:#96"]\n', /"pr:#96"\. A pr: signal needs a PR number/],
    ['settings:\n  fix_signals: ["pr:096"]\n', /"pr:096"\. A pr: signal needs a PR number of 1 or more, with no leading zero, as in pr:96\./],
    ['settings:\n  fix_signals: ["pr: 96"]\n', /"pr: 96"\. Remove the space before or after the value, as in pr:96\./],
    // Without quotes, YAML reads "pr: 96" in a list as a mapping, not as text.
    ['settings:\n  fix_signals: [pr: 96]\n', /fix_signals\[0\] must be text like label:bug, not \{"pr":96\}\. Write it with no space after the colon, as in pr:96\./]
  ];
  for (const [text, message] of cases) {
    await assert.rejects(readPolicy(folderWith(t, text)), (error) => error instanceof ToolError && message.test(error.message), text);
  }
});

test('readPolicy refuses a pr: signal that is in the list twice, and names both places', async (t) => {
  const cwd = folderWith(t, 'settings:\n  fix_signals: [pr:96, label:bug, pr:96]\n');
  await assert.rejects(readPolicy(cwd), (error) => error instanceof ToolError && /evidence\.yml settings\.fix_signals\[2\] is "pr:96", the same as settings\.fix_signals\[0\]\. Name each PR once\./.test(error.message));
});

test('readPolicy accepts title_after_key: like the other types', async (t) => {
  const cwd = folderWith(t, 'settings:\n  fix_signals: [label:bug, title_after_key:fix, branch:fix/]\n');
  assert.deepEqual(await readFixSignals(cwd), ['label:bug', 'title_after_key:fix', 'branch:fix/']);
});

test('readPolicy accepts title_after_tag: like the other types', async (t) => {
  const cwd = folderWith(t, 'settings:\n  fix_signals: [label:bug, title_after_tag:fix]\n');
  assert.deepEqual(await readFixSignals(cwd), ['label:bug', 'title_after_tag:fix']);
});

test('readPolicy accepts revert, a signal with no value, and refuses it with a value', async (t) => {
  const cwd = folderWith(t, 'settings:\n  fix_signals: [label:bug, revert]\n');
  assert.deepEqual(await readFixSignals(cwd), ['label:bug', 'revert']);
  for (const text of ['settings:\n  fix_signals: ["revert:pr"]\n', 'settings:\n  fix_signals: [Revert]\n']) {
    await assert.rejects(readPolicy(folderWith(t, text)), (error) => error instanceof ToolError && /or be the word revert\./.test(error.message), text);
  }
});

test('readPolicy now checks the rest of the file too, not only fix_signals', async (t) => {
  await refuses(t, 'version: banana\nsettings:\n  fix_signals:\n    - branch:bugfix/\n', /^evidence\.yml version must be 3, not "banana"\.$/);
  await refuses(t, 'settings:\n  fix_signals: [branch:bugfix/]\n  mutation_budget_seconds: soon\n', /^evidence\.yml settings\.mutation_budget_seconds must be integer, not string\.$/);
  // setTimeout cannot wait longer than about 24.8 days, so the limit is one day.
  await refuses(t, 'settings:\n  probe_timeout_seconds: 86401\n', /^evidence\.yml settings\.probe_timeout_seconds must be at most 86400\.$/);
  await refuses(t, 'settings:\n  test_timeout_seconds: 86401\n', /^evidence\.yml settings\.test_timeout_seconds must be at most 86400\.$/);
  await refuses(t, 'settings:\n  test_timeout_seconds: 0\n', /^evidence\.yml settings\.test_timeout_seconds must be at least 1\.$/);
  await refuses(t, 'settings:\n  test_timeout_seconds: 1.5\n', /^evidence\.yml settings\.test_timeout_seconds must be integer, not number\.$/);
  await refuses(t, 'settings:\n  fix_signals: [branch:bugfix/]\nkinds: 7\n', /^evidence\.yml kinds must be object or null, not integer\.$/);
});

test('readPolicy refuses a malformed fix_signals with a tool error that says what is wrong', async (t) => {
  const cases = [
    ['settings:\n  fix_signals: label:bug\n', /must be a list/],
    ['settings:\n  fix_signals: []\n', /at least one signal/],
    ['settings:\n  fix_signals: [label:bug, 7]\n', /fix_signals\[1\].*not 7/],
    ['settings:\n  fix_signals: [bug]\n', /"bug".*label:, title:, title_after_key:, title_after_tag:, branch:, pr: or tracker:/],
    ['settings:\n  fix_signals: [issue:bug]\n', /"issue:bug".*label:, title:, title_after_key:, title_after_tag:, branch:, pr: or tracker:/],
    ['settings:\n  fix_signals: ["title_after_key:"]\n', /"title_after_key:".*needs a value/],
    ['settings:\n  fix_signals: ["title_after_key: fix"]\n', /"title_after_key: fix".*space/],
    ['settings:\n  fix_signals: ["title_after_tag:"]\n', /"title_after_tag:".*needs a value/],
    ['settings:\n  fix_signals: ["label:"]\n', /"label:".*needs a value/],
    ['settings:\n  fix_signals: ["label: bug"]\n', /"label: bug".*space/],
    ['settings:\n  fix_signals: ["title:fix "]\n', /"title:fix ".*space/],
    ['settings:\n  fix_signals: [label:bug\n', /evidence\.yml is not valid YAML/]
  ];
  for (const [text, message] of cases) {
    await assert.rejects(readPolicy(folderWith(t, text)), (error) => error instanceof ToolError && message.test(error.message), text);
  }
});

test('readPolicy refuses a mutation min of NaN or infinity', async (t) => {
  await refuses(t, kind('    needs:\n      - mutation: { min: .nan }\n'), /^evidence\.yml kinds\.relay-core\.needs\[0\]\.mutation\.min must be number, not NaN\.$/);
  await refuses(t, kind('    needs:\n      - mutation: { min: .inf }\n'), /^evidence\.yml kinds\.relay-core\.needs\[0\]\.mutation\.min must be number, not infinity\.$/);
});

test('a key with nothing under it is the same as no key', async (t) => {
  assert.deepEqual(await readPolicy(folderWith(t, 'settings:\nkinds:\ndefault:\nequivalent_mutants:\n')), { settings: { fix_signals: [...DEFAULT_FIX_SIGNALS] }, kinds: {}, equivalent_mutants: [] });
  const policy = await readPolicy(folderWith(t, kind('    needs:\n      - failing-before:\n      - tests-before-after:\n')));
  assert.deepEqual(policy.kinds['relay-core'].needs, ['failing-before', 'tests-before-after']);
  assert.deepEqual(await readPolicy(folderWith(t, 'version:\n')), { settings: { fix_signals: [...DEFAULT_FIX_SIGNALS] }, kinds: {}, equivalent_mutants: [] });
  const withDefault = await readPolicy(folderWith(t, 'default:\n  risk: low\n  needs:\n    - failing-before:\n'));
  assert.deepEqual(withDefault.default.needs, ['failing-before']);
});

test('readPolicy refuses a fix signal with a line break, without showing the schema regex', async (t) => {
  await refuses(t, 'settings:\n  fix_signals: ["title:fix\\nmore"]\n', /^evidence\.yml settings\.fix_signals\[0\] is "title:fix\\nmore"\. A signal must be on one line\.$/);
});

test('the evidence item rules are the same under kinds and under default', () => {
  const schema = JSON.parse(readFileSync(new URL('../schema/evidence.schema.json', import.meta.url), 'utf8'));
  const underKinds = schema.properties.kinds.additionalProperties.properties.needs;
  const underDefault = schema.properties.default.properties.needs;
  assert.deepEqual(underDefault, underKinds);
});

test('readPolicy names NaN and infinity in a version message, not null', async (t) => {
  await refuses(t, 'version: .nan\n', /^evidence\.yml version must be 3, not NaN\.$/);
  await refuses(t, 'version: .inf\n', /^evidence\.yml version must be 3, not Infinity\.$/);
});

test('readPolicy reads settings.jira for the tracker:jira signal, and refuses a bad one', async (t) => {
  const jira = 'settings:\n  fix_signals: [label:bug, tracker:jira]\n  jira:\n    site: https://acme.atlassian.net\n    issue_types: [Bug, Defect]\n    found_field: customfield_10042\n    escaped_values: [Production]\n';
  const policy = await readPolicy(folderWith(t, jira));
  assert.deepEqual(policy.settings.fix_signals, ['label:bug', 'tracker:jira']);
  assert.deepEqual(policy.settings.jira, { site: 'https://acme.atlassian.net', issue_types: ['Bug', 'Defect'], found_field: 'customfield_10042', escaped_values: ['Production'] });

  await refuses(t, 'settings:\n  fix_signals: [tracker:linear]\n', /^evidence\.yml settings\.fix_signals\[0\] is "tracker:linear"\. A tracker: signal names a tracker Exhibit knows: tracker:jira\.$/);
  await refuses(t, 'settings:\n  fix_signals: [tracker:jira]\n', /settings needs jira: \{ site: https:\/\/your-site\.atlassian\.net \}/);
  await refuses(t, 'settings:\n  jira:\n    site: https://acme.atlassian.net\n    found_field: customfield_10042\n', /^evidence\.yml settings\.jira\.found_field needs escaped_values/);
  await refuses(t, 'settings:\n  jira:\n    site: https://acme.atlassian.net\n    escaped_values: [Production]\n', /^evidence\.yml settings\.jira\.escaped_values needs found_field/);
  await refuses(t, 'settings:\n  jira:\n    issue_types: [Bug]\n', /settings\.jira/);
  await refuses(t, 'settings:\n  jira:\n    site: https://acme.atlassian.net\n    token: abc\n', /settings\.jira has a field the schema does not allow: token/);
});

// A mark for one equivalent mutant (spec 9.5), for the tests to break one field at a time.
const mark = (fields) => `version: 3\nequivalent_mutants:\n  - ${fields}\n`;
const MARK = 'file: src/a.js\n    line_text: "if (a > 0) return a;"\n    mutator: EqualityOperator\n    original: a > 0\n    replacement: a >= 0\n    reason: "a is never 0 here."';

test('readPolicy reads the marks of equivalent mutants, and an empty list is no marks', async (t) => {
  const policy = await readPolicy(folderWith(t, mark(MARK)));
  assert.deepEqual(policy.equivalent_mutants, [{ file: 'src/a.js', line_text: 'if (a > 0) return a;', mutator: 'EqualityOperator', original: 'a > 0', replacement: 'a >= 0', reason: 'a is never 0 here.' }]);
  assert.deepEqual((await readPolicy(folderWith(t, 'version: 3\nequivalent_mutants:\n'))).equivalent_mutants, []);
  assert.deepEqual((await readPolicy(folderWith(t, 'version: 3\n'))).equivalent_mutants, []);
});

test('readPolicy refuses a mark with no reason, an empty reason or an unknown field', async (t) => {
  await refuses(t, mark(MARK.replace(/\n {4}reason: .*/, '')), /^evidence\.yml equivalent_mutants\[0\] /);
  await refuses(t, mark(MARK.replace(/reason: .*/, 'reason: ""')), /^evidence\.yml equivalent_mutants\[0\]\.reason /);
  await refuses(t, mark(`${MARK}\n    line: 3`), /^evidence\.yml equivalent_mutants\[0\] has a field the schema does not allow: line\.$/);
});

test('readPolicy refuses code that YAML reads as another type or as empty text, so a mark that never matches does not hide', async (t) => {
  // Stryker's replacements true, [] and "" need the quotes that evidence.json gives them.
  await refuses(t, mark(MARK.replace('replacement: a >= 0', 'replacement: true')), /^evidence\.yml equivalent_mutants\[0\]\.replacement must be string, not boolean\.$/);
  await refuses(t, mark(MARK.replace('replacement: a >= 0', 'replacement: []')), /^evidence\.yml equivalent_mutants\[0\]\.replacement /);
  await refuses(t, mark(MARK.replace('replacement: a >= 0', 'replacement: ""')), /^evidence\.yml equivalent_mutants\[0\]\.replacement must have at least 1 character\.$/);
  const quoted = await readPolicy(folderWith(t, mark(MARK.replace('replacement: a >= 0', 'replacement: "\\"\\""'))));
  assert.equal(quoted.equivalent_mutants[0].replacement, '""');
});
