// An error the person can fix: a missing token, a bad repo name, an API that said no.
// The CLI prints its message and exits 2. Any other error is a bug in Exhibit.
export class ToolError extends Error {
  name = 'ToolError';
}

// The text the CLI prints for a failure, after "exhibit: ". A ToolError gives its message. Any
// other error is a bug in Exhibit, and the text says so and gives the stack.
export function describeError(error) {
  if (error instanceof ToolError) return error.message;
  return `an unexpected error, which is a bug in Exhibit:\n${error?.stack ?? error}`;
}
