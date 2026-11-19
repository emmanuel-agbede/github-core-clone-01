// rest.ts — the REST v3 surface: repositories, contents, branches, refs, commits, labels, issues,
// comments and pull requests, with GitHub's status codes, JSON shapes and Link-header pagination.
// Everything reads and writes the shared store (store.ts), so the git, GraphQL and MCP surfaces see
// exactly the objects created here.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseCommit } from './gitobj.ts';
import {
  VIEWER_ID,
  VIEWER_LOGIN,
  allocCommentId,
  allocIssueId,
  ancestorsOf,
  branchTip,
  commitFiles,
  createRepo,
  deleteRepo,
  filesAtCommit,
  findRepo,
  flattenTree,
  getObject,
  globalId,
  isoOf,
  mergeBase,
  nextTime,
  pullMergeable,
  putObject,
  renameRepo,
  reposOf,
  resolveCommit,
  squashMerge,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import { decodeSegment, parseJsonBody, sendEmpty, sendJson } from './http.ts';

// ------------------------------------------------------------------ shapes

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    default_branch: repo.defaultBranch,
    created_at: isoOf(repo.createdAt),
    updated_at: isoOf(repo.createdAt),
    pushed_at: isoOf(repo.createdAt),
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? '000000', description: label?.description ?? null };
    }),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    comments: issue.comments.length,
    created_at: isoOf(issue.createdAt),
    updated_at: isoOf(issue.updatedAt),
    closed_at: issue.closedAt === null ? null : isoOf(issue.closedAt),
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = branchTip(repo, pull.headRef);
  const baseSha = branchTip(repo, pull.baseRef);
  return {
    id: pull.id,
    node_id: globalId('PullRequest', pull.id),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    head: {
      ref: pull.headRef,
      sha: headSha ?? '',
      label: `${repo.owner}:${pull.headRef}`,
      repo: repoJson(repo),
    },
    base: {
      ref: pull.baseRef,
      sha: baseSha ?? '',
      label: `${repo.owner}:${pull.baseRef}`,
      repo: repoJson(repo),
    },
    merged: pull.merged,
    merged_at: pull.mergedAt === null ? null : isoOf(pull.mergedAt),
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open' ? pullMergeable(repo, pull) : null,
    created_at: isoOf(pull.createdAt),
    updated_at: isoOf(pull.updatedAt),
  };
}

function commitJson(repo: Repo, oid: string): Record<string, unknown> {
  const object = getObject(repo, oid)!;
  const info = parseCommit(object.data);
  const stamp = (line: string): { name: string; email: string; date: string } => {
    const match = /^(.*) <(.*)> (\d+) /.exec(line);
    return { name: match?.[1] ?? '', email: match?.[2] ?? '', date: isoOf(Number(match?.[3] ?? 0)) };
  };
  const text = object.data.toString('utf8');
  const authorLine = /^author (.*)$/m.exec(text)?.[1] ?? '';
  const committerLine = /^committer (.*)$/m.exec(text)?.[1] ?? '';
  return {
    sha: oid,
    node_id: globalId('Commit', repo.id * 1000000 + (parseInt(oid.slice(0, 6), 16) % 1000000)),
    commit: {
      message: info.message.replace(/\n$/, ''),
      tree: { sha: info.tree },
      author: stamp(authorLine),
      committer: stamp(committerLine),
    },
    parents: info.parents.map((sha) => ({ sha })),
    author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    committer: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
  };
}

// ------------------------------------------------------------------ helpers

interface Page {
  page: number;
  perPage: number;
}

function pageOf(url: URL): Page {
  const perPageRaw = Number(url.searchParams.get('per_page') ?? '30');
  const pageRaw = Number(url.searchParams.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  return { page, perPage };
}

/** Slice a list for the page and build the Link header GitHub sends (rel next/last/first/prev). */
function paginate<T>(req: IncomingMessage, url: URL, items: T[]): { slice: T[]; headers: Record<string, string> } {
  const { page, perPage } = pageOf(url);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const host = req.headers.host ?? 'localhost';
  const base = `http://${host}${url.pathname}`;
  const linkFor = (p: number, rel: string): string => `<${base}?page=${p}&per_page=${perPage}>; rel="${rel}"`;
  const links: string[] = [];
  if (page < totalPages) {
    links.push(linkFor(page + 1, 'next'));
    links.push(linkFor(totalPages, 'last'));
  }
  if (page > 1) {
    links.push(linkFor(1, 'first'));
    links.push(linkFor(page - 1, 'prev'));
  }
  return { slice, headers: links.length > 0 ? { link: links.join(', ') } : {} };
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

function unprocessable(res: ServerResponse, message: string): void {
  sendJson(res, 422, { message });
}

/** The repository a /repos/{owner}/{repo} route names, answering 404 (never 403) when it is not the owner's. */
function repoOr404(res: ServerResponse, owner: string, name: string): Repo | null {
  const repo = findRepo(owner, name);
  if (repo === null || repo.owner !== owner) {
    notFound(res);
    return null;
  }
  return repo;
}

/** Line counts of a change between two file bodies, via a longest-common-subsequence over lines. */
function lineDiff(oldText: string | null, newText: string | null): { additions: number; deletions: number } {
  const oldLines = oldText === null ? [] : oldText.split('\n');
  const newLines = newText === null ? [] : newText.split('\n');
  if (oldText !== null && oldText.endsWith('\n')) oldLines.pop();
  if (newText !== null && newText.endsWith('\n')) newLines.pop();
  const m = oldLines.length;
  const n = newLines.length;
  // LCS lengths over lines (files in this forge are small).
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i]![j] = oldLines[i] === newLines[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const common = dp[0]![0]!;
  return { additions: n - common, deletions: m - common };
}

function blobText(repo: Repo, oid: string | undefined): string | null {
  if (oid === undefined) return null;
  const object = getObject(repo, oid);
  return object === null ? null : object.data.toString('utf8');
}

// ------------------------------------------------------------------ route handlers

function createRepository(res: ServerResponse, body: Record<string, unknown>): void {
  const name = typeof body.name === 'string' ? body.name : '';
  if (name === '' || name.includes('/') || name.length > 100) {
    unprocessable(res, 'Repository creation failed: name is invalid');
    return;
  }
  if (findRepo(VIEWER_LOGIN, name) !== null) {
    unprocessable(res, 'Repository creation failed: name already exists on this account');
    return;
  }
  const repo = createRepo(
    VIEWER_LOGIN,
    name,
    typeof body.description === 'string' ? body.description : '',
    body.private === true,
  );
  sendJson(res, 201, repoJson(repo));
}

function contentsGet(res: ServerResponse, repo: Repo, path: string, url: URL): void {
  const ref = url.searchParams.get('ref') ?? repo.defaultBranch;
  const commit = resolveCommit(repo, ref);
  const files = filesAtCommit(repo, commit);
  const clean = path.replace(/^\/+|\/+$/g, '');
  if (clean !== '' && files.has(clean)) {
    const oid = files.get(clean)!;
    const object = getObject(repo, oid)!;
    const name = clean.split('/').pop()!;
    sendJson(res, 200, {
      type: 'file',
      name,
      path: clean,
      sha: oid,
      size: object.data.length,
      encoding: 'base64',
      content: object.data.toString('base64'),
    });
    return;
  }
  // A directory listing: the root, or any path that prefixes stored files.
  const prefix = clean === '' ? '' : `${clean}/`;
  const dirs = new Map<string, string>();
  const entries: Record<string, unknown>[] = [];
  const seenFiles = new Set<string>();
  for (const [filePath, oid] of files) {
    if (!filePath.startsWith(prefix)) continue;
    const rest = filePath.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      if (!seenFiles.has(rest)) {
        seenFiles.add(rest);
        entries.push({ type: 'file', name: rest, path: filePath, sha: oid, size: getObject(repo, oid)?.data.length ?? 0 });
      }
    } else {
      const dir = rest.slice(0, slash);
      if (!dirs.has(dir)) {
        // The directory's tree oid: recompute from the commit's tree when possible.
        dirs.set(dir, subtreeOid(repo, commit, prefix + dir) ?? oid);
      }
    }
  }
  for (const [dir, oid] of dirs) entries.push({ type: 'dir', name: dir, path: prefix + dir, sha: oid, size: 0 });
  if (clean === '' || entries.length > 0) {
    entries.sort((a, b) => String(a.name) < String(b.name) ? -1 : 1);
    sendJson(res, 200, entries);
    return;
  }
  notFound(res);
}

/** The tree oid at a directory path under a commit, or null. */
function subtreeOid(repo: Repo, commit: string | null, dirPath: string): string | null {
  if (commit === null) return null;
  const commitObject = getObject(repo, commit);
  if (commitObject === null) return null;
  let tree = parseCommit(commitObject.data).tree;
  for (const part of dirPath.split('/').filter((p) => p !== '')) {
    const treeObject = getObject(repo, tree);
    if (treeObject === null || treeObject.type !== 'tree') return null;
    const entries = flattenTreeEntries(treeObject.data);
    const found = entries.find((e) => e.name === part && e.mode === '40000');
    if (found === undefined) return null;
    tree = found.oid;
  }
  return tree;
}

function flattenTreeEntries(data: Buffer): { mode: string; name: string; oid: string }[] {
  const entries: { mode: string; name: string; oid: string }[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const nul = data.indexOf(0x00, space);
    entries.push({ mode: data.toString('utf8', pos, space), name: data.toString('utf8', space + 1, nul), oid: data.toString('hex', nul + 1, nul + 21) });
    pos = nul + 21;
  }
  return entries;
}

/** Resolve the branch a contents write targets, creating it (from the default tip) when absent. */
function writeBranch(repo: Repo, branch: string | undefined): { branch: string; tip: string | null } | null {
  const target = branch ?? repo.defaultBranch;
  const tip = branchTip(repo, target);
  if (tip !== null) return { branch: target, tip };
  if (repo.refs.has(`refs/heads/${target}`)) return { branch: target, tip: null };
  const defaultTip = branchTip(repo, repo.defaultBranch);
  if (defaultTip === null) {
    // A wholly empty repository: the target branch is born with this commit.
    return { branch: target, tip: null };
  }
  repo.refs.set(`refs/heads/${target}`, defaultTip);
  return { branch: target, tip: defaultTip };
}

function contentsPut(res: ServerResponse, repo: Repo, path: string, body: Record<string, unknown>): void {
  const clean = path.replace(/^\/+|\/+$/g, '');
  if (clean === '') {
    unprocessable(res, 'Invalid request: a file path is required');
    return;
  }
  const contentB64 = typeof body.content === 'string' ? body.content : '';
  const message = typeof body.message === 'string' && body.message !== '' ? body.message : `Update ${clean}`;
  const target = writeBranch(repo, typeof body.branch === 'string' ? body.branch : undefined);
  if (target === null) {
    unprocessable(res, 'Invalid request: branch cannot be created');
    return;
  }
  const files = filesAtCommit(repo, target.tip);
  const existing = files.get(clean);
  const providedSha = typeof body.sha === 'string' ? body.sha : undefined;
  if (existing !== undefined && providedSha !== undefined && providedSha !== existing) {
    sendJson(res, 409, { message: 'Conflict: the file sha does not match the current content' });
    return;
  }
  const data = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
  const blobOid = putObject(repo, 'blob', data);
  files.set(clean, blobOid);
  const commit = commitFiles(repo, target.tip, files, message);
  repo.refs.set(`refs/heads/${target.branch}`, commit);
  const created = existing === undefined;
  sendJson(res, created ? 201 : 200, {
    content: {
      type: 'file',
      name: clean.split('/').pop()!,
      path: clean,
      sha: blobOid,
      size: data.length,
      encoding: 'base64',
    },
    commit: { sha: commit, message },
  });
}

function contentsDelete(res: ServerResponse, repo: Repo, path: string, body: Record<string, unknown>): void {
  const clean = path.replace(/^\/+|\/+$/g, '');
  const target = writeBranch(repo, typeof body.branch === 'string' ? body.branch : undefined);
  if (target === null || target.tip === null) {
    notFound(res);
    return;
  }
  const files = filesAtCommit(repo, target.tip);
  const existing = files.get(clean);
  if (existing === undefined) {
    notFound(res);
    return;
  }
  const providedSha = typeof body.sha === 'string' ? body.sha : undefined;
  if (providedSha !== undefined && providedSha !== existing) {
    sendJson(res, 409, { message: 'Conflict: the file sha does not match the current content' });
    return;
  }
  const message = typeof body.message === 'string' && body.message !== '' ? body.message : `Delete ${clean}`;
  files.delete(clean);
  const commit = commitFiles(repo, target.tip, files, message);
  repo.refs.set(`refs/heads/${target.branch}`, commit);
  sendJson(res, 200, { content: null, commit: { sha: commit, message } });
}

// ------------------------------------------------------------------ the router

/** Handle one /api/v3 request (auth has already been checked by the caller). */
export function handleRest(req: IncomingMessage, res: ServerResponse, url: URL, rawBody: Buffer): void {
  const method = req.method ?? 'GET';
  const segments = url.pathname.split('/').filter((s) => s !== '').map(decodeSegment);
  // segments[0] is 'api', segments[1] is 'v3'.
  const rest = segments.slice(2);
  const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  let body: Record<string, unknown> = {};
  if (needsBody && rawBody.length > 0) {
    const parsed = parseJsonBody(rawBody);
    if (!parsed.ok) {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return;
    }
    body = parsed.value;
  } else if (needsBody && (method === 'POST' || method === 'PUT' || method === 'PATCH') && rawBody.length === 0) {
    // An empty body on a write is malformed for the routes that need fields; routes that accept an
    // empty body (merge) handle it themselves. Keep {} and let validation speak.
    body = {};
  }

  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        rate_limit_url: '/api/v3/rate_limit',
      }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }
    notFound(res);
    return;
  }
  if (rest[0] === 'meta' && method === 'GET') {
    sendJson(res, 200, { verifiable_password_authentication: false, installed_version: '1.0.0-forge', github_services_sha: 'forge' });
    return;
  }
  if (rest[0] === 'rate_limit' && method === 'GET') {
    sendJson(res, 200, { rate: { limit: 5000, remaining: 5000, reset: 0, used: 0 }, resources: {} });
    return;
  }
  if (rest[0] === 'user' && rest.length === 1 && method === 'GET') {
    sendJson(res, 200, { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User', name: 'Ada Iversen' });
    return;
  }
  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'GET') {
      const { slice, headers } = paginate(req, url, reposOf(VIEWER_LOGIN).map(repoJson));
      sendJson(res, 200, slice, headers);
      return;
    }
    if (method === 'POST') {
      createRepository(res, body);
      return;
    }
  }
  if (rest[0] !== 'repos' || rest.length < 3) {
    notFound(res);
    return;
  }
  const owner = rest[1]!;
  const name = rest[2]!;
  const tail = rest.slice(3);
  const repo = repoOr404(res, owner, name);
  if (repo === null) return;

  if (tail.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      if (typeof body.name === 'string' && body.name !== '' && !body.name.includes('/') && body.name !== repo.name) {
        if (findRepo(repo.owner, body.name) === null) renameRepo(repo, body.name);
      }
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      deleteRepo(repo);
      sendEmpty(res, 204);
      return;
    }
    notFound(res);
    return;
  }

  const head = tail[0]!;

  if (head === 'contents') {
    const path = tail.slice(1).join('/');
    if (method === 'GET') {
      contentsGet(res, repo, path, url);
      return;
    }
    if (method === 'PUT') {
      contentsPut(res, repo, path, body);
      return;
    }
    if (method === 'DELETE') {
      contentsDelete(res, repo, path, body);
      return;
    }
    notFound(res);
    return;
  }

  if (head === 'branches') {
    if (tail.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((branch) => ({ name: branch, commit: { sha: repo.refs.get(`refs/heads/${branch}`)! }, protected: false }));
      const { slice, headers } = paginate(req, url, branches);
      sendJson(res, 200, slice, headers);
      return;
    }
    if (tail.length >= 2 && method === 'GET') {
      const branch = tail.slice(1).join('/');
      const tip = repo.refs.get(`refs/heads/${branch}`);
      if (tip === undefined) {
        notFound(res);
        return;
      }
      sendJson(res, 200, { name: branch, commit: commitJson(repo, tip), protected: false });
      return;
    }
    notFound(res);
    return;
  }

  if (head === 'git' && tail[1] === 'refs') {
    if (tail.length === 2 && method === 'POST') {
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/') || getObject(repo, sha) === null) {
        unprocessable(res, 'Invalid request: ref or sha is invalid');
        return;
      }
      if (repo.refs.has(ref)) {
        unprocessable(res, 'Reference already exists');
        return;
      }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, node_id: globalId('Ref', repo.id), object: { sha, type: getObject(repo, sha)!.type } });
      return;
    }
    if (tail.length >= 3) {
      const ref = `refs/${tail.slice(2).join('/')}`;
      if (method === 'GET') {
        const oid = repo.refs.get(ref);
        if (oid === undefined) {
          notFound(res);
          return;
        }
        sendJson(res, 200, { ref, node_id: globalId('Ref', repo.id), object: { sha: oid, type: getObject(repo, oid)?.type ?? 'commit' } });
        return;
      }
      if (method === 'DELETE') {
        if (!repo.refs.has(ref)) {
          notFound(res);
          return;
        }
        repo.refs.delete(ref);
        sendEmpty(res, 204);
        return;
      }
    }
    notFound(res);
    return;
  }

  if (head === 'commits') {
    if (tail.length === 1 && method === 'GET') {
      const shaParam = url.searchParams.get('sha') ?? repo.defaultBranch;
      const tip = resolveCommit(repo, shaParam);
      if (tip === null) {
        sendJson(res, 200, []);
        return;
      }
      const list = ancestorsOf(repo, tip).map((oid) => commitJson(repo, oid));
      const { slice, headers } = paginate(req, url, list);
      sendJson(res, 200, slice, headers);
      return;
    }
    if (tail.length === 2 && method === 'GET') {
      const oid = tail[1]!;
      const object = getObject(repo, oid);
      if (object === null || object.type !== 'commit') {
        notFound(res);
        return;
      }
      sendJson(res, 200, commitJson(repo, oid));
      return;
    }
    notFound(res);
    return;
  }

  if (head === 'labels') {
    if (tail.length === 1) {
      if (method === 'GET') {
        const labels = [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: label.description }));
        sendJson(res, 200, labels);
        return;
      }
      if (method === 'POST') {
        const labelName = typeof body.name === 'string' ? body.name : '';
        if (labelName === '') {
          unprocessable(res, 'Invalid request: a label name is required');
          return;
        }
        if (repo.labels.has(labelName)) {
          unprocessable(res, 'Validation Failed: label already exists');
          return;
        }
        const label = {
          name: labelName,
          color: typeof body.color === 'string' ? body.color.replace(/^#/, '') : '000000',
          description: typeof body.description === 'string' ? body.description : null,
        };
        repo.labels.set(labelName, label);
        sendJson(res, 201, label);
        return;
      }
    }
    if (tail.length === 2 && method === 'GET') {
      const label = repo.labels.get(tail[1]!);
      if (label === undefined) {
        notFound(res);
        return;
      }
      sendJson(res, 200, { name: label.name, color: label.color, description: label.description });
      return;
    }
    notFound(res);
    return;
  }

  if (head === 'issues') {
    if (tail.length === 1) {
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        let list = [...repo.issues.values()];
        if (state === 'open' || state === 'closed') list = list.filter((issue) => issue.state === state);
        const direction = url.searchParams.get('direction') ?? 'desc';
        list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        const { slice, headers } = paginate(req, url, list.map((issue) => issueJson(repo, issue)));
        sendJson(res, 200, slice, headers);
        return;
      }
      if (method === 'POST') {
        const title = typeof body.title === 'string' ? body.title : '';
        if (title === '') {
          unprocessable(res, 'Invalid request: a title is required');
          return;
        }
        const labelNames = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
        for (const labelName of labelNames) {
          if (!repo.labels.has(labelName)) {
            unprocessable(res, `Validation Failed: label "${labelName}" does not exist`);
            return;
          }
        }
        const now = nextTime();
        const issue: Issue = {
          number: repo.nextNumber,
          id: allocIssueId(),
          title,
          body: typeof body.body === 'string' ? body.body : '',
          state: 'open',
          labels: labelNames,
          comments: [],
          createdAt: now,
          updatedAt: now,
          closedAt: null,
        };
        repo.nextNumber += 1;
        repo.issues.set(issue.number, issue);
        sendJson(res, 201, issueJson(repo, issue));
        return;
      }
    }
    if (tail.length >= 2) {
      const number = Number(tail[1]);
      const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
      if (tail.length === 2) {
        if (issue === undefined) {
          notFound(res);
          return;
        }
        if (method === 'GET') {
          sendJson(res, 200, issueJson(repo, issue));
          return;
        }
        if (method === 'PATCH') {
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          if (Array.isArray(body.labels)) {
            const labelNames = body.labels.filter((l): l is string => typeof l === 'string');
            for (const labelName of labelNames) {
              if (!repo.labels.has(labelName)) {
                unprocessable(res, `Validation Failed: label "${labelName}" does not exist`);
                return;
              }
            }
            issue.labels = labelNames;
          }
          if (body.state === 'closed' || body.state === 'open') {
            issue.state = body.state;
            issue.closedAt = body.state === 'closed' ? nextTime() : null;
          }
          issue.updatedAt = nextTime();
          sendJson(res, 200, issueJson(repo, issue));
          return;
        }
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (issue === undefined) {
          notFound(res);
          return;
        }
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((comment) => ({
            id: comment.id,
            body: comment.body,
            user: { login: comment.author, id: VIEWER_ID, type: 'User' },
            created_at: isoOf(comment.createdAt),
            updated_at: isoOf(comment.createdAt),
          })));
          return;
        }
        if (method === 'POST') {
          const text = typeof body.body === 'string' ? body.body : '';
          if (text === '') {
            unprocessable(res, 'Invalid request: a comment body is required');
            return;
          }
          const comment = { id: allocCommentId(), body: text, author: VIEWER_LOGIN, createdAt: nextTime() };
          issue.comments.push(comment);
          sendJson(res, 201, {
            id: comment.id,
            body: comment.body,
            user: { login: comment.author, id: VIEWER_ID, type: 'User' },
            created_at: isoOf(comment.createdAt),
            updated_at: isoOf(comment.createdAt),
          });
          return;
        }
      }
    }
    notFound(res);
    return;
  }

  if (head === 'pulls') {
    if (tail.length === 1) {
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        let list = [...repo.pulls.values()];
        if (state === 'open') list = list.filter((pull) => pull.state === 'open');
        else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
        list.sort((a, b) => b.number - a.number);
        const { slice, headers } = paginate(req, url, list.map((pull) => pullJson(repo, pull)));
        sendJson(res, 200, slice, headers);
        return;
      }
      if (method === 'POST') {
        createPull(res, repo, body);
        return;
      }
    }
    if (tail.length >= 2) {
      const number = Number(tail[1]);
      const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
      if (tail.length === 2) {
        if (pull === undefined) {
          notFound(res);
          return;
        }
        if (method === 'GET') {
          sendJson(res, 200, pullJson(repo, pull));
          return;
        }
        if (method === 'PATCH') {
          if (body.state === 'closed' || body.state === 'open') {
            pull.state = body.state;
            pull.updatedAt = nextTime();
          }
          if (typeof body.title === 'string') pull.title = body.title;
          if (typeof body.body === 'string') pull.body = body.body;
          sendJson(res, 200, pullJson(repo, pull));
          return;
        }
      }
      if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
        if (pull === undefined) {
          notFound(res);
          return;
        }
        sendJson(res, 200, pullFiles(repo, pull));
        return;
      }
      if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
        if (pull === undefined) {
          notFound(res);
          return;
        }
        if (pull.state !== 'open' || pull.merged) {
          sendJson(res, 405, { message: 'Pull Request is not mergeable' });
          return;
        }
        const sha = squashMerge(repo, pull);
        if (sha === null) {
          sendJson(res, 405, { message: 'Pull Request is not mergeable: merge conflict' });
          return;
        }
        sendJson(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
        return;
      }
    }
    notFound(res);
    return;
  }

  notFound(res);
}

// ------------------------------------------------------------------ pull helpers

/** Strip an "owner:" prefix gh sometimes puts on a head ref. */
function plainRef(ref: string): string {
  const colon = ref.indexOf(':');
  return colon === -1 ? ref : ref.slice(colon + 1);
}

export function createPull(res: ServerResponse, repo: Repo, body: Record<string, unknown>): void {
  const title = typeof body.title === 'string' ? body.title : '';
  const head = plainRef(typeof body.head === 'string' ? body.head : '');
  const base = plainRef(typeof body.base === 'string' ? body.base : repo.defaultBranch);
  if (title === '' || head === '') {
    unprocessable(res, 'Invalid request: title and head are required');
    return;
  }
  if (branchTip(repo, head) === null) {
    unprocessable(res, `Validation Failed: head branch "${head}" does not exist`);
    return;
  }
  if (branchTip(repo, base) === null) {
    unprocessable(res, `Validation Failed: base branch "${base}" does not exist`);
    return;
  }
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
      unprocessable(res, `Validation Failed: a pull request from "${head}" into "${base}" already exists`);
      return;
    }
  }
  const now = nextTime();
  const pull: Pull = {
    number: repo.nextNumber,
    id: allocIssueId(),
    title,
    body: typeof body.body === 'string' ? body.body : '',
    state: 'open',
    headRef: head,
    baseRef: base,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    createdAt: now,
    updatedAt: now,
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  sendJson(res, 201, pullJson(repo, pull));
}

/** The changed-file list between a pull request's merge base and its head tip. */
export function pullFiles(repo: Repo, pull: Pull): Record<string, unknown>[] {
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (baseTip === null || headTip === null) return [];
  const base = mergeBase(repo, baseTip, headTip) ?? baseTip;
  const before = filesAtCommit(repo, base);
  const after = filesAtCommit(repo, headTip);
  const paths = new Set([...before.keys(), ...after.keys()]);
  const files: Record<string, unknown>[] = [];
  for (const path of [...paths].sort()) {
    const oldOid = before.get(path);
    const newOid = after.get(path);
    if (oldOid === newOid) continue;
    const { additions, deletions } = lineDiff(blobText(repo, oldOid), blobText(repo, newOid));
    files.push({
      filename: path,
      status: oldOid === undefined ? 'added' : newOid === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
      sha: newOid ?? oldOid ?? '',
    });
  }
  return files;
}
