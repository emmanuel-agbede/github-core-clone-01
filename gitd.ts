// gitd.ts — git smart HTTP: the reference advertisements, protocol-v2 ls-refs and fetch, the v0
// fetch fallback, and receive-pack with report-status inside side-band-64k. Objects move as
// undeltified packfiles; the object store is the same one the REST contents API writes, so a file
// committed over the API can be cloned and a pushed branch can carry a pull request.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { parsePkts, pktLine, readPack, writePack, ZERO_OID, PKT_FLUSH, type GitObject } from './gitobj.ts';
import { branchTip, derefToCommit, findRepo, getObject, isAncestor, putObject, type Repo } from './store.ts';
import { parseCommit, parseTree } from './gitobj.ts';

const AGENT = 'makefun-forge/1.0';

function send(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'cache-control': 'no-cache' });
  res.end(body);
}

function notFound(res: ServerResponse): void {
  send(res, 404, Buffer.from('not found\n'), 'text/plain; charset=utf-8');
}

/** Sorted ref names of a repository. */
function sortedRefs(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

/** The oid a ref peels to (its commit), for `^{}` and `peeled:` lines. */
function peeledOf(repo: Repo, oid: string): string | null {
  const object = getObject(repo, oid);
  if (object === null || object.type !== 'tag') return null;
  return derefToCommit(repo, oid);
}

// ------------------------------------------------------------------ advertisements

const UPLOAD_CAPS_V0 = `multi_ack_detailed no-done side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not agent=${AGENT}`;
const RECEIVE_CAPS = `report-status delete-refs side-band-64k ofs-delta agent=${AGENT}`;

/** The ref lines shared by both v0 advertisements: HEAD first (with capabilities), then every ref. */
function v0RefLines(repo: Repo, caps: string): Buffer[] {
  const lines: Buffer[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  const allCaps = `${caps} symref=HEAD:${headRef}`;
  if (headOid === undefined && repo.refs.size === 0) {
    lines.push(pktLine(Buffer.concat([Buffer.from(`${ZERO_OID} capabilities^{}\0${allCaps}`, 'utf8')])));
    return lines;
  }
  let first = true;
  const pushLine = (oid: string, name: string): void => {
    if (first) {
      lines.push(pktLine(Buffer.concat([Buffer.from(`${oid} ${name}\0${allCaps}`, 'utf8')])));
      first = false;
    } else {
      lines.push(pktLine(`${oid} ${name}`));
    }
  };
  if (headOid !== undefined) pushLine(headOid, 'HEAD');
  for (const ref of sortedRefs(repo)) {
    const oid = repo.refs.get(ref)!;
    pushLine(oid, ref);
    const peeled = peeledOf(repo, oid);
    if (peeled !== null) lines.push(pktLine(`${peeled} ${ref}^{}`));
  }
  if (first) {
    // Refs exist but the default branch is unborn: HEAD still needs a first line to carry the caps.
    lines.unshift(pktLine(Buffer.concat([Buffer.from(`${ZERO_OID} capabilities^{}\0${allCaps}`, 'utf8')])));
  }
  return lines;
}

function advertise(res: ServerResponse, repo: Repo, service: string, wantsV2: boolean): void {
  if (service === 'git-upload-pack' && wantsV2) {
    const lines = [
      pktLine('version 2'),
      pktLine(`agent=${AGENT}`),
      pktLine('ls-refs=unborn'),
      pktLine('fetch=shallow'),
      pktLine('object-format=sha1'),
      PKT_FLUSH,
    ];
    send(res, 200, Buffer.concat(lines), 'application/x-git-upload-pack-advertisement');
    return;
  }
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS;
  const parts = [pktLine(`# service=${service}\n`), PKT_FLUSH, ...v0RefLines(repo, caps), PKT_FLUSH];
  send(res, 200, Buffer.concat(parts), `application/x-${service}-advertisement`);
}

// ------------------------------------------------------------------ ls-refs (protocol v2)

function lsRefs(repo: Repo, body: Buffer): Buffer {
  const { items } = parsePkts(body);
  const args: string[] = [];
  let inArgs = false;
  for (const item of items) {
    if (item.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (item.kind === 'flush') break;
    const line = item.payload.toString('utf8').replace(/\n$/, '');
    if (inArgs) args.push(line);
  }
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const wantPeel = args.includes('peel');
  const wantSymrefs = args.includes('symrefs');
  const wantUnborn = args.includes('unborn');
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const lines: Buffer[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      lines.push(pktLine(`${headOid} HEAD${wantSymrefs ? ` symref-target:${headRef}` : ''}`));
    } else if (wantUnborn) {
      lines.push(pktLine(`unborn HEAD symref-target:${headRef}`));
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    const oid = repo.refs.get(ref)!;
    let line = `${oid} ${ref}`;
    if (wantPeel) {
      const peeled = peeledOf(repo, oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(pktLine(line));
  }
  lines.push(PKT_FLUSH);
  return Buffer.concat(lines);
}

// ------------------------------------------------------------------ fetch planning

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: Set<string>;
  deepen: number | null;
  deepenSince: number | null;
  deepenNot: string[];
  done: boolean;
}

/** Add a commit's tree and every subtree/blob under it to `into` (skipping `exclude`). */
function addTreeClosure(repo: Repo, commitOid: string, into: Set<string>, exclude: Set<string>): void {
  const commit = getObject(repo, commitOid);
  if (commit === null || commit.type !== 'commit') return;
  const stack: string[] = [parseCommit(commit.data).tree];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (into.has(oid) || exclude.has(oid)) continue;
    const object = getObject(repo, oid);
    if (object === null) continue;
    into.add(oid);
    if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    }
  }
}

/** Add a commit's full reachable closure (ancestors, trees, blobs) to `into`. */
function addFullClosure(repo: Repo, tip: string, into: Set<string>): void {
  const stack: string[] = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (into.has(oid)) continue;
    const object = getObject(repo, oid);
    if (object === null) continue;
    into.add(oid);
    if (object.type === 'commit') {
      const info = parseCommit(object.data);
      stack.push(info.tree);
      for (const parent of info.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      const match = /^object ([0-9a-f]{40})/m.exec(object.data.toString('utf8'));
      if (match !== null) stack.push(match[1]!);
    }
  }
}

interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

function planFetch(repo: Repo, request: FetchRequest): FetchPlan {
  const exclude = new Set<string>();
  for (const have of request.haves) {
    const commit = derefToCommit(repo, have);
    if (commit === null) continue;
    if (request.shallow.has(have) || request.shallow.has(commit)) {
      exclude.add(commit);
      const trees = new Set<string>();
      addTreeClosure(repo, commit, trees, new Set());
      for (const oid of trees) exclude.add(oid);
    } else {
      addFullClosure(repo, commit, exclude);
    }
  }
  for (const notRef of request.deepenNot) {
    const commit = derefToCommit(repo, notRef) ?? (repo.refs.get(notRef) !== undefined ? derefToCommit(repo, repo.refs.get(notRef)!) : null);
    if (commit !== null) addFullClosure(repo, commit, exclude);
  }
  // Breadth-first walk from the wants: the first visit fixes a commit's depth (want = depth 1).
  const depthOf = new Map<string, number>();
  const queue: Array<[string, number]> = [];
  for (const want of request.wants) {
    const commit = derefToCommit(repo, want);
    if (commit !== null && !depthOf.has(commit)) {
      depthOf.set(commit, 1);
      queue.push([commit, 1]);
    }
  }
  while (queue.length > 0) {
    const [oid, depth] = queue.shift()!;
    const object = getObject(repo, oid);
    if (object === null || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!depthOf.has(parent)) {
        depthOf.set(parent, depth + 1);
        queue.push([parent, depth + 1]);
      }
    }
  }
  const withinDepth = (oid: string): boolean => {
    const depth = depthOf.get(oid);
    if (depth === undefined) return false;
    if (request.deepen !== null && depth > request.deepen) return false;
    if (request.deepenSince !== null) {
      const object = getObject(repo, oid);
      if (object !== null && object.type === 'commit' && parseCommit(object.data).time < request.deepenSince) return false;
    }
    return true;
  };
  const sentCommits = new Set<string>();
  for (const oid of depthOf.keys()) {
    if (withinDepth(oid) && !exclude.has(oid)) sentCommits.add(oid);
  }
  const sent = new Set<string>(sentCommits);
  // A want that names an annotated tag must deliver the tag object itself (and any tag chain),
  // not only the commit it peels to.
  for (const want of request.wants) {
    let current: string | null = want;
    while (current !== null) {
      const object = getObject(repo, current);
      if (object === null || object.type !== 'tag') break;
      if (!exclude.has(current)) sent.add(current);
      const match = /^object ([0-9a-f]{40})/m.exec(object.data.toString('utf8'));
      current = match === null ? null : match[1]!;
    }
  }
  for (const oid of sentCommits) addTreeClosure(repo, oid, sent, exclude);
  // Shallow bookkeeping: a sent commit with an unsent parent is a new boundary; a commit the client
  // already held shallow whose parents are all sent (or absent) stops being shallow.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  for (const oid of sentCommits) {
    const object = getObject(repo, oid);
    if (object === null || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.some((p) => !sentCommits.has(p) && getObject(repo, p) !== null) && !request.shallow.has(oid)) {
      shallow.push(oid);
    }
  }
  for (const held of request.shallow) {
    const commit = derefToCommit(repo, held) ?? held;
    if (!depthOf.has(commit)) continue;
    const object = getObject(repo, commit);
    if (object === null || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.every((p) => sentCommits.has(p))) unshallow.push(commit);
  }
  const orderedCommits = [...sentCommits].sort((a, b) => (depthOf.get(a) ?? 0) - (depthOf.get(b) ?? 0));
  const objects: GitObject[] = [];
  const emit = (oid: string): void => {
    const object = getObject(repo, oid);
    if (object !== null) objects.push(object);
  };
  for (const oid of orderedCommits) emit(oid);
  for (const oid of sent) if (!sentCommits.has(oid)) emit(oid);
  return { objects, shallow, unshallow };
}

/** Wrap pack bytes in side-band-64k packets (band 1), terminated by a flush packet. */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let pos = 0; pos < pack.length; pos += CHUNK) {
    const chunk = pack.subarray(pos, pos + CHUNK);
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function fetchV2(repo: Repo, body: Buffer): Buffer {
  const { items } = parsePkts(body);
  const request: FetchRequest = { wants: [], haves: [], shallow: new Set(), deepen: null, deepenSince: null, deepenNot: [], done: false };
  let inArgs = false;
  for (const item of items) {
    if (item.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (item.kind === 'flush') break;
    if (!inArgs) continue;
    const line = item.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) request.wants.push(line.slice(5, 45));
    else if (line.startsWith('have ')) request.haves.push(line.slice(5, 45));
    else if (line.startsWith('shallow ')) request.shallow.add(line.slice(8, 48));
    else if (line.startsWith('deepen-since ')) request.deepenSince = Number(line.slice('deepen-since '.length));
    else if (line.startsWith('deepen-not ')) request.deepenNot.push(line.slice('deepen-not '.length));
    else if (line.startsWith('deepen ')) request.deepen = Number(line.slice('deepen '.length));
    else if (line === 'done') request.done = true;
  }
  const plan = planFetch(repo, request);
  const parts: Buffer[] = [];
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}`));
    parts.push(PKT_FLUSH);
  }
  if (request.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    const acks = request.haves.filter((have) => getObject(repo, have) !== null);
    if (acks.length === 0) parts.push(pktLine('NAK'));
    else for (const oid of acks) parts.push(pktLine(`ACK ${oid}`));
    if (!request.done) parts.push(pktLine('ready'));
    parts.push(PKT_FLUSH);
  }
  if (request.done) {
    parts.push(pktLine('packfile\n'));
    parts.push(sidebandPack(writePack(plan.objects)));
  }
  return Buffer.concat(parts);
}

function fetchV0(repo: Repo, body: Buffer): Buffer {
  const { items, next } = parsePkts(body);
  const request: FetchRequest = { wants: [], haves: [], shallow: new Set(), deepen: null, deepenSince: null, deepenNot: [], done: true };
  let caps = '';
  let phase: 'want' | 'have' = 'want';
  let consumed = next;
  for (const item of items) {
    if (item.kind === 'flush') {
      if (phase === 'want') phase = 'have';
      continue;
    }
    if (item.kind !== 'data') continue;
    let line = item.payload.toString('utf8').replace(/\n$/, '');
    if (phase === 'want') {
      const nul = line.indexOf('\0');
      if (nul !== -1) {
        caps = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
      if (line.startsWith('want ')) request.wants.push(line.slice(5, 45));
    } else {
      if (line.startsWith('have ')) request.haves.push(line.slice(5, 45));
      else if (line.startsWith('deepen ')) request.deepen = Number(line.slice(7));
      else if (line === 'done') break;
    }
  }
  void consumed;
  const plan = planFetch(repo, request);
  const pack = writePack(plan.objects);
  const head = pktLine('NAK\n');
  if (caps.includes('side-band-64k') || caps.includes('side-band')) {
    return Buffer.concat([head, sidebandPack(pack)]);
  }
  return Buffer.concat([head, pack]);
}

// ------------------------------------------------------------------ receive-pack

function receivePack(repo: Repo, body: Buffer): Buffer {
  const { items, next } = parsePkts(body);
  interface Command {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  const commands: Command[] = [];
  let caps = '';
  for (const item of items) {
    if (item.kind === 'flush') break;
    if (item.kind !== 'data') continue;
    let line = item.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul !== -1) {
      caps = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    const parts = line.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
    }
  }
  let unpackError: string | null = null;
  const rest = body.subarray(next);
  if (rest.length > 0) {
    try {
      readPack(rest, 0, {
        store: (type, data) => putObject(repo, type, data),
        read: (oid) => getObject(repo, oid),
      });
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  const report: Buffer[] = [];
  report.push(pktLine(unpackError === null ? 'unpack ok\n' : `unpack ${unpackError}\n`));
  for (const command of commands) {
    const fail = (reason: string): void => {
      report.push(pktLine(`ng ${command.ref} ${reason}\n`));
    };
    if (unpackError !== null) {
      fail('unpacker error');
      continue;
    }
    if (!command.ref.startsWith('refs/')) {
      fail('invalid ref');
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.newOid === ZERO_OID) {
      if (current === ZERO_OID) {
        fail('reference does not exist');
        continue;
      }
      repo.refs.delete(command.ref);
      report.push(pktLine(`ok ${command.ref}\n`));
      continue;
    }
    const target = getObject(repo, command.newOid);
    if (target === null) {
      fail('invalid object');
      continue;
    }
    if (current !== ZERO_OID) {
      const currentCommit = derefToCommit(repo, current);
      const newCommit = derefToCommit(repo, command.newOid);
      if (currentCommit !== null && newCommit !== null && !isAncestor(repo, currentCommit, newCommit)) {
        fail('non-fast-forward');
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    report.push(pktLine(`ok ${command.ref}\n`));
  }
  report.push(PKT_FLUSH);
  const reportBytes = Buffer.concat(report);
  if (caps.includes('side-band-64k') || caps.includes('side-band')) {
    const parts: Buffer[] = [];
    const CHUNK = 65515;
    for (let pos = 0; pos < reportBytes.length; pos += CHUNK) {
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), reportBytes.subarray(pos, pos + CHUNK)])));
    }
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  return reportBytes;
}

// ------------------------------------------------------------------ entry point

/** Route one git smart-HTTP request. `tail` is 'info/refs', 'git-upload-pack' or 'git-receive-pack'. */
export function handleGit(req: IncomingMessage, res: ServerResponse, owner: string, name: string, tail: string, query: URLSearchParams, body: Buffer): void {
  const repo = findRepo(owner, name);
  if (repo === null || repo.owner !== owner) {
    notFound(res);
    return;
  }
  if (tail === 'info/refs' && req.method === 'GET') {
    const service = query.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      send(res, 400, Buffer.from('missing or unknown service\n'), 'text/plain; charset=utf-8');
      return;
    }
    const protocol = req.headers['git-protocol'];
    const wantsV2 = typeof protocol === 'string' && protocol.includes('version=2');
    advertise(res, repo, service, wantsV2);
    return;
  }
  if (tail === 'git-upload-pack' && req.method === 'POST') {
    const protocol = req.headers['git-protocol'];
    const isV2 = typeof protocol === 'string' && protocol.includes('version=2');
    // A v2 session is told apart by its first command line too: `command=ls-refs` / `command=fetch`.
    const text = body.toString('latin1');
    if (isV2 || text.includes('command=ls-refs') || text.includes('command=fetch')) {
      if (text.includes('command=ls-refs')) {
        send(res, 200, lsRefs(repo, body), 'application/x-git-upload-pack-result');
      } else {
        send(res, 200, fetchV2(repo, body), 'application/x-git-upload-pack-result');
      }
      return;
    }
    send(res, 200, fetchV0(repo, body), 'application/x-git-upload-pack-result');
    return;
  }
  if (tail === 'git-receive-pack' && req.method === 'POST') {
    send(res, 200, receivePack(repo, body), 'application/x-git-receive-pack-result');
    return;
  }
  notFound(res);
}

export { branchTip };
