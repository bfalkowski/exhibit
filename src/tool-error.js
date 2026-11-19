// An error the person can fix: a missing token, a bad repo name, an API that said no.
// The CLI prints its message and exits 2. Any other error is a bug in Exhibit.
export class ToolError extends Error {
  name = 'ToolError';
}
