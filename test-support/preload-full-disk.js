// Loaded with `node --import` in CLI tests, after preload-replay-fetch.js. A write to a path that
// holds the text in EXHIBIT_TEST_FULL_DISK fails as it would on a full disk (ENOSPC). Other writes
// go through as usual.
import { createRequire, syncBuiltinESMExports } from 'node:module';

const require = createRequire(import.meta.url);
const fs = require('node:fs/promises');
const writeFile = fs.writeFile;
const failOn = process.env.EXHIBIT_TEST_FULL_DISK;

fs.writeFile = async (path, ...rest) => {
  if (failOn && String(path).includes(failOn)) {
    throw Object.assign(new Error(`ENOSPC: no space left on device, write '${path}'`), { code: 'ENOSPC' });
  }
  return writeFile(path, ...rest);
};
// Makes `import { writeFile } from 'node:fs/promises'` see the new function too.
syncBuiltinESMExports();
