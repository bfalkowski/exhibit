// Reads JUnit XML, the test results file that most test runners can write (spec 9.3).
//
// It gives back one entry for each <testcase>: its name, classname and file, and its status.
// A test case with a <failure> or <error> child failed. One with only a <skipped> child was
// skipped. Any other test case passed.
//
// This is not a full XML parser. It reads only the tags it needs, and it ignores CDATA sections
// and comments, so test output inside them cannot look like a tag.
export function parseJUnit(xml) {
  const text = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  if (!/<testsuites?\b/.test(text)) throw new Error('it is not JUnit XML: it has no <testsuites> or <testsuite> tag');
  const cases = [];
  let current = null;
  // An attribute value can hold a ">" (node:test writes one), so a quoted value is read whole.
  for (const [, closing, tag, attrs, selfClosing] of text.matchAll(/<(\/?)(testcase|failure|error|skipped)\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g)) {
    if (tag === 'testcase') {
      if (closing) {
        current = null;
        continue;
      }
      const a = attributes(attrs);
      current = { name: a.name ?? '', classname: a.classname ?? '', file: a.file ?? '', status: 'passed' };
      cases.push(current);
      if (selfClosing) current = null;
    } else if (current && !closing) {
      if (tag === 'skipped') {
        if (current.status === 'passed') current.status = 'skipped';
      } else {
        current.status = 'failed';
      }
    }
  }
  return cases;
}

function attributes(text) {
  const out = {};
  for (const [, name, double, single] of text.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[name] = decode(double ?? single);
  return out;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(text) {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, code) => {
    if (code[0] !== '#') return ENTITIES[code] ?? whole;
    const point = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return point <= 0x10ffff ? String.fromCodePoint(point) : whole;
  });
}
