// store.ts — the forge's one in-memory store, shared by the REST, GraphQL, MCP and git surfaces so
// an object created on one surface is the same object on every other. Nothing here reads the wall
// clock or an unseeded random source: timestamps come from a fixed base (MAKEFUN_TRIAL_NOW when the
// harness provides one) advanced by a counter in request order, so the same request sequence always
// produces the same object ids and the same bytes.

import { buildCommit, buildTree, hashObject, parseCommit, parseTree, type GitObject, type ObjectType, type TreeEntry } from './gitobj.ts';

/** The login the suite's token names (the contest scenario's viewer; see the kit's wire.ts). */
export const VIEWER_LOGIN = process.env.MAKEFUN_VIEWER_LOGIN ?? 'adaiversen';
export const VIEWER_ID = 1000;

const AUTHOR_NAME = 'make.fun forge';
const AUTHOR_EMAIL = 'forge@make.fun';

/** The base instant for every timestamp the forge mints, in epoch seconds. */
function baseEpochSec(): number {
  const now = process.env.MAKEFUN_TRIAL_NOW ?? '';
  const parsed = Date.parse(now);
  if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  return 1767225600; // 2026-01-01T00:00:00Z
}

export const BASE_EPOCH = baseEpochSec();
let tick = 0;

/** The next deterministic timestamp, in epoch seconds: base + a request-order counter. */
export function nextTime(): number {
  tick += 1;
  return BASE_EPOCH + tick;
}

/** An ISO timestamp for a deterministic epoch second. */
export function isoOf(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString();
}

// ------------------------------------------------------------------ records

export interface Label {
  name: string;
  color: string;
  description: string | null;
}

export interface Comment {
  id: number;
  body: string;
  author: string;
  createdAt: number;
}

export interface Issue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
}

export interface Pull {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedAt: number | null;
  mergeCommitSha: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextNumber: number;
}

const repos = new Map<string, Repo>();
let nextRepoId = 1;
let nextIssueId = 1;
let nextCommentId = 1;

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function findRepo(owner: string, name: string): Repo | null {
  return repos.get(repoKey(owner, name)) ?? null;
}

export function createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
  const repo: Repo = {
    id: nextRepoId,
    owner,
    name,
    description,
    isPrivate,
    defaultBranch: 'main',
    createdAt: nextTime(),
    objects: new Map(),
    refs: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextNumber: 1,
  };
  nextRepoId += 1;
  repos.set(repoKey(owner, name), repo);
  return repo;
}

export function deleteRepo(repo: Repo): void {
  repos.delete(repoKey(repo.owner, repo.name));
}

/** Move a repository to a new name (same owner, same id). */
export function renameRepo(repo: Repo, newName: string): void {
  repos.delete(repoKey(repo.owner, repo.name));
  repo.name = newName;
  repos.set(repoKey(repo.owner, repo.name), repo);
}

export function reposOf(owner: string): Repo[] {
  return [...repos.values()].filter((repo) => repo.owner === owner).sort((a, b) => a.id - b.id);
}

export function allocIssueId(): number {
  const id = nextIssueId;
  nextIssueId += 1;
  return id;
}

export function allocCommentId(): number {
  const id = nextCommentId;
  nextCommentId += 1;
  return id;
}

// ------------------------------------------------------------------ objects and refs

/** Store an object (idempotent) and answer its id. */
export function putObject(repo: Repo, type: ObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getObject(repo: Repo, oid: string): GitObject | null {
  return repo.objects.get(oid) ?? null;
}

/** The commit a ref or sha names: a branch name, a full ref, or a raw object id. */
export function resolveCommit(repo: Repo, refOrSha: string): string | null {
  if (refOrSha === 'HEAD') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  const byRef = repo.refs.get(refOrSha) ?? repo.refs.get(`refs/heads/${refOrSha}`) ?? repo.refs.get(`refs/tags/${refOrSha}`);
  if (byRef !== undefined) {
    const target = derefToCommit(repo, byRef);
    return target;
  }
  if (/^[0-9a-f]{40}$/.test(refOrSha)) {
    const target = derefToCommit(repo, refOrSha);
    return target;
  }
  return null;
}

/** Follow tag objects to the commit they name (or answer the commit itself). */
export function derefToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 8; hops += 1) {
    const object = repo.objects.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      const match = /^object ([0-9a-f]{40})/m.exec(object.data.toString('utf8'));
      if (match === null) return null;
      current = match[1]!;
      continue;
    }
    return null;
  }
  return null;
}

/** The tip commit of a branch, or null when the branch is unborn or absent. */
export function branchTip(repo: Repo, branch: string): string | null {
  const oid = repo.refs.get(`refs/heads/${branch}`);
  return oid === undefined ? null : derefToCommit(repo, oid);
}

/** Every ancestor of `tip` (including itself), newest first by forge timestamp then discovery order. */
export function ancestorsOf(repo: Repo, tip: string): string[] {
  const seen = new Map<string, number>();
  const queue: string[] = [tip];
  let order = 0;
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    seen.set(oid, order);
    order += 1;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return [...seen.keys()].sort((a, b) => {
    const ta = commitTime(repo, a);
    const tb = commitTime(repo, b);
    if (tb !== ta) return tb - ta;
    return (seen.get(a) ?? 0) - (seen.get(b) ?? 0);
  });
}

export function commitTime(repo: Repo, oid: string): number {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'commit') return 0;
  return parseCommit(object.data).time;
}

/** Whether `ancestor` is `descendant` itself or one of its ancestors. */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  const seen = new Set<string>();
  const queue: string[] = [descendant];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return false;
}

/** A common ancestor of two commits (the first found walking from `b`), or null. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestors = new Set(ancestorsOf(repo, a));
  const seen = new Set<string>();
  const queue: string[] = [b];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestors.has(oid)) return oid;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return null;
}

// ------------------------------------------------------------------ trees as flat file maps

/** Flatten a tree (recursively) into path -> blob oid. */
export function flattenTree(repo: Repo, treeOid: string, prefix = '', out = new Map<string, string>()): Map<string, string> {
  const object = repo.objects.get(treeOid);
  if (object === undefined || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, entry.oid);
  }
  return out;
}

/** The files at a commit (empty map for a null commit). */
export function filesAtCommit(repo: Repo, commitOid: string | null): Map<string, string> {
  if (commitOid === null) return new Map();
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return new Map();
  return flattenTree(repo, parseCommit(object.data).tree);
}

/** Build (and store) the tree for a flat path -> blob oid map; answers the root tree oid. */
export function treeFromFiles(repo: Repo, files: Map<string, string>): string {
  interface Node {
    files: Map<string, string>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, oid] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i]!;
      let next = node.dirs.get(part);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(part, next);
      }
      node = next;
    }
    node.files.set(parts[parts.length - 1]!, oid);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** Create a commit on top of `parent` (or a root commit) holding `files`, with the forge identity. */
export function commitFiles(repo: Repo, parent: string | null, files: Map<string, string>, message: string): string {
  const tree = treeFromFiles(repo, files);
  const data = buildCommit({
    tree,
    parents: parent === null ? [] : [parent],
    message,
    time: nextTime(),
    name: AUTHOR_NAME,
    email: AUTHOR_EMAIL,
  });
  return putObject(repo, 'commit', data);
}

// ------------------------------------------------------------------ pull request merging

export interface MergeOutcome {
  ok: boolean;
  /** The merged file map when ok. */
  files?: Map<string, string>;
  /** The paths that conflict when not ok. */
  conflicts?: string[];
}

/**
 * A file-level three-way merge of head into base, against their merge base: a path changed on only
 * one side takes that side; changed on both sides differently (or changed against a deletion) is a
 * conflict. This is the squash-merge rule the suite exercises.
 */
export function threeWayMerge(repo: Repo, baseTip: string, headTip: string): MergeOutcome {
  const base = mergeBase(repo, baseTip, headTip);
  const baseFiles = filesAtCommit(repo, base);
  const ours = filesAtCommit(repo, baseTip);
  const theirs = filesAtCommit(repo, headTip);
  const merged = new Map<string, string>();
  const conflicts: string[] = [];
  const paths = new Set([...baseFiles.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const atBase = baseFiles.get(path);
    const atOurs = ours.get(path);
    const atTheirs = theirs.get(path);
    if (atOurs === atTheirs) {
      if (atOurs !== undefined) merged.set(path, atOurs);
    } else if (atBase === atOurs) {
      if (atTheirs !== undefined) merged.set(path, atTheirs);
    } else if (atBase === atTheirs) {
      if (atOurs !== undefined) merged.set(path, atOurs);
    } else {
      conflicts.push(path);
    }
  }
  if (conflicts.length > 0) return { ok: false, conflicts };
  return { ok: true, files: merged };
}

/** Squash-merge an open pull request; answers the merge commit oid, or null on conflict. */
export function squashMerge(repo: Repo, pull: Pull): string | null {
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (baseTip === null || headTip === null) return null;
  const outcome = threeWayMerge(repo, baseTip, headTip);
  if (!outcome.ok || outcome.files === undefined) return null;
  const message = `${pull.title} (#${pull.number})`;
  const sha = commitFiles(repo, baseTip, outcome.files, message);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  const now = nextTime();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = now;
  pull.mergeCommitSha = sha;
  pull.updatedAt = now;
  return sha;
}

/** Whether an open pull request currently merges cleanly. */
export function pullMergeable(repo: Repo, pull: Pull): boolean {
  if (pull.state !== 'open') return false;
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (baseTip === null || headTip === null) return false;
  return threeWayMerge(repo, baseTip, headTip).ok;
}

// ------------------------------------------------------------------ global ids (GraphQL)

/** An opaque, stable global id for a record: base64 of "<Type>:<numeric id>". */
export function globalId(type: string, id: number): string {
  return Buffer.from(`${type}:${id}`, 'utf8').toString('base64');
}

/** Decode a global id back to its type and numeric id, or null. */
export function parseGlobalId(id: string): { type: string; id: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const match = /^([A-Za-z]+):(\d+)$/.exec(text);
    if (match === null) return null;
    return { type: match[1]!, id: Number(match[2]) };
  } catch {
    return null;
  }
}

/** Find a repository by its numeric id (GraphQL mutations address repositories this way). */
export function repoById(id: number): Repo | null {
  for (const repo of repos.values()) if (repo.id === id) return repo;
  return null;
}

/** Find an issue anywhere by its global numeric id (closeIssue/addComment address issues this way). */
export function issueByGlobalId(id: number): { repo: Repo; issue: Issue } | null {
  for (const repo of repos.values()) {
    for (const issue of repo.issues.values()) if (issue.id === id) return { repo, issue };
  }
  return null;
}

/** Find a pull request anywhere by its global numeric id. */
export function pullByGlobalId(id: number): { repo: Repo; pull: Pull } | null {
  for (const repo of repos.values()) {
    for (const pull of repo.pulls.values()) if (pull.id === id) return { repo, pull };
  }
  return null;
}
