import { appendFileSync } from 'node:fs';
import { declareClassPlugin, PluginKind } from '@stryker-mutator/api/plugin';
import { shuffleBySeed } from './mutant-order.js';

// A Stryker reporter plugin that Exhibit loads into each Stryker run (src/mutation.js, spec 9.5).
// Stryker loads this file, so Exhibit itself never imports it.
//
// It writes one line of JSON for each mutant to the file that EXHIBIT_MUTANTS_FILE names, as soon
// as Stryker knows the mutant's status. When Stryker has tested every mutant, it writes the line
// {"done":true}. Each write is synchronous, so when the time budget runs out and Exhibit kills
// Stryker, the file still holds every mutant that was done: that is the sample of a partial run.
// A file without the done line comes from a run that did not finish.
//
// It also puts the mutants in a random order before Stryker tests them, with the seed that
// EXHIBIT_MUTANT_SEED gives, so that the sample of a partial run is a random sample.
class ExhibitReporter {
  static inject = [];

  // Stryker calls this after its coverage run, with the list of its plans for the mutants, one for
  // each mutant, in the order of the code. Stryker 9.6 then tests the mutants in the order of this
  // same list, so a shuffle in place here changes the order of the tests. Stryker has no option
  // for the order. Stryker still moves the mutants whose code runs when a file loads (static
  // mutants) to the end, because each of them needs every test file in a new process.
  onMutationTestingPlanReady({ mutantPlans }) {
    const seed = process.env.EXHIBIT_MUTANT_SEED;
    if (seed) shuffleBySeed(mutantPlans, seed);
  }

  onMutantTested(result) {
    write({
      fileName: result.fileName,
      location: result.location,
      mutatorName: result.mutatorName,
      replacement: result.replacement,
      status: result.status
    });
  }

  onMutationTestReportReady() {
    write({ done: true });
  }
}

function write(line) {
  const file = process.env.EXHIBIT_MUTANTS_FILE;
  if (file) appendFileSync(file, JSON.stringify(line) + '\n');
}

export const strykerPlugins = [declareClassPlugin(PluginKind.Reporter, 'exhibit', ExhibitReporter)];
