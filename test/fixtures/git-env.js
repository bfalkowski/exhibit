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
