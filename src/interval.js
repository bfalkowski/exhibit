// The 95% interval for a share of k successes in n tries (spec section 15: every number comes with
// its n and its interval). It is the exact Clopper-Pearson interval, the same kind spec 9.10 uses.
// It never claims more than the data shows, which matters with the small n that Exhibit often has.

const TAIL = 0.025;

// Returns { low, high } for k of n, with 0 <= k <= n and n >= 1.
export function clopperPearson(k, n) {
  // low is the share p at which k or more successes have a chance of 2.5%.
  const low = k === 0 ? 0 : solve((p) => 1 - atMost(k - 1, n, p));
  // high is the share p at which k or fewer successes have a chance of 2.5%.
  const high = k === n ? 1 : solve((p) => atMost(k, n, p));
  return { low, high };
}

// Finds p in (0, 1) where tail(p) is 2.5%. `tail` must move one way only as p grows, which both
// binomial tails do, so halving the range is enough.
function solve(tail) {
  let lo = 0;
  let hi = 1;
  const rising = tail(0.75) > tail(0.25);
  for (let step = 0; step < 100; step += 1) {
    const mid = (lo + hi) / 2;
    if ((tail(mid) < TAIL) === rising) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// The chance of k or fewer successes in n tries, each with chance p. Sums in logs, so a large n
// does not overflow.
function atMost(k, n, p) {
  let sum = 0;
  for (let i = 0; i <= k; i += 1) sum += Math.exp(logChoose(n, i) + i * Math.log(p) + (n - i) * Math.log(1 - p));
  return Math.min(sum, 1);
}

function logChoose(n, i) {
  let total = 0;
  for (let j = 1; j <= i; j += 1) total += Math.log(n - i + j) - Math.log(j);
  return total;
}
