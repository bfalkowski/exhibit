import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFix, DEFAULT_FIX_SIGNALS, revertedWork, withOldNames } from '../src/fix-signals.js';

const pr = (fields) => ({ number: 1, title: 'Add a page', labels: [], branch: 'topic', ...fields });
const notFix = { fix: false, fix_signal: null };

test('the default signals are the ones in the spec', () => {
  assert.deepEqual(DEFAULT_FIX_SIGNALS, ['label:bug', 'title:fix', 'branch:fix/']);
});

test('label: matches a label with the same name, in any case, and nothing else', () => {
  const signals = ['label:bug'];
  assert.deepEqual(classifyFix(pr({ labels: ['bug'] }), signals), { fix: true, fix_signal: 'label:bug' });
  assert.deepEqual(classifyFix(pr({ labels: ['docs', 'BUG'] }), signals), { fix: true, fix_signal: 'label:bug' });
  assert.deepEqual(classifyFix(pr({ labels: ['bug-report'] }), signals), notFix);
  assert.deepEqual(classifyFix(pr({ labels: ['debug'] }), signals), notFix);
  assert.deepEqual(classifyFix(pr({ labels: [] }), signals), notFix);
});

test('title: matches a title that starts with the word, in any case', () => {
  const signals = ['title:fix'];
  for (const title of ['fix: crash on start', 'Fix the crash', 'fix(cli): crash', 'FIX!: crash', 'fix']) {
    assert.deepEqual(classifyFix(pr({ title }), signals), { fix: true, fix_signal: 'title:fix' }, title);
  }
});

test('title: is a prefix, not "contains", and the word must end where the prefix ends', () => {
  const signals = ['title:fix'];
  for (const title of ['Add prefix fixer', 'Quick fix for the crash', 'Fixture repo for tests', 'fixes']) {
    assert.deepEqual(classifyFix(pr({ title }), signals), notFix, title);
  }
});

test('title_after_key: matches the word after a leading ticket key', () => {
  const signals = ['title_after_key:fix'];
  for (const title of ['T-170: Fix the crash', 'KEY-123: fix the parser', '[KEY-123] fix the parser', '(KEY-123) Fix the parser', 'key-9 fix(cli): crash', '  T-1:fix']) {
    assert.deepEqual(classifyFix(pr({ title }), signals), { fix: true, fix_signal: 'title_after_key:fix' }, title);
  }
});

test('title_after_key: keeps the word rule of title:, so a longer word or a later word does not match', () => {
  const signals = ['title_after_key:fix'];
  for (const title of ['T-170: Add prefix fixer', 'T-170: Improve fixtures', 'T-170: Fixture repo', 'T-186: Land the T-128 fixes', 'T-170 Quick fix', '[KEY-123]: Add a page']) {
    assert.deepEqual(classifyFix(pr({ title }), signals), notFix, title);
  }
});

test('title_after_key: matches a title with no key the same way as title: does', () => {
  const titles = ['fix: crash on start', 'Fix the crash', 'fix(cli): crash', 'FIX!: crash', 'fix', 'Add prefix fixer', 'Quick fix for the crash', 'Fixture repo for tests', 'fixes'];
  for (const title of titles) {
    const plain = classifyFix(pr({ title }), ['title:fix']);
    const afterKey = classifyFix(pr({ title }), ['title_after_key:fix']);
    assert.deepEqual(afterKey, { fix: plain.fix, fix_signal: plain.fix ? 'title_after_key:fix' : null }, title);
  }
});

test('title_after_key: skips only a key of letters, a hyphen and digits', () => {
  const signals = ['title_after_key:fix'];
  for (const title of ['Docs: fix a typo', 'T-: fix', '-170: fix', 'T-170Fix the crash']) {
    assert.deepEqual(classifyFix(pr({ title }), signals), notFix, title);
  }
});

test('title_after_key: skips a bare ticket number with a colon after it, as in "192: Fix the crash"', () => {
  const signals = ['title_after_key:fix'];
  for (const title of ['192: Fix the crash', '192:fix the crash', '79 : fix the parser', '192: T-170: Fix', 'T-170, 192: fix']) {
    assert.deepEqual(classifyFix(pr({ title }), signals), { fix: true, fix_signal: 'title_after_key:fix' }, title);
  }
  for (const title of ['192: Add prefix fixer', '79 Fix the crash', '79, Fix the crash', '79. Fix the crash', '79-Fix the crash', '1.2: Fix', '[79] Fix the crash']) {
    assert.deepEqual(classifyFix(pr({ title }), signals), notFix, title);
  }
});

test('title_after_key: skips a key followed by a dash, a spaced colon or a comma, and more than one key', () => {
  const signals = ['title_after_key:fix'];
  const titles = ['T-170 - Fix the crash', '[T-170] - Fix the crash', 'T-170 : Fix the crash', 'T-170, T-171: Fix', 'T-170: [T-171] Fix', '#79: Fix the crash', '[#79] fix the crash'];
  for (const title of titles) {
    assert.deepEqual(classifyFix(pr({ title }), signals), { fix: true, fix_signal: 'title_after_key:fix' }, title);
  }
});

test('title_after_key: a bare key still needs a mark or a space after it, and a dash needs a space before it', () => {
  const signals = ['title_after_key:fix'];
  for (const title of ['#79Fix the crash', 'T-170-Fix the crash', 'T-170, Add a fix', '#: fix', 'T-170 - Add prefix fixer']) {
    assert.deepEqual(classifyFix(pr({ title }), signals), notFix, title);
  }
});

test('title_after_key: a word shaped like a key is skipped as a key, so "FIX-12: Add a page" is not a fix', () => {
  for (const title of ['FIX-12: Add a page', 'fix-12: crash']) {
    assert.deepEqual(classifyFix(pr({ title }), ['title_after_key:fix']), notFix, title);
    assert.deepEqual(classifyFix(pr({ title }), ['title:fix']), { fix: true, fix_signal: 'title:fix' }, title);
  }
});

test('title_after_key: skips a bare key followed by a period and a space, as Apache projects write it', () => {
  const signals = ['title_after_key:fix'];
  for (const title of ['ZOOKEEPER-123. Fix the crash', 'HADOOP-19000.  fix the parser', 'T-170. T-171: Fix', '#79. Fix the crash']) {
    assert.deepEqual(classifyFix(pr({ title }), signals), { fix: true, fix_signal: 'title_after_key:fix' }, title);
  }
  for (const title of ['ZOOKEEPER-5076. Upgrade JDK to 17 for the Owasp build', 'T-170. Add prefix fixer']) {
    assert.deepEqual(classifyFix(pr({ title }), signals), notFix, title);
  }
});

test('title_after_key: a period with no space after it keeps the key, so "T-170.Fix" is not a fix', () => {
  for (const title of ['T-170.Fix the crash', 'T-170.fix', '#79.Fix the crash']) {
    assert.deepEqual(classifyFix(pr({ title }), ['title_after_key:fix']), notFix, title);
  }
});

test('title_after_key: a word shaped like a key after a real key is skipped too, so "T-170: fix-12: crash" is not a fix', () => {
  assert.deepEqual(classifyFix(pr({ title: 'T-170: fix-12: crash' }), ['title_after_key:fix']), notFix);
});

test('title_after_key: does not skip a tag after the key, so "HADOOP-20089. S3A: Fix" is not a fix', () => {
  for (const title of ['HADOOP-20089. S3A: Fix documented default', 'HDFS-17906. (3.4) Fix issue', '[FLINK-41350][table-planner] Fix RESUME']) {
    assert.deepEqual(classifyFix(pr({ title }), ['title_after_key:fix']), notFix, title);
  }
});

test('title_after_tag: skips one tag after the keys: a word and a colon, or text in brackets or parentheses', () => {
  const signals = ['title_after_tag:fix'];
  const titles = [
    'HADOOP-20089. S3A: Fix documented default of fs.s3a.input.stream.type',
    'HIVE-30161: Iceberg: Fix Create table failures',
    'HADOOP-20021. hadoop-bos: fix hierarchy bucket rename',
    'HDFS-17906. (3.4) Fix issue that DataNodes get stuck',
    'HADOOP-19795. (Follow up) Fix Javadoc',
    '[FLINK-41350][table-planner] Fix RESUME, ALTER and DROP',
    '[FLINK-38534][runtime/tests] Fix flaky LocalRecoveryTest',
    'HADOOP-19902. [ABFS] Fix small write hflush',
    'ZOOKEEPER-4736: [ADDENDUM] Fix compilation failure',
    'T-170: [T-171] (3.4) Fix the crash'
  ];
  for (const title of titles) {
    assert.deepEqual(classifyFix(pr({ title }), signals), { fix: true, fix_signal: 'title_after_tag:fix' }, title);
  }
});

test('title_after_tag: matches what title_after_key matches, also a title with no key', () => {
  const titles = ['T-170: Fix the crash', '[KEY-123] fix the parser', 'ZOOKEEPER-123. Fix the crash', '192: Fix the crash', 'fix: crash on start', 'Fix the crash', 'T-170: fix: crash'];
  for (const title of titles) {
    assert.deepEqual(classifyFix(pr({ title }), ['title_after_tag:fix']), { fix: true, fix_signal: 'title_after_tag:fix' }, title);
  }
});

test('title_after_tag: "T-170: Docs: fix a typo" is not a fix, because docs: is a Conventional Commits type', () => {
  const titles = ['T-170: Docs: fix a typo', 'T-170: chore: fix the lint', 'T-170: test: fix a flaky test', 'T-170: refactor: fix names', 'T-170: feat: fix-up mode'];
  for (const title of titles) {
    assert.deepEqual(classifyFix(pr({ title }), ['title_after_tag:fix']), notFix, title);
  }
});

test('title_after_tag: skips a tag only after a key, and only one tag', () => {
  const titles = [
    'S3A: Fix documented default',
    '[table] Fix the planner',
    '(3.4) Fix issue',
    'T-170: [a] [b] Fix',
    'T-170: S3A: [abfs] Fix',
    'T-170: Follow-up to YARN-11937: Fix NPE',
    'T-170: S3A: Fixture repo',
    'T-170: S3A:Fix',
    'T-170: Add S3A: fix',
    'T-170: [unclosed Fix'
  ];
  for (const title of titles) {
    assert.deepEqual(classifyFix(pr({ title }), ['title_after_tag:fix']), notFix, title);
  }
});

test('branch: matches a branch that starts with the prefix, in any case', () => {
  const signals = ['branch:fix/'];
  assert.deepEqual(classifyFix(pr({ branch: 'fix/crash' }), signals), { fix: true, fix_signal: 'branch:fix/' });
  assert.deepEqual(classifyFix(pr({ branch: 'Fix/Crash' }), signals), { fix: true, fix_signal: 'branch:fix/' });
  assert.deepEqual(classifyFix(pr({ branch: 'hotfix/crash' }), signals), notFix);
  assert.deepEqual(classifyFix(pr({ branch: 'fixes' }), signals), notFix);
});

test('when more than one signal matches, the first in the list is recorded', () => {
  const both = pr({ title: 'Fix the crash', labels: ['bug'], branch: 'fix/crash' });
  assert.deepEqual(classifyFix(both, DEFAULT_FIX_SIGNALS), { fix: true, fix_signal: 'label:bug' });
  assert.deepEqual(classifyFix(both, ['branch:fix/', 'title:fix']), { fix: true, fix_signal: 'branch:fix/' });
});

test('pr: matches the PR with that number, and no other', () => {
  const signals = ['pr:96', 'pr:99'];
  assert.deepEqual(classifyFix(pr({ number: 96 }), signals), { fix: true, fix_signal: 'pr:96' });
  assert.deepEqual(classifyFix(pr({ number: 99 }), signals), { fix: true, fix_signal: 'pr:99' });
  for (const number of [9, 960, 97, 1]) assert.deepEqual(classifyFix(pr({ number }), signals), notFix, `PR ${number}`);
});

test('pr: adds to the other signals, and the first match in the list is recorded', () => {
  const labelled = pr({ number: 96, labels: ['bug'] });
  assert.deepEqual(classifyFix(labelled, ['label:bug', 'pr:96']), { fix: true, fix_signal: 'label:bug' });
  assert.deepEqual(classifyFix(labelled, ['pr:96', 'label:bug']), { fix: true, fix_signal: 'pr:96' });
  // A PR that only the label marks is still a fix when the list also has pr: signals.
  assert.deepEqual(classifyFix(pr({ number: 5, labels: ['bug'] }), ['pr:96', 'label:bug']), { fix: true, fix_signal: 'label:bug' });
});

test('a PR with no matching signal is not a fix', () => {
  assert.deepEqual(classifyFix(pr({}), DEFAULT_FIX_SIGNALS), notFix);
});

test('revert matches the title that GitHub\'s Revert button and git revert write', () => {
  const signals = ['revert'];
  for (const title of ['Revert "Add the widget cache"', 'revert "Add the widget cache"', '  Revert "T-170: Fix the crash"']) {
    assert.deepEqual(classifyFix(pr({ title }), signals), { fix: true, fix_signal: 'revert' }, title);
  }
});

test('revert matches a body that names the reverted PR, as GitHub\'s Revert button writes it', () => {
  const signals = ['revert'];
  for (const body of ['Reverts acme/widgets#12', 'Reverts acme/widgets#12\n\nIt broke the cache.', 'Why: it broke.\nreverts Acme/Widgets#12']) {
    assert.deepEqual(classifyFix(pr({ title: 'Take back the cache', body }), signals), { fix: true, fix_signal: 'revert' }, body);
  }
});

test('revert matches a body with the line git revert writes', () => {
  const signals = ['revert'];
  for (const body of [
    'This reverts commit 3f2a9c1e0d4b5a6978877665544332211aabbccd.',
    'This reverts commit 3f2a9c1e0d4b5a6978877665544332211aabbccd, reversing\nchanges made to 0123456789abcdef0123456789abcdef01234567.',
    'This reverts commit 3f2a9c1.'
  ]) {
    assert.deepEqual(classifyFix(pr({ title: 'Take back the cache', body }), signals), { fix: true, fix_signal: 'revert' }, body);
  }
});

test('revert does not match a title or body that only uses the word later in the text', () => {
  const signals = ['revert'];
  for (const [title, body] of [
    ['Add a revert button', null],
    ['Fix: do not revert "x" on save', ''],
    ['Reverted state after save', null],
    ['Add a page', 'We may need to revert this later.'],
    ['Add a page', 'See how this reverts commit 3f2a9c1 in the docs.'],
    ['Add a page', 'It reverts acme/widgets#12 in spirit.']
  ]) {
    assert.deepEqual(classifyFix(pr({ title, body }), signals), notFix, title);
  }
});

test('a revert of a revert puts the work back, so it is no fix', () => {
  const signals = ['revert'];
  for (const [title, body] of [
    ['Revert "Revert "Add the widget cache""', 'Reverts acme/widgets#13'],
    ['Reapply "Add the widget cache"', 'This reverts commit 3f2a9c1e0d4b5a6978877665544332211aabbccd.'],
    ['revert "revert "Add the widget cache""', null]
  ]) {
    assert.deepEqual(classifyFix(pr({ title, body }), signals), notFix, title);
  }
});

test('revert is a signal like the others: the first one in the list that matches is recorded', () => {
  const revert = pr({ title: 'Revert "Add the widget cache"', labels: ['bug'] });
  assert.deepEqual(classifyFix(revert, ['label:bug', 'revert']), { fix: true, fix_signal: 'label:bug' });
  assert.deepEqual(classifyFix(revert, ['revert', 'label:bug']), { fix: true, fix_signal: 'revert' });
  assert.deepEqual(classifyFix(revert, DEFAULT_FIX_SIGNALS), { fix: true, fix_signal: 'label:bug' });
  assert.deepEqual(classifyFix(pr({ title: 'Revert "Add the widget cache"' }), DEFAULT_FIX_SIGNALS), notFix, 'revert is not in the defaults');
});

test('revertedWork lists the PRs of this repo and the commits that a revert body names', () => {
  const body = 'Reverts acme/widgets#12\nReverts ACME/widgets#14\nReverts other/repo#3\nReverts acme/widgets#12\n\nThis reverts commit 3F2A9C1E0D4B5A6978877665544332211AABBCCD.';
  assert.deepEqual(revertedWork(body, 'acme/widgets'), { prs: [12, 14], commits: ['3f2a9c1e0d4b5a6978877665544332211aabbccd'] });
  assert.deepEqual(revertedWork(body, null), { prs: [12, 14, 3], commits: ['3f2a9c1e0d4b5a6978877665544332211aabbccd'] });
  assert.deepEqual(revertedWork(null, 'acme/widgets'), { prs: [], commits: [] });
});

test('a body that names only a PR in another repo is no revert, when the PR\'s repo is known', () => {
  const signals = ['revert'];
  const bump = { title: 'Bump lodash from 4.17.20 to 4.17.21', body: 'Release notes:\nReverts lodash/lodash#5000' };
  assert.deepEqual(classifyFix(pr({ ...bump, repo: 'acme/widgets' }), signals), notFix);
  assert.deepEqual(classifyFix(pr({ ...bump, body: `${bump.body}\nReverts acme/widgets#12`, repo: 'acme/widgets' }), signals), { fix: true, fix_signal: 'revert' });
  // A title from GitHub's Revert button still counts, whatever the body names.
  assert.deepEqual(classifyFix(pr({ title: 'Revert "Bump lodash"', body: 'Reverts lodash/lodash#5000', repo: 'acme/widgets' }), signals), { fix: true, fix_signal: 'revert' });
});

// A forge for withOldNames: `repo` is its name, and `oldNames` are names that GitHub redirects
// to it, as after a rename or a transfer. `asked` lists each name it was asked about.
function renamedForge(repo, oldNames = []) {
  const asked = [];
  return { repo, asked, sameRepo: async (name) => (asked.push(name), oldNames.includes(name.toLowerCase())) };
}

test('withOldNames lets a body that names the repo by an old name be a revert, after a rename or a transfer', async () => {
  const signals = ['revert'];
  const forge = renamedForge('newowner/widgets', ['oldowner/widgets']);
  const back = pr({ title: 'Take back the cache', body: 'Reverts OldOwner/Widgets#12\nReverts lodash/lodash#5000', repo: 'newowner/widgets' });
  // Without the old names, only the current name counts.
  assert.deepEqual(classifyFix(back, signals), notFix);
  const named = await withOldNames(back, signals, forge);
  assert.deepEqual(named.oldNames, ['oldowner/widgets']);
  assert.deepEqual(classifyFix(named, signals), { fix: true, fix_signal: 'revert' });
  assert.deepEqual(revertedWork(back.body, 'newowner/widgets', named.oldNames), { prs: [12], commits: [] });
  assert.deepEqual(forge.asked, ['OldOwner/Widgets', 'lodash/lodash']);
  // Copied release notes that name only another repo are still no revert.
  assert.deepEqual(classifyFix(await withOldNames(pr({ ...back, body: 'Reverts lodash/lodash#5000' }), signals, forge), signals), notFix);
});

test('withOldNames asks the forge nothing when the answer does not need it', async () => {
  const forge = renamedForge('newowner/widgets', ['oldowner/widgets']);
  const body = 'Reverts oldowner/widgets#12';
  for (const [title, signals, why] of [
    ['Take back the cache', ['label:bug'], 'the signals hold no revert'],
    ['Revert "Add the cache"', ['revert'], 'the title makes it a revert'],
    ['Revert "Revert "Add the cache""', ['revert'], 'the title makes it a re-land'],
    ['Reapply "Add the cache"', ['revert'], 'the title makes it a re-land']
  ]) {
    const back = pr({ title, body, repo: 'newowner/widgets' });
    assert.equal(await withOldNames(back, signals, forge), back, why);
  }
  const current = pr({ title: 'Take back', body: 'Reverts NewOwner/Widgets#12\nReverts oldowner/widgets#13', repo: 'newowner/widgets' });
  assert.equal(await withOldNames(current, ['revert'], forge), current, 'the body names the current name');
  assert.deepEqual(forge.asked, []);
});
