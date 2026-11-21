import { ToolError } from './tool-error.js';

// The issue types that count as a bug when settings.jira.issue_types is not set (spec 8.1).
export const DEFAULT_BUG_TYPES = Object.freeze(['Bug']);

// The Jira tracker module's static rules, as GITHUB_FORGE in src/github.js has for the forge. A
// command asks it which env variables hold the token, and how to connect. Another tracker, such
// as Linear or GitHub issues, gives an object with the same fields.
export const JIRA_TRACKER = {
  // The tracker's name in a fix_signal, as in jira:PAY-482, and in the signal tracker:jira.
  name: 'jira',
  // The tracker's name in messages for people.
  displayName: 'Jira',
  // The env variable that holds the token. A token alone is sent as a Bearer token, as a Jira
  // Data Center personal access token is. With an email in emailEnv, the email and the token are
  // sent with Basic auth, as Jira Cloud needs for an API token.
  tokenEnv: 'JIRA_API_TOKEN',
  emailEnv: 'JIRA_EMAIL',

  // Makes the tracker for `settings` (settings.jira of evidence.yml). See createJiraTracker.
  connect(options) {
    return createJiraTracker(options);
  }
};

// Connects the Jira tracker for exhibit history and exhibit check (spec 9.1). It returns
// { tracker, note }. tracker is null when the fix signals do not hold tracker:jira, and null with
// a note when JIRA_API_TOKEN is not set: then the signal matches no PR, and every other signal
// still works. The caller shows the note in one line. Otherwise note is null.
export function connectTracker(settings, { env, fetch }) {
  if (!settings.fix_signals.includes(`tracker:${JIRA_TRACKER.name}`)) return { tracker: null, note: null };
  const token = env[JIRA_TRACKER.tokenEnv];
  if (!token) {
    return { tracker: null, note: `${JIRA_TRACKER.tokenEnv} is not set, so the tracker:jira fix signal matched no PR. Set it to a Jira API token, and for Jira Cloud set ${JIRA_TRACKER.emailEnv} to the email of its account.` };
  }
  return { tracker: JIRA_TRACKER.connect({ settings: settings.jira, token, email: env[JIRA_TRACKER.emailEnv] || undefined, fetch }), note: null };
}

// A reply from Jira that is not OK. `status` is its HTTP status. As for GitHubReplyError, a
// refused token (401), a missing permission (403) or a rate limit (429) stops the run, because
// every later request would fail too. Any other status, such as a 503, is a problem with one
// request: the caller warns and goes on.
export class JiraReplyError extends ToolError {
  constructor(message, status) {
    super(message);
    this.status = status;
  }

  get stopsRun() {
    return [401, 403, 429].includes(this.status);
  }
}

// The Jira tracker: every request that Exhibit sends to Jira, as one method each. Only this module
// builds Jira URLs, so another tracker can come later as a second module with the same methods.
// `settings` is settings.jira: `site` (such as https://acme.atlassian.net), `issue_types` (the
// types that count as a bug, DEFAULT_BUG_TYPES when left out), and `found_field` and
// `escaped_values` (the field that says where a bug was found, and the values that mean it got
// out to users). `token` and `email` come from the env (see JIRA_TRACKER). `fetch` is a parameter,
// so tests can replay recorded replies.
// The methods return small tracker-neutral shapes:
// - ticket(key): { key, bug, createdAt, escaped }, or null when Jira does not know the key.
//   bug says whether the issue type is in issue_types. createdAt is an ISO time in UTC.
//   escaped is false when found_field holds a value and none of its values is in
//   escaped_values, true when one is, and null when Jira has no value or no found_field is set.
// - counts(): { requests, not_found }.
// Each key is asked for once per tracker, so once per run: a second call gets the first answer.
export function createJiraTracker({ settings, token, email, fetch }) {
  const site = settings.site.replace(/\/+$/, '');
  const bugTypes = (settings.issue_types ?? DEFAULT_BUG_TYPES).map((type) => type.toLowerCase());
  const foundField = settings.found_field ?? null;
  const escapedValues = (settings.escaped_values ?? []).map((value) => value.toLowerCase());
  const fields = ['issuetype', 'created', ...(foundField ? [foundField] : [])].join(',');
  const authorization = email ? `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}` : `Bearer ${token}`;
  const counts = { requests: 0, not_found: 0 };
  const asked = new Map();

  async function ask(key) {
    const path = `/rest/api/2/issue/${encodeURIComponent(key)}`;
    let response;
    try {
      response = await fetch(`${site}${path}?fields=${fields}`, { headers: { accept: 'application/json', authorization, 'user-agent': 'exhibit' } });
    } catch (error) {
      throw new ToolError(`could not reach Jira at ${site} (${error.message}). Check settings.jira.site in evidence.yml and the network, and try again.`);
    }
    counts.requests++;
    if (response.status === 404) {
      counts.not_found++;
      return null;
    }
    if (!response.ok) throw await replyError(response, path);
    const issue = await jsonOf(response);
    const type = issue?.fields?.issuetype?.name;
    const created = Date.parse(issue?.fields?.created);
    if (typeof type !== 'string' || Number.isNaN(created)) {
      throw new ToolError(`Jira sent a reply with no issue type or created date for ${path}. Check settings.jira.site in evidence.yml.`);
    }
    return {
      key,
      bug: bugTypes.includes(type.toLowerCase()),
      createdAt: new Date(created).toISOString(),
      escaped: foundField ? escapedFrom(issue.fields[foundField], escapedValues) : null
    };
  }

  return {
    name: JIRA_TRACKER.name,
    displayName: JIRA_TRACKER.displayName,
    counts: () => ({ ...counts }),

    async ticket(key) {
      if (!asked.has(key)) asked.set(key, ask(key));
      return asked.get(key);
    }
  };
}

// Says whether a "where found" field value means the bug got out to users. A field can be text,
// a select option ({ value }), an object with a name, or a list of them. No value gives null.
function escapedFrom(value, escapedValues) {
  const values = [value].flat().map((one) => (typeof one === 'string' ? one : one?.value ?? one?.name)).filter((one) => typeof one === 'string');
  if (values.length === 0) return null;
  return values.some((one) => escapedValues.includes(one.toLowerCase()));
}

// Jira's error replies hold errorMessages, a list of texts. The message never holds the token,
// because Exhibit only sends it in a header.
async function replyError(response, path) {
  const body = await jsonOf(response);
  const detail = Array.isArray(body?.errorMessages) ? body.errorMessages.filter((text) => typeof text === 'string').join('; ') : '';
  const what = `Jira answered ${response.status}${detail ? ` (${detail})` : ''} for ${path}`;
  return new JiraReplyError(`${what}.${advice(response.status)}`, response.status);
}

function advice(status) {
  if (status === 401) return ` Jira refused ${JIRA_TRACKER.tokenEnv}: check the token, and for Jira Cloud set ${JIRA_TRACKER.emailEnv} to the email of its account.`;
  if (status === 403) return ` The token may lack access to the issue, or the rate limit is used up: check the token, or wait and try again.`;
  if (status === 429) return " Jira's rate limit is used up: wait and try again.";
  if (status >= 500) return ' Jira had a problem: try again later.';
  return '';
}

async function jsonOf(response) {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}
