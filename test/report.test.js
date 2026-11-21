import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildReport, defectText, escapedDefects, funnel, WEAK_HISTORY } from '../src/report.js';
import { DEFAULT_FIX_SIGNALS } from '../src/fix-signals.js';
import { SHOP_HISTORY, SHOP_REPO, shopHistoryText } from './fixtures/report/shop-history.js';

const shopLines = () => readFileSync(SHOP_HISTORY, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
const report = (lines, options = {}) => buildReport(lines, { repo: SHOP_REPO, szzRan: true, fixSignals: DEFAULT_FIX_SIGNALS, ...options });

// The words a person sees in report.html: the body with the tags taken out and the entities
// turned back into characters.
function htmlText(html) {
  const body = html.slice(html.indexOf('<body>'));
  return body
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

// The words a person sees in report.md: the text with the markdown marks taken out.
function markdownText(markdown) {
  return markdown
    .replace(/^#+ /gm, '')
    .replace(/^\s*- /gm, '')
    .replace(/(?<!\\)`+ ?/g, '')
    .replace(/\\([\\`*_[\]<>#|~!&])/g, '$1');
}

// The facts the report gives, as a person reads them: the counts, each defect with its
// introducing PRs and their confidence, each blamed commit, and the fix PRs with no link.
function factsIn(text) {
  return {
    read: text.match(/Exhibit read (\d+) merged PRs/)?.[1],
    fixes: text.match(/(\d+|None) of them (are fix PRs|is a fix PR)/)?.[1],
    defects: [...text.matchAll(/Fix PR (\d+): /g)].map((m) => Number(m[1])),
    links: [...text.matchAll(/Introducing PR (\d+)\b.*?confidence (\d+)% \((\d+) of (\d+) counted lines\)/g)].map((m) => m.slice(1).join(' ')),
    commits: [...text.matchAll(/blame: commit ([0-9a-f]{7})/g)].map((m) => m[1]),
    noLink: [...text.matchAll(/PR (\d+) \(.*?\): (SZZ [^.\n]*)/g)].map((m) => `${m[1]} ${m[2]}`),
    weak: /The history is weak/.test(text)
  };
}

// A fix PR line with one link that holds `confidence` of its counted lines. The rest of its
// counted lines came from no merged PR.
function fixLine(number, { confidence = 1, introducing = 1 } = {}) {
  const counted = 4;
  const linked = Math.round(counted * confidence);
  const codeLine = (n) => ({ path: 'src/a.js', line: n, text: `bad(${n});`, blame: { commit: 'a'.repeat(40), original_path: 'src/a.js', original_line: n, author: 'dev', author_time: '2026-01-01T00:00:00Z', summary: 'Add a' } });
  const lines = Array.from({ length: counted }, (_, i) => codeLine(i + 1));
  return {
    number,
    title: `Fix bug ${number}`,
    merged_at: `2026-02-${String(number).padStart(2, '0')}T00:00:00Z`,
    classification: { fix: true, fix_signal: 'title:fix' },
    szz: {
      blamed_commit: 'b'.repeat(40),
      links: linked > 0 ? [{ pr: introducing, confidence: linked / counted, lines: lines.slice(0, linked) }] : [],
      unlinked_lines: lines.slice(linked),
      dropped_lines: [],
      no_link_reason: null
    }
  };
}

const plainLine = (number) => ({ number, title: `Add thing ${number}`, merged_at: '2026-01-01T00:00:00Z', classification: { fix: false, fix_signal: null }, szz: null });

test('the fixed history file is still what SZZ gives on the fixture repo', async () => {
  assert.equal(readFileSync(SHOP_HISTORY, 'utf8'), await shopHistoryText(), 'Write it again: node test/fixtures/report/shop-history.js > test/fixtures/report/shop-history.jsonl');
});

test('report.md from the fixture history gives the counts and each escaped defect with its evidence', () => {
  const { markdown } = report(shopLines());
  const facts = factsIn(markdownText(markdown));
  assert.equal(facts.read, '14');
  assert.equal(facts.fixes, '7');
  // Newest merge first. Each defect lists its introducing PRs with their confidence.
  assert.deepEqual(facts.defects, [14, 12, 7, 6]);
  assert.deepEqual(facts.links, ['13 100 1 1', '1 50 1 2', '11 50 1 2', '2 50 1 2', '3 50 1 2', '1 100 1 1']);
  assert.match(markdown, /^# Escaped defects in fixture\/shop$/m);
  assert.match(markdown, /^### Fix PR 7: Fix discount and tax math$/m);
  assert.match(markdown, /Introducing PR 2: Add discounts, confidence 50% \(1 of 2 counted lines\)/);
  // The SZZ evidence: the line, and what git blame said about it.
  const line = shopLines().find((l) => l.number === 7).szz.links[0].lines[0];
  assert.match(markdown, /`src\/discount\.js` line 3: `return total - percent;`/);
  assert.ok(markdown.includes(`blame: commit \`${line.blame.commit.slice(0, 7)}\` by maintainer on 2026-01-05: Add discounts (#2)`));
  // The fix PRs that SZZ linked to nothing, and why.
  assert.deepEqual(facts.noLink, ['10 SZZ dropped every line it changed: comments only', '9 SZZ dropped every line it changed: moved lines only', '8 SZZ dropped every line it changed: whitespace only']);
});

test('the first screen gives the counts and how sure Exhibit is before the list of defects', () => {
  const { markdown } = report(shopLines());
  const read = markdown.indexOf('Exhibit read 14 merged PRs');
  const sure = markdown.indexOf('## How sure Exhibit is');
  const defects = markdown.indexOf('## Escaped defects');
  assert.ok(read > 0 && read < sure && sure < defects, markdown);
});

test('report.html and report.md list the same defects with the same numbers', () => {
  const { markdown, html } = report(shopLines());
  const md = factsIn(markdownText(markdown));
  const page = factsIn(htmlText(html));
  assert.equal(md.defects.length, 4);
  assert.equal(md.commits.length, 6);
  assert.deepEqual(page, md);
});

test('report.html loads nothing from outside the file', () => {
  const { html } = report(shopLines());
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">/);
  for (const loader of [/<script/i, /<link/i, /<img/i, /<iframe/i, /<object/i, /<embed/i, /\bsrc=/i, /\bhref=/i, /url\(/i, /@import/i, /https?:\/\//i]) {
    assert.doesNotMatch(html, loader);
  }
  // The styles are in the file.
  assert.match(html, /<style>[^<]+<\/style>/);
});

test('report.html escapes text from the history, and report.md keeps it plain text', () => {
  const lines = shopLines().map((line) => (line.number === 7 ? { ...line, title: 'Fix <script>alert(1)</script> & *stars* in `code`' } : line));
  const { markdown, html } = report(lines);
  assert.doesNotMatch(html, /<script/);
  assert.ok(htmlText(html).includes('Fix PR 7: Fix <script>alert(1)</script> & *stars* in `code`'));
  assert.ok(markdown.includes('### Fix PR 7: Fix \\<script\\>alert(1)\\</script\\> \\& \\*stars\\* in \\`code\\`'));
  assert.ok(markdownText(markdown).includes('Fix PR 7: Fix <script>alert(1)</script> & *stars* in `code`'));
});

test('a line of code with backticks keeps them in report.md', () => {
  const lines = shopLines().map((line) => {
    if (line.number !== 6) return line;
    const [link] = line.szz.links;
    return { ...line, szz: { ...line.szz, links: [{ ...link, lines: [{ ...link.lines[0], text: 'const s = `${a}`;' }] }] } };
  });
  const { markdown } = report(lines);
  assert.ok(markdown.includes('line 4: `` const s = `${a}`; ``'), markdown);
});

test('a history with no fix PRs says so in plain words, with no empty list or table', () => {
  const lines = [3, 2, 1].map(plainLine);
  const { markdown, html } = report(lines);
  for (const text of [markdownText(markdown), htmlText(html)]) {
    assert.ok(text.includes('Exhibit read 3 merged PRs. None of them is a fix PR, so there are no escaped defects to find.'), text);
    assert.ok(text.includes('The history is weak'));
    assert.ok(text.includes('Check that the fix signals match how this repo marks a fix. They are now label:bug, title:fix and branch:fix/.'), text);
    assert.doesNotMatch(text, /Escaped defects \(/);
  }
  assert.doesNotMatch(markdown, /\|/);
  assert.doesNotMatch(markdown, /^## Escaped defects/m);
  assert.doesNotMatch(html, /<table|<ul>\s*<\/ul>/);
});

test(`the history is weak below ${WEAK_HISTORY.minFixPrs} fix PRs, and not weak at ${WEAK_HISTORY.minFixPrs}`, () => {
  const fixes = (count) => Array.from({ length: count }, (_, i) => fixLine(i + 1));
  const nine = factsIn(markdownText(report(fixes(9)).markdown));
  const ten = report(fixes(10)).markdown;
  assert.equal(WEAK_HISTORY.minFixPrs, 10);
  assert.equal(nine.weak, true);
  assert.match(report(fixes(9)).markdown, /Only 9 fix PRs\. Exhibit needs at least 10/);
  assert.equal(factsIn(markdownText(ten)).weak, false);
  assert.match(ten, /Exhibit is fairly sure of these links/);
});

test('the history is weak when fewer than half of the defects have a link with confidence 0.5 or more', () => {
  assert.equal(WEAK_HISTORY.strongConfidence, 0.5);
  const strong = (number) => fixLine(number, { confidence: 0.5 });
  const low = (number) => fixLine(number, { confidence: 0.25 });
  const base = Array.from({ length: 8 }, (_, i) => fixLine(20 + i, { confidence: 0 }));
  // 2 of 4 defects strong: half, so not weak. 0.5 itself counts as strong.
  const half = report([strong(1), strong(2), low(3), low(4), ...base]).markdown;
  assert.equal(factsIn(markdownText(half)).weak, false, half);
  // 1 of 4 strong: fewer than half, so weak.
  const fewer = report([strong(1), low(2), low(3), low(4), ...base]).markdown;
  assert.equal(factsIn(markdownText(fewer)).weak, true);
  assert.match(fewer, /Only 1 of 4 escaped defects has a link that holds at least half of the fix's counted lines/);
});

test('the history is weak when SZZ linked no fix PR', () => {
  const lines = Array.from({ length: 10 }, (_, i) => fixLine(i + 1, { confidence: 0 }));
  const { markdown } = report(lines);
  assert.equal(factsIn(markdownText(markdown)).weak, true);
  assert.match(markdown, /SZZ linked none of the 10 fix PRs to the PR that brought the bug\./);
  assert.match(markdown, /PR 3 \(Fix bug 3\): SZZ found its 4 lines only in commits that are in no merged PR\./);
});

test('outside a clone, the report says that SZZ did not run', () => {
  const lines = shopLines().map((line) => ({ ...line, szz: null }));
  const { markdown, html } = report(lines, { szzRan: false });
  for (const text of [markdownText(markdown), htmlText(html)]) {
    assert.ok(text.includes('SZZ did not run, because history ran outside a clone of the repo. So this report cannot show escaped defects. Run exhibit history inside a clone of fixture/shop.'), text);
    assert.ok(text.includes('The history is weak'));
    // The rule names this case, as spec 8.5 does.
    assert.ok(text.includes('Exhibit calls the history weak when it has fewer than 10 fix PRs, when SZZ links none of them or did not run, or when fewer than half of the escaped defects have a link with a confidence of 0.5 or more.'), text);
    assert.deepEqual(factsIn(text).defects, []);
  }
});

test('a fix PR that SZZ skipped is listed with no link, and counted in the summary', () => {
  const lines = shopLines().map((line) => (line.number === 6 ? { ...line, szz: null } : line));
  const { markdown } = report(lines);
  assert.match(markdown, /SZZ skipped 1 of them/);
  assert.match(markdown, /PR 6 \(Fix subtotal to count quantity\): SZZ skipped it\. The warning from exhibit history says why\./);
  assert.deepEqual(factsIn(markdownText(markdown)).defects, [14, 12, 7]);
});

test('the plain text of a defect shows control characters from a PR title as "?"', () => {
  const lines = shopLines().map((line) => (line.number === 12 ? { ...line, title: 'Fix \u001b[31mred\u0007 text' } : line));
  const fix = escapedDefects(lines).find((line) => line.number === 12);
  assert.match(defectText(fix, lines), /^Fix PR 12: Fix \?\[31mred\? text\n/);
});

test('escapedDefects lists the fix PRs with a link, newest first, as the report does', () => {
  const lines = shopLines();
  const inReport = [...report(lines).markdown.matchAll(/^### Fix PR (\d+):/gm)].map((m) => Number(m[1]));
  assert.deepEqual(escapedDefects(lines).map((line) => line.number), inReport);
  assert.ok(inReport.length >= 3);
});

test('a revert link shows "revert" as its evidence, in place of blame lines, in both files', () => {
  const revert = {
    number: 15,
    title: 'Revert "Add the shop entry point"',
    merged_at: '2026-02-01T09:00:00Z',
    classification: { fix: true, fix_signal: 'revert' },
    szz: { blamed_commit: null, links: [{ pr: 5, confidence: 1, found_by: 'revert', lines: [] }], unlinked_lines: [], dropped_lines: [], no_link_reason: null }
  };
  const notFound = {
    number: 16,
    title: 'Revert "Add a page"',
    merged_at: '2026-02-02T09:00:00Z',
    classification: { fix: true, fix_signal: 'revert' },
    szz: { blamed_commit: null, links: [], unlinked_lines: [], dropped_lines: [], no_link_reason: 'reverted change not found' }
  };
  // A title-only revert asks nobody, and gets the same reason.
  const titleOnly = { ...notFound, number: 17, title: 'Revert "Add a footer"', merged_at: '2026-02-03T09:00:00Z' };
  const { markdown, html } = report([...shopLines(), revert, notFound, titleOnly]);
  for (const text of [markdownText(markdown), htmlText(html)]) {
    assert.ok(text.includes('Fix PR 15: Revert "Add the shop entry point"'), text);
    assert.ok(text.includes('Merged on 2026-02-01. It is a revert, so SZZ ran no git blame: the revert names the PR it takes back.'), text);
    assert.ok(text.includes('Introducing PR 5: Add the shop entry point, confidence 100%, evidence: revert. PR 15 reverts it.'), text);
    assert.ok(text.includes('PR 16 (Revert "Add a page"): It is a revert, but Exhibit found no PR in this repo that it names.'), text);
    assert.ok(text.includes('PR 17 (Revert "Add a footer"): It is a revert, but Exhibit found no PR in this repo that it names.'), text);
  }
  assert.deepEqual(factsIn(markdownText(markdown)).defects, [15, 14, 12, 7, 6]);
  // A revert link is strong: it holds the whole fix.
  assert.match(markdown, /SZZ linked 5 of them/);
});

// A labels line for the fix PR `fixPr`, that keeps the links in `kept` and rejects the rest.
function labelLine(fixPr, { kept = [], rejected = [], known = null }) {
  return { id: `D-${String(fixPr).padStart(3, '0')}`, fix_pr: fixPr, introducing_prs: kept, rejected_prs: rejected, code: 'c', category: 'c', would_have_caught: 'c', labeled_by: 'person', szz_link_rejected: rejected.length > 0, known_at_review: known, labeled_at: '2026-11-21T00:00:00.000Z' };
}

// The steps of the funnel, as "name: count", in the order the report shows them.
const funnelSteps = (text) => text.slice(text.indexOf('Defects left at each step')).split('\n').filter((row) => /^\s*(- )?[A-Z].*: /.test(row)).slice(0, 5).map((row) => row.replace(/^\s*- /, '').trim());

test('the funnel counts a defect whose links were all rejected as labeled, but not as kept', () => {
  // The shop history has 4 escaped defects: fix PRs 14, 12, 7 and 6. Fix PR 7 links PRs 2 and 3.
  const labels = { state: 'read', lines: [labelLine(12, { kept: [1, 11] }), labelLine(7, { rejected: [2, 3] })] };
  assert.deepEqual(funnel(shopLines(), { szzRan: true, labels }), { merged_prs: 14, fix_prs: 7, szz_linked: 4, labeled: 2, kept: 1, labels: 'read' });
  const { markdown } = report(shopLines(), { labels });
  assert.deepEqual(funnelSteps(markdownText(markdown)), [
    'Merged PRs read: 14',
    'Fix PRs: 7',
    'Fix PRs with an SZZ link: 4',
    'Defects labeled with exhibit label: 2',
    'Defects with at least one link that a person kept: 1'
  ]);
});

test('a label for a defect that is no longer in the history is not counted', () => {
  const labels = { state: 'read', lines: [labelLine(12, { kept: [1] }), labelLine(99, { kept: [1] })] };
  assert.deepEqual(funnel(shopLines(), { szzRan: true, labels }), { merged_prs: 14, fix_prs: 7, szz_linked: 4, labeled: 1, kept: 1, labels: 'read' });
});

test('with no labels file, the last two steps of the funnel say "not labeled yet"', () => {
  assert.deepEqual(funnel(shopLines(), { szzRan: true, labels: { state: 'none' } }), { merged_prs: 14, fix_prs: 7, szz_linked: 4, labeled: null, kept: null, labels: 'none' });
  const { markdown } = report(shopLines(), { labels: { state: 'none' } });
  assert.deepEqual(funnelSteps(markdownText(markdown)).slice(3), ['Defects labeled with exhibit label: not labeled yet', 'Defects with at least one link that a person kept: not labeled yet']);
});

test('labels that could not be read make the funnel say so, and name the problem', () => {
  const labels = { state: 'unreadable', problem: '.exhibit/labels.jsonl line 2 is not JSON' };
  assert.equal(funnel(shopLines(), { szzRan: true, labels }).labels, 'unreadable');
  const text = markdownText(report(shopLines(), { labels }).markdown);
  assert.deepEqual(funnelSteps(text).slice(3), ['Defects labeled with exhibit label: the labels could not be read', 'Defects with at least one link that a person kept: the labels could not be read']);
  assert.match(text, /Exhibit could not read the labels, so it does not count them: \.exhibit\/labels\.jsonl line 2 is not JSON/);
});

test('outside a clone, the funnel stops at the fix PRs, because SZZ did not run', () => {
  const labels = { state: 'read', lines: [labelLine(12, { kept: [1] })] };
  assert.deepEqual(funnel(shopLines(), { szzRan: false, labels }), { merged_prs: 14, fix_prs: 7, szz_linked: null, labeled: null, kept: null, labels: 'read' });
  assert.deepEqual(funnelSteps(markdownText(report(shopLines(), { szzRan: false, labels }).markdown)).slice(2), [
    'Fix PRs with an SZZ link: SZZ did not run',
    'Defects labeled with exhibit label: SZZ did not run',
    'Defects with at least one link that a person kept: SZZ did not run'
  ]);
});

test('report.md and report.html show the same funnel, on the first screen', () => {
  for (const labels of [{ state: 'read', lines: [labelLine(7, { rejected: [2, 3] })] }, { state: 'none' }]) {
    const { markdown, html } = report(shopLines(), { labels });
    const steps = funnelSteps(markdownText(markdown));
    assert.equal(steps.length, 5);
    assert.deepEqual(funnelSteps(htmlText(html)), steps);
    // The funnel comes after the counts and before how sure Exhibit is.
    assert.ok(markdown.indexOf('Exhibit read 14') < markdown.indexOf('Defects left at each step') && markdown.indexOf('Defects left at each step') < markdown.indexOf('## How sure Exhibit is'));
  }
});

test('two label lines for one fix PR count it once, by its first line, so the funnel never goes up', () => {
  // A second line can come from a merge of two label files, or a hand edit. The first line wins,
  // as in exhibit label. Here the first line rejects every link, and the second keeps one.
  const labels = { state: 'read', lines: [labelLine(7, { rejected: [2, 3] }), labelLine(7, { kept: [2], rejected: [3] })] };
  assert.deepEqual(funnel(shopLines(), { szzRan: true, labels }), { merged_prs: 14, fix_prs: 7, szz_linked: 4, labeled: 1, kept: 0, labels: 'read' });
});

test('a deferral goes in "Deferred at review", and is left out of the escaped-defect count on the first screen', () => {
  // The shop history has 4 linked fix PRs: 14, 12, 7 and 6. Review saw the bug that PR 12 fixed,
  // and left it for a later ticket. PR 7's label says review did not see its bug.
  const labels = { state: 'read', lines: [labelLine(12, { kept: [1, 11], known: true }), labelLine(7, { kept: [2, 3], known: false })] };
  const { markdown, html } = report(shopLines(), { labels });
  const text = markdownText(markdown);
  const firstScreen = text.slice(0, text.indexOf('How sure Exhibit is'));
  assert.match(firstScreen, /SZZ linked 4 of them to the PRs that brought their bugs\. Review saw 1 of them and left it for a later ticket, so 3 are escaped defects\./);
  assert.match(firstScreen, /Fix PRs with an SZZ link: 4/);
  assert.doesNotMatch(firstScreen, /escaped defects: 4/);
  const escaped = text.slice(text.indexOf('Escaped defects (3)'), text.indexOf('Deferred at review (1)'));
  assert.deepEqual([...escaped.matchAll(/Fix PR (\d+): /g)].map((m) => Number(m[1])), [14, 7, 6]);
  const deferred = text.slice(text.indexOf('Deferred at review (1)'));
  assert.match(deferred, /review saw the bug and left it for a later ticket/);
  assert.deepEqual([...deferred.matchAll(/^Fix PR (\d+): /gm)].map((m) => Number(m[1])), [12]);
  assert.equal(htmlText(html).includes('Deferred at review (1)'), true);
});

test('with no deferral, the report has no "Deferred at review" group', () => {
  const labels = { state: 'read', lines: [labelLine(12, { kept: [1] })] };
  const text = markdownText(report(shopLines(), { labels }).markdown);
  assert.doesNotMatch(text, /Deferred at review/);
  assert.match(text, /Escaped defects \(4\)/);
});

test('the rule for weak history does not count a deferral', () => {
  const strong = (number) => fixLine(number, { confidence: 0.5 });
  const low = (number) => fixLine(number, { confidence: 0.25 });
  const base = Array.from({ length: 8 }, (_, i) => fixLine(20 + i, { confidence: 0 }));
  // 2 of 4 defects strong is not weak. With strong fix PR 1 deferred, 1 of the 3 escaped defects
  // is strong, so it is weak.
  const lines = [strong(1), strong(2), low(3), low(4), ...base];
  assert.equal(factsIn(markdownText(report(lines).markdown)).weak, false);
  const labels = { state: 'read', lines: [labelLine(1, { kept: [1], known: true })] };
  const { markdown } = report(lines, { labels });
  assert.match(markdown, /Only 1 of 3 escaped defects has a link that holds at least half of the fix's counted lines/);
});

test('when every linked defect is a deferral, the history is weak, with no "0 of the 0"', () => {
  // 11 fix PRs, and SZZ linked only fix PR 1. Its label says review saw it.
  const lines = [fixLine(1, { confidence: 1 }), ...Array.from({ length: 10 }, (_, i) => fixLine(20 + i, { confidence: 0 }))];
  assert.equal(factsIn(markdownText(report(lines).markdown)).weak, false);
  const labels = { state: 'read', lines: [labelLine(1, { kept: [1], known: true })] };
  const { markdown } = report(lines, { labels });
  assert.equal(factsIn(markdownText(markdown)).weak, true);
  assert.match(markdown, /Every linked defect is a deferral, so there are no escaped defects to judge\./);
  assert.doesNotMatch(markdown, /0 of the 0/);
});
