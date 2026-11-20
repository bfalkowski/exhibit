// The 95% interval for a share of k successes in n tries (spec section 15: every number comes with
// its n and its interval). It is the exact Clopper-Pearson interval, the same kind spec 9.10 uses.
// It never claims more than the data shows, which matters with the small n that Exhibit often has.

const TAIL = 0.025;

// Returns { low, high } for k of n, with 0 <= k <= n and n >= 1.
export function clopperPearson(k, n) {
  const logChoose = logChooseTable(n);
  // The chance of i successes in n tries, each with chance p, summed over i from `from` to `to`.
  // Each tail is its own sum, so a tiny tail is not lost by taking it away from a sum near 1.
  const sum = (from, to, p) => {
    let total = 0;
    for (let i = from; i <= to; i += 1) total += Math.exp(logChoose[i] + i * Math.log(p) + (n - i) * Math.log(1 - p));
    return total;
  };
  // low is the share p at which k or more successes have a chance of 2.5%. That chance grows with p.
  const low = k === 0 ? 0 : solve((p) => sum(k, n, p), { rising: true });
  // high is the share p at which k or fewer successes have a chance of 2.5%. That chance falls as p grows.
  const high = k === n ? 1 : solve((p) => sum(0, k, p), { rising: false });
  return { low, high };
}

// Finds p in (0, 1) where tail(p) is 2.5%, by halving the range. The caller says which way the
// tail moves as p grows, because a guess from two values fails when both round to 0 or to 1.
function solve(tail, { rising }) {
  let lo = 0;
  let hi = 1;
  for (let step = 0; step < 100; step += 1) {
    const mid = (lo + hi) / 2;
    if ((tail(mid) < TAIL) === rising) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// log(n choose i) for each i from 0 to n, each built from the one before it.
function logChooseTable(n) {
  const table = [0];
  for (let i = 1; i <= n; i += 1) table.push(table[i - 1] + Math.log(n - i + 1) - Math.log(i));
  return table;
}
