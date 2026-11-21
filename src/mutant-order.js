import { createHash } from 'node:crypto';

// Puts `list` in a random order, in place, and gives it back (spec 9.5). The `seed`, such as the
// head SHA, fixes the order: the same seed and the same list give the same order each time.
//
// Stryker tests the mutants in the order of the code. When the budget stops it, a sample in that
// order holds the first changed lines and not the last. In a random order, the mutants that
// Stryker finished are a random sample of all of them, as the 95% interval needs.
//
// It is a Fisher-Yates shuffle. Each random number is the first 6 bytes of the SHA-256 of the seed
// and the step, so it needs no state, and it is the same in every version of Node.
export function shuffleBySeed(list, seed) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random(seed, i) * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

// A number from 0 up to, but not including, 1, fixed by the seed and the step.
function random(seed, step) {
  return createHash('sha256').update(`${seed}\n${step}`).digest().readUIntBE(0, 6) / 2 ** 48;
}
