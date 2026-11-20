import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ToolError } from './tool-error.js';

// Writes each [name, text] of `files` in `cwd`, so the files keep the same facts. It writes every
// file to a temporary file first, and renames them only when all the writes worked. So a failed
// write, as on a full disk, leaves all the older files as they were, and no temporary file.
// exhibit history writes its history and report with it, and exhibit backtest must too (spec 8.5).
export async function writeTogether(cwd, files) {
  const temporaries = [];
  try {
    for (const [name, text] of files) {
      const path = join(cwd, name);
      const temporary = `${path}.${process.pid}.tmp`;
      try {
        await mkdir(join(path, '..'), { recursive: true });
        temporaries.push(temporary);
        await writeFile(temporary, text);
      } catch (error) {
        throw new ToolError(`could not write ${name}: ${error.message}`);
      }
    }
    for (const [index, [name]] of files.entries()) {
      try {
        await rename(temporaries[index], join(cwd, name));
      } catch (error) {
        throw new ToolError(`could not write ${name}: ${error.message}`);
      }
    }
  } catch (error) {
    // A rename that fails after an earlier one worked still leaves a mix. A rename needs no free
    // space, so this is rare. Best effort: when the folder itself is the problem, removing a
    // temporary file fails too.
    await Promise.all(temporaries.map((temporary) => rm(temporary, { force: true }).catch(() => {})));
    throw error;
  }
}
