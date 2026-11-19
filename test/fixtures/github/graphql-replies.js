// Builds GitHub GraphQL replies for history, in the shape GitHub sends them, from plain PR data.
// The replies use the keys of test-support/replay-fetch.js.
//
// Each PR is { number, url, title, body, author, mergedAt, changedFiles, mergeSha, baseRef,
// baseSha, headRef, headSha, labels, files, reviews, comments, ci }:
// - author: { __typename, login }, or null for a deleted account. A review or comment has one too.
// - labels: [{ name }]. files: [{ path, additions, deletions }].
// - reviews: [{ state, submittedAt, author }]. comments: [{ body, createdAt, author }].
// - ci: the status check rollup of the last commit, in GitHub's order: check runs
//   { __typename: 'CheckRun', databaseId, name, conclusion, url } and commit statuses
//   { __typename: 'StatusContext', context, state, targetUrl }, as GitHub gives them, in capitals.
//
// `pullsPerPage` and `itemsPerPage` split the lists into pages, as GitHub does when a list is
// longer than a page. A page that is not the last one has hasNextPage true, and the next page is
// recorded under the query that asks for it with the page's end cursor.

import { graphqlKey } from '../../../test-support/replay-fetch.js';

const LISTS = { labels: 'PullLabels', files: 'PullFiles', reviews: 'PullReviews', comments: 'PullComments' };

// Returns { [key]: reply } for every query that history sends for the repo `repo`.
export function graphqlReplies(repo, pulls, { pullsPerPage = 50, itemsPerPage = 100 } = {}) {
  const [owner, name] = repo.split('/');
  const replies = {};
  const ok = (data) => ({ status: 200, headers: {}, body: { data: { rateLimit: { cost: 1 }, ...data } } });

  const pullPages = chunks(pulls, pullsPerPage);
  pullPages.forEach((page, index) => {
    const after = index === 0 ? null : `pulls-${index}`;
    const pageInfo = { hasNextPage: index < pullPages.length - 1, endCursor: `pulls-${index + 1}` };
    const nodes = page.map((pull) => pullNode(pull, itemsPerPage));
    replies[graphqlKey('MergedPulls', { owner, name, after })] = ok({ repository: { pullRequests: { pageInfo, nodes } } });
  });

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
