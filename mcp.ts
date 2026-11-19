// mcp.ts — the Model Context Protocol endpoint at /mcp: JSON-RPC 2.0 over streamable HTTP,
// speaking the handshake revision (initialize + notifications/initialized). A server/discover
// probe is answered method-not-found, which is exactly how a pre-2026-07-28 server identifies
// itself. The tools act on the same store as REST, and their results carry the created objects
// both as text and as structured content, so an agent reading either sees the same ids.

import type { ServerResponse } from 'node:http';
import {
  VIEWER_LOGIN,
  allocIssueId,
  branchTip,
  createRepo,
  findRepo,
  nextTime,
  squashMerge,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };
const REVISION = '2025-11-25';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
  run: (args: Record<string, unknown>) => unknown;
}

function repoArg(args: Record<string, unknown>): Repo {
  const owner = typeof args.owner === 'string' ? args.owner : VIEWER_LOGIN;
  const name = typeof args.repo === 'string' ? args.repo : '';
  const repo = findRepo(owner, name);
  if (repo === null || repo.owner !== owner) throw new Error(`repository ${owner}/${name} not found`);
  return repo;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name' },
        description: { type: 'string', description: 'A short description of the repository' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
    run: (args) => {
      const name = String(args.name ?? '');
      if (name === '') throw new Error('name is required');
      if (findRepo(VIEWER_LOGIN, name) !== null) throw new Error(`repository ${name} already exists`);
      const repo = createRepo(VIEWER_LOGIN, name, typeof args.description === 'string' ? args.description : '', args.private === true);
      return repoJson(repo);
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        repo: { type: 'string', description: 'The repository name' },
      },
      required: ['owner', 'repo'],
    },
    run: (args) => repoJson(repoArg(args)),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        repo: { type: 'string', description: 'The repository name' },
        title: { type: 'string', description: 'The issue title' },
        body: { type: 'string', description: 'The issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
    run: (args) => {
      const repo = repoArg(args);
      const now = nextTime();
      const issue: Issue = {
        number: repo.nextNumber,
        id: allocIssueId(),
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        comments: [],
        createdAt: now,
        updatedAt: now,
        closedAt: null,
      };
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      return issueJson(repo, issue);
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        repo: { type: 'string', description: 'The repository name' },
        state: { type: 'string', description: 'Filter by state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
    run: (args) => {
      const repo = repoArg(args);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') list = list.filter((issue) => issue.state === state);
      list.sort((a, b) => a.number - b.number);
      return list.map((issue) => issueJson(repo, issue));
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        repo: { type: 'string', description: 'The repository name' },
        title: { type: 'string', description: 'The pull request title' },
        body: { type: 'string', description: 'The pull request body' },
        head: { type: 'string', description: 'The head branch name' },
        base: { type: 'string', description: 'The base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    run: (args) => {
      const repo = repoArg(args);
      const head = String(args.head ?? '');
      const base = String(args.base ?? repo.defaultBranch);
      if (branchTip(repo, head) === null) throw new Error(`head branch "${head}" does not exist`);
      if (branchTip(repo, base) === null) throw new Error(`base branch "${base}" does not exist`);
      const now = nextTime();
      const pull: Pull = {
        number: repo.nextNumber,
        id: allocIssueId(),
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
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
      return pullJson(repo, pull);
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch (squash).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        repo: { type: 'string', description: 'The repository name' },
        pull_number: { type: 'number', description: 'The pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    run: (args) => {
      const repo = repoArg(args);
      const number = Number(args.pull_number);
      const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
      if (pull === undefined) throw new Error(`pull request #${String(args.pull_number)} not found`);
      if (pull.state !== 'open' || pull.merged) throw new Error(`pull request #${pull.number} is not open`);
      const sha = squashMerge(repo, pull);
      if (sha === null) throw new Error(`pull request #${pull.number} has conflicts and cannot be merged`);
      return { ...pullJson(repo, pull), sha };
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue of a repository by its number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        repo: { type: 'string', description: 'The repository name' },
        issue_number: { type: 'number', description: 'The issue number' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
    run: (args) => {
      const repo = repoArg(args);
      const issue = repo.issues.get(Number(args.issue_number));
      if (issue === undefined) throw new Error(`issue #${String(args.issue_number)} not found`);
      return issueJson(repo, issue);
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        repo: { type: 'string', description: 'The repository name' },
        state: { type: 'string', description: 'Filter by state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
    run: (args) => {
      const repo = repoArg(args);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.pulls.values()];
      if (state === 'open') list = list.filter((pull) => pull.state === 'open');
      else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
      list.sort((a, b) => a.number - b.number);
      return list.map((pull) => pullJson(repo, pull));
    },
  },
];

/** The tools/list answer: built once, so two calls are byte-for-byte identical. */
const TOOLS_LIST_RESULT = {
  tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
};

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

/** Handle one POST /mcp (auth already checked by the caller). */
export function handleMcp(res: ServerResponse, rawBody: Buffer): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    // A body that is not JSON: HTTP 400 with the JSON-RPC parse error.
    const body = `${JSON.stringify(rpcError(null, -32700, 'Parse error'))}\n`;
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => dispatch(entry)).filter((r) => r !== null);
    sendRpc(res, 200, results);
    return;
  }
  const answer = dispatch(parsed);
  if (answer === null) {
    // A notification: accepted, no body.
    res.writeHead(202, { 'content-type': 'application/json; charset=utf-8' });
    res.end();
    return;
  }
  sendRpc(res, 200, answer);
}

function sendRpc(res: ServerResponse, status: number, payload: unknown): void {
  const body = `${JSON.stringify(payload)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

/** Dispatch one JSON-RPC message; null for a notification (no answer owed). */
function dispatch(message: unknown): Record<string, unknown> | null {
  if (typeof message !== 'object' || message === null) return rpcError(null, -32600, 'Invalid Request');
  const record = message as Record<string, unknown>;
  const method = typeof record.method === 'string' ? record.method : '';
  const id = record.id;
  const isNotification = id === undefined;
  const params = typeof record.params === 'object' && record.params !== null ? (record.params as Record<string, unknown>) : {};

  switch (method) {
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : REVISION;
      const revision = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'].includes(requested) ? requested : REVISION;
      return rpcResult(id, {
        protocolVersion: revision,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, TOOLS_LIST_RESULT);
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS.find((t) => t.name === name);
      if (tool === undefined) return rpcError(id, -32602, `unknown tool: ${name}`);
      const args = typeof params.arguments === 'object' && params.arguments !== null ? (params.arguments as Record<string, unknown>) : {};
      const missing = tool.inputSchema.required.filter((key) => args[key] === undefined);
      if (missing.length > 0) {
        return rpcResult(id, toolError(`missing required argument(s): ${missing.join(', ')}`));
      }
      try {
        return rpcResult(id, toolResult(tool.run(args)));
      } catch (err) {
        return rpcResult(id, toolError(err instanceof Error ? err.message : String(err)));
      }
    }
    default:
      if (isNotification) return null;
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}
