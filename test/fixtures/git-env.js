// A clean env for git, and for a command that runs git, in a test.
//
// It keeps only PATH, and sets HOME to a folder the test owns. It ignores the user's and the
// system's git config, so settings such as diff.noprefix cannot change what git prints.
// Git sets GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE when it runs a hook. They do not get
// through, so npm test in a hook cannot read or write the repo that is being committed.
//
// extra: more variables to set, such as GITHUB_TOKEN.
export function gitEnv(home, extra = {}) {
  return { PATH: process.env.PATH, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...extra };
}

// Removes every GIT_ variable from this process's env, such as the GIT_DIR, GIT_WORK_TREE and
// GIT_INDEX_FILE that git sets for a hook. Call it at the top of a test file that runs src code
// in the same process. That code runs git with process.env, as it must in a real run, where the
// user may set GIT_DIR on purpose. Node runs each test file in its own process, so this changes
// only the file that calls it.
export function dropGitEnv() {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('GIT_')) delete process.env[name];
  }
}
