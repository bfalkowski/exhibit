import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJUnit } from '../src/junit.js';

test('reads passed, failed, errored and skipped test cases', () => {
  const xml = `<?xml version="1.0"?>
<testsuites>
  <testsuite name="s">
    <testcase name="ok" classname="a" file="t/a.js"/>
    <testcase name="bad" classname="a"><failure message="x">boom</failure></testcase>
    <testcase name="broke" classname="a"><error message="y"/></testcase>
    <testcase name="later" classname="a"><skipped/></testcase>
    <testcase name="with output" classname="a"><system-out>hello</system-out></testcase>
  </testsuite>
</testsuites>`;
  assert.deepEqual(parseJUnit(xml).map((item) => [item.name, item.status]), [['ok', 'passed'], ['bad', 'failed'], ['broke', 'failed'], ['later', 'skipped'], ['with output', 'passed']]);
  assert.equal(parseJUnit(xml)[0].file, 't/a.js');
});

test('reads a ">" and entities in a value, and ignores tags inside CDATA and comments', () => {
  const xml = `<testsuites>
    <testcase name="top &lt;bad> &amp; &quot;q&quot; &#233;" classname="test"><failure><![CDATA[<testcase name="fake"/>]]></failure></testcase>
    <!-- <testcase name="commented"/> -->
  </testsuites>`;
  assert.deepEqual(parseJUnit(xml), [{ name: 'top <bad> & "q" é', classname: 'test', file: '', status: 'failed' }]);
});

test('a file that is not JUnit XML throws', () => {
  assert.throws(() => parseJUnit('TAP version 13\nok 1 - a\n'), /not JUnit XML/);
});
