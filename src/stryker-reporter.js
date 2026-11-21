import { appendFileSync } from 'node:fs';
import { declareClassPlugin, PluginKind } from '@stryker-mutator/api/plugin';

// A Stryker reporter plugin that Exhibit loads into each Stryker run (src/mutation.js, spec 9.5).
// Stryker loads this file, so Exhibit itself never imports it.
//
// It writes one line of JSON for each mutant to the file that EXHIBIT_MUTANTS_FILE names, as soon
// as Stryker knows the mutant's status. When Stryker has tested every mutant, it writes the line
// {"done":true}. Each write is synchronous, so when the time budget runs out and Exhibit kills
// Stryker, the file still holds every mutant that was done: that is the sample of a partial run.
// A file without the done line comes from a run that did not finish.
class ExhibitReporter {
  static inject = [];

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
