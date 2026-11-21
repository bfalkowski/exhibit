// Builds GitHub GraphQL replies for history, in the shape GitHub sends them, from plain PR data.
// The replies use the keys of test-support/replay-fetch.js.
//
// Each PR is { number, url, title, body, author, mergedAt, updatedAt, changedFiles, mergeSha, baseRef,
// baseSha, headRef, headSha, labels, files, reviews, comments, ci }:
// - updatedAt: when the PR was last updated. It is mergedAt when left out.
// - sortedAt: where RecentMergedPulls puts the PR. It is updatedAt when left out. GitHub's order
//   does not always follow updatedAt, and a test can give a PR an older sortedAt to show that.
// - author: { __typename, login }, or null for a deleted account. A review or comment has one too.
// - labels: [{ name }]. files: [{ path, additions, deletions }].
// - reviews: [{ state, submittedAt, author }]. comments: [{ body, createdAt, author }].
// - ci: the status check rollup of the last commit, in GitHub's order: check runs
//   { __typename: 'CheckRun', databaseId, name, conclusion, url } and commit statuses
//   { __typename: 'StatusContext', context, state, targetUrl }, as GitHub gives them, in capitals.
//
// `pullsPerPage` and `itemsPerPage` split the lists into pages, as GitHub does when a list is
// longer than a page. `first` is how many PRs the MergedPulls and RecentMergedPulls queries ask
// for: it is in their keys. It is 50 when left out, the number Exhibit asks for first.
// `pullsPerPage` is `first` when left out. A test can give a smaller `pullsPerPage` and keep
// `first` at 50, for short pages that the run asks for with its usual number. A page that is not the last one has hasNextPage true, and the next page is
// recorded under the query that asks for it with the page's end cursor.

import { graphqlKey } from '../../../test-support/replay-fetch.js';

const LISTS = { labels: 'PullLabels', files: 'PullFiles', reviews: 'PullReviews', comments: 'PullComments' };

// Returns { [key]: reply } for every query that history sends for the repo `repo`.
export function graphqlReplies(repo, pulls, { first = 50, pullsPerPage = first, itemsPerPage = 100 } = {}) {
  const [owner, name] = repo.split('/');
  const replies = {};
  const ok = (data) => ({ status: 200, headers: {}, body: { data: { rateLimit: { cost: 1 }, ...data } } });

  // MergedPulls lists the PRs in the order given. RecentMergedPulls lists them updated last first,
  // as GitHub does, with its own cursors.
  const sorted = (pull) => pull.sortedAt ?? pull.updatedAt ?? pull.mergedAt;
  const byUpdate = [...pulls].sort((a, b) => sorted(b).localeCompare(sorted(a)));
  for (const [query, list, cursor] of [['MergedPulls', pulls, 'pulls'], ['RecentMergedPulls', byUpdate, 'recent']]) {
    const pullPages = chunks(list, pullsPerPage);
    pullPages.forEach((page, index) => {
      const after = index === 0 ? null : `${cursor}-${index}`;
      const pageInfo = { hasNextPage: index < pullPages.length - 1, endCursor: `${cursor}-${index + 1}` };
      const nodes = page.map((pull) => pullNode(pull, itemsPerPage));
      replies[graphqlKey(query, { owner, name, after, first })] = ok({ repository: { pullRequests: { pageInfo, nodes } } });
    });
  }

  for (const pull of pulls) {
    for (const [field, query] of Object.entries(LISTS)) {
      for (const { after, connection } of laterPages(pull[field], itemsPerPage, `${field}-${pull.number}`)) {
        replies[graphqlKey(query, { owner, name, number: pull.number, after })] = ok({ repository: { pullRequest: { [field]: connection } } });
      }
    }
    for (const { after, connection } of laterPages(pull.ci, itemsPerPage, `ci-${pull.number}`)) {
      replies[graphqlKey('CommitCi', { owner, name, oid: pull.headSha, after })] = ok({ repository: { object: { statusCheckRollup: { contexts: connection } } } });
    }
  }
  return replies;
}

function pullNode(pull, itemsPerPage) {
  const first = (field, items) => page(items, itemsPerPage, 0, `${field}-${pull.number}`);
  return {
    number: pull.number,
    url: pull.url,
    title: pull.title,
    // GraphQL gives an empty body as "", where the REST API gives null.
    body: pull.body ?? '',
    mergedAt: pull.mergedAt,
    updatedAt: pull.updatedAt ?? pull.mergedAt,
    changedFiles: pull.changedFiles ?? pull.files.length,
    author: pull.author,
    mergeCommit: { oid: pull.mergeSha },
    baseRefName: pull.baseRef,
    baseRefOid: pull.baseSha,
    headRefName: pull.headRef,
    headRefOid: pull.headSha,
    labels: first('labels', pull.labels),
    files: first('files', pull.files),
    reviews: first('reviews', pull.reviews),
    comments: first('comments', pull.comments),
    // GitHub gives no rollup for a commit with no CI results.
    commits: { nodes: [{ commit: { oid: pull.headSha, statusCheckRollup: pull.ci.length === 0 ? null : { contexts: first('ci', pull.ci) } } }] }
  };
}

// Page `index` of `items`, as a GraphQL connection. Its end cursor is `${prefix}-${index + 1}`.
function page(items, size, index, prefix) {
  const count = Math.max(1, Math.ceil(items.length / size));
  return {
    pageInfo: { hasNextPage: index < count - 1, endCursor: items.length === 0 ? null : `${prefix}-${index + 1}` },
    nodes: items.slice(index * size, (index + 1) * size)
  };
}

// Every page after the first, with the cursor that asks for it.
function laterPages(items, size, prefix) {
  const pages = [];
  for (let index = 1; index * size < items.length; index++) pages.push({ after: `${prefix}-${index}`, connection: page(items, size, index, prefix) });
  return pages;
}

function chunks(items, size) {
  const result = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result.length === 0 ? [[]] : result;
}
