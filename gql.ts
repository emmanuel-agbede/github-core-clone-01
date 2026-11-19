// gql.ts — the GraphQL v4 surface: a hand-written parser for the query language (operations,
// variables, arguments, fragments, directives) and a schema-driven executor over the shared store.
// The schema table below is the single source for both execution and __type introspection, so the
// fields gh feature-detects are exactly the fields that resolve. Unknown fields answer HTTP 200
// with an errors array naming the field, the way GitHub answers them.

import type { ServerResponse } from 'node:http';
import {
  VIEWER_ID,
  VIEWER_LOGIN,
  allocCommentId,
  allocIssueId,
  branchTip,
  findRepo,
  globalId,
  issueByGlobalId,
  nextTime,
  parseGlobalId,
  pullByGlobalId,
  pullMergeable,
  repoById,
  squashMerge,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import { pullFiles } from './rest.ts';
import { sendJson } from './http.ts';

// ------------------------------------------------------------------ lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' }
  | { kind: 'eof' };

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (input.startsWith('...', i)) {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (input.startsWith('"""', i)) {
        const end = input.indexOf('"""', i + 3);
        const text = end === -1 ? input.slice(i + 3) : input.slice(i + 3, end);
        tokens.push({ kind: 'string', value: text.replace(/\\"""/g, '"""') });
        i = end === -1 ? input.length : end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\') {
          const esc = input[j + 1]!;
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === 'b') value += '\b';
          else if (esc === 'f') value += '\f';
          else if (esc === '/') value += '/';
          else if (esc === '\\') value += '\\';
          else if (esc === '"') value += '"';
          else if (esc === 'u') {
            value += String.fromCharCode(parseInt(input.slice(j + 2, j + 6), 16));
            j += 4;
          } else value += esc;
          j += 2;
        } else {
          value += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j]!)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      let isFloat = false;
      while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      if (input[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ------------------------------------------------------------------ AST

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  selectionSet: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'spread'; name: string }
  | { kind: 'inline'; typeCondition: string | null; selectionSet: SelectionNode[] };

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  selectionSet: SelectionNode[];
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(input: string) {
    this.tokens = lex(input);
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}"`);
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, SelectionNode[]> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, SelectionNode[]>();
    while (this.peek().kind !== 'eof') {
      if (this.atPunct('{')) {
        operations.push({ type: 'query', name: null, selectionSet: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'query' || keyword === 'mutation' || keyword === 'subscription') {
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.expectName();
        if (this.atPunct('(')) this.parseVariableDefinitions();
        this.parseDirectives();
        operations.push({ type: keyword === 'mutation' ? 'mutation' : 'query', name, selectionSet: this.parseSelectionSet() });
      } else if (keyword === 'fragment') {
        const fragName = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected "on" in fragment definition');
        this.expectName(); // the type condition
        this.parseDirectives();
        fragments.set(fragName, this.parseSelectionSet());
      } else {
        throw new Error(`unexpected definition "${keyword}"`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!this.atPunct(')')) {
      this.expectPunct('$');
      this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.atPunct('=')) {
        this.next();
        this.parseValue();
      }
      this.parseDirectives();
    }
    this.expectPunct(')');
  }

  private parseType(): void {
    if (this.atPunct('[')) {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.atPunct('!')) this.next();
  }

  private parseDirectives(): void {
    while (this.atPunct('@')) {
      this.next();
      this.expectName();
      if (this.atPunct('(')) {
        this.next();
        while (!this.atPunct(')')) {
          this.expectName();
          this.expectPunct(':');
          this.parseValue();
        }
        this.expectPunct(')');
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.atPunct('}')) {
      if (this.peek().kind === 'spread') {
        this.next();
        if (this.peek().kind === 'name' && (this.peek() as { value: string }).value !== 'on') {
          selections.push({ kind: 'spread', name: this.expectName() });
          this.parseDirectives();
        } else {
          let typeCondition: string | null = null;
          if (this.peek().kind === 'name') {
            this.expectName(); // 'on'
            typeCondition = this.expectName();
          }
          this.parseDirectives();
          selections.push({ kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() });
        }
        continue;
      }
      const first = this.expectName();
      let alias: string | null = null;
      let name = first;
      if (this.atPunct(':')) {
        this.next();
        alias = first;
        name = this.expectName();
      }
      const args: FieldNode['args'] = [];
      if (this.atPunct('(')) {
        this.next();
        while (!this.atPunct(')')) {
          const argName = this.expectName();
          this.expectPunct(':');
          args.push({ name: argName, value: this.parseValue() });
        }
        this.expectPunct(')');
      }
      this.parseDirectives();
      const selectionSet = this.atPunct('{') ? this.parseSelectionSet() : null;
      selections.push({ kind: 'field', alias, name, args, selectionSet });
    }
    this.expectPunct('}');
    return selections;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.atPunct(']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.atPunct('}')) {
        const fieldName = this.expectName();
        this.expectPunct(':');
        fields.push({ name: fieldName, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error('unexpected value');
  }
}

// ------------------------------------------------------------------ values and wrappers

/** An object value travelling through the executor, tagged with its GraphQL type. */
interface GqlObject {
  __type: string;
  value: unknown;
}

function obj(type: string, value: unknown): GqlObject {
  return { __type: type, value };
}

function isGqlObject(value: unknown): value is GqlObject {
  return typeof value === 'object' && value !== null && '__type' in (value as Record<string, unknown>);
}

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => evalValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(field.value, variables);
      return out;
    }
  }
}

// ------------------------------------------------------------------ connections

interface Connection<T> {
  items: T[];
  totalCount: number;
  hasNextPage: boolean;
  endCursor: string | null;
}

function cursorOf(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function pageFrom<T>(all: T[], args: Record<string, unknown>): Connection<T> {
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : all.length;
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    try {
      const decoded = Buffer.from(args.after, 'base64').toString('utf8');
      const match = /^cursor:(\d+)$/.exec(decoded);
      if (match !== null) start = Number(match[1]) + 1;
    } catch {
      start = 0;
    }
  }
  const items = all.slice(start, start + first);
  const lastIndex = start + items.length - 1;
  return {
    items,
    totalCount: all.length,
    hasNextPage: start + items.length < all.length,
    endCursor: items.length > 0 ? cursorOf(lastIndex) : null,
  };
}

// ------------------------------------------------------------------ the schema

type Resolver = (source: GqlObject, args: Record<string, unknown>) => unknown;

interface FieldDef {
  type: string;
  resolve: Resolver;
}

const viewerObject = (): GqlObject => obj('User', { login: VIEWER_LOGIN, id: VIEWER_ID });

const repoObject = (repo: Repo): GqlObject => obj('Repository', repo);
const issueObject = (repo: Repo, issue: Issue): GqlObject => obj('Issue', { repo, issue });
const pullObject = (repo: Repo, pull: Pull): GqlObject => obj('PullRequest', { repo, pull });

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

const SCHEMA: Record<string, Record<string, FieldDef>> = {
  Query: {
    viewer: { type: 'User', resolve: () => viewerObject() },
    repository: {
      type: 'Repository',
      resolve: (_s, args) => {
        const repo = findRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo === null ? null : repoObject(repo);
      },
    },
    node: {
      type: 'Node',
      resolve: (_s, args) => nodeById(String(args.id ?? '')),
    },
    rateLimit: { type: 'RateLimit', resolve: () => obj('RateLimit', {}) },
  },
  Mutation: {
    createIssue: {
      type: 'CreateIssuePayload',
      resolve: (_s, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGlobalId(String(input.repositoryId ?? ''));
        const repo = parsed !== null && parsed.type === 'Repository' ? repoById(parsed.id) : null;
        if (repo === null) throw new Error('repository not found');
        const now = nextTime();
        const issue: Issue = {
          number: repo.nextNumber,
          id: allocIssueId(),
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
          labels: [],
          comments: [],
          createdAt: now,
          updatedAt: now,
          closedAt: null,
        };
        repo.nextNumber += 1;
        repo.issues.set(issue.number, issue);
        return obj('CreateIssuePayload', { issue: issueObject(repo, issue), clientMutationId: input.clientMutationId ?? null });
      },
    },
    closeIssue: {
      type: 'CloseIssuePayload',
      resolve: (_s, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGlobalId(String(input.issueId ?? ''));
        const found = parsed !== null ? issueByGlobalId(parsed.id) : null;
        if (found === null) throw new Error('issue not found');
        found.issue.state = 'closed';
        found.issue.closedAt = nextTime();
        found.issue.updatedAt = found.issue.closedAt;
        return obj('CloseIssuePayload', { issue: issueObject(found.repo, found.issue), clientMutationId: input.clientMutationId ?? null });
      },
    },
    createPullRequest: {
      type: 'CreatePullRequestPayload',
      resolve: (_s, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGlobalId(String(input.repositoryId ?? ''));
        const repo = parsed !== null && parsed.type === 'Repository' ? repoById(parsed.id) : null;
        if (repo === null) throw new Error('repository not found');
        const head = String(input.headRefName ?? '');
        const base = String(input.baseRefName ?? repo.defaultBranch);
        if (branchTip(repo, head) === null) throw new Error(`head branch "${head}" does not exist`);
        if (branchTip(repo, base) === null) throw new Error(`base branch "${base}" does not exist`);
        const now = nextTime();
        const pull: Pull = {
          number: repo.nextNumber,
          id: allocIssueId(),
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
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
        return obj('CreatePullRequestPayload', { pullRequest: pullObject(repo, pull), clientMutationId: input.clientMutationId ?? null });
      },
    },
    mergePullRequest: {
      type: 'MergePullRequestPayload',
      resolve: (_s, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGlobalId(String(input.pullRequestId ?? ''));
        const found = parsed !== null ? pullByGlobalId(parsed.id) : null;
        if (found === null) throw new Error('pull request not found');
        if (found.pull.state === 'open' && !found.pull.merged) {
          squashMerge(found.repo, found.pull);
        }
        return obj('MergePullRequestPayload', { pullRequest: pullObject(found.repo, found.pull), clientMutationId: input.clientMutationId ?? null });
      },
    },
    addComment: {
      type: 'AddCommentPayload',
      resolve: (_s, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGlobalId(String(input.subjectId ?? ''));
        const found = parsed !== null ? issueByGlobalId(parsed.id) : null;
        if (found === null) throw new Error('subject not found');
        const comment = { id: allocCommentId(), body: String(input.body ?? ''), author: VIEWER_LOGIN, createdAt: nextTime() };
        found.issue.comments.push(comment);
        const node = obj('IssueComment', comment);
        return obj('AddCommentPayload', { commentEdge: obj('CommentEdge', { node }), clientMutationId: input.clientMutationId ?? null });
      },
    },
  },
  User: {
    login: { type: 'String', resolve: (s) => (s.value as { login: string }).login },
    id: { type: 'ID', resolve: () => globalId('User', VIEWER_ID) },
    databaseId: { type: 'Int', resolve: () => VIEWER_ID },
    name: { type: 'String', resolve: () => 'Ada Iversen' },
    url: { type: 'String', resolve: (s) => `https://forge.invalid/${(s.value as { login: string }).login}` },
  },
  Repository: {
    id: { type: 'ID', resolve: (s) => globalId('Repository', (s.value as Repo).id) },
    databaseId: { type: 'Int', resolve: (s) => (s.value as Repo).id },
    name: { type: 'String', resolve: (s) => (s.value as Repo).name },
    nameWithOwner: { type: 'String', resolve: (s) => `${(s.value as Repo).owner}/${(s.value as Repo).name}` },
    owner: { type: 'User', resolve: (s) => obj('User', { login: (s.value as Repo).owner, id: VIEWER_ID }) },
    description: { type: 'String', resolve: (s) => (s.value as Repo).description },
    isPrivate: { type: 'Boolean', resolve: (s) => (s.value as Repo).isPrivate },
    viewerPermission: { type: 'String', resolve: () => 'ADMIN' },
    hasIssuesEnabled: { type: 'Boolean', resolve: () => true },
    hasWikiEnabled: { type: 'Boolean', resolve: () => false },
    hasPullRequestsEnabled: { type: 'Boolean', resolve: () => true },
    isEmpty: {
      type: 'Boolean',
      resolve: (s) => branchTip(s.value as Repo, (s.value as Repo).defaultBranch) === null,
    },
    defaultBranchRef: {
      type: 'Ref',
      resolve: (s) => obj('Ref', { name: (s.value as Repo).defaultBranch }),
    },
    url: { type: 'String', resolve: (s) => `https://forge.invalid/${(s.value as Repo).owner}/${(s.value as Repo).name}` },
    createdAt: { type: 'String', resolve: (s) => new Date((s.value as Repo).createdAt * 1000).toISOString() },
    issue: {
      type: 'Issue',
      resolve: (s, args) => {
        const repo = s.value as Repo;
        const issue = repo.issues.get(Number(args.number));
        return issue === undefined ? null : issueObject(repo, issue);
      },
    },
    issues: {
      type: 'IssueConnection',
      resolve: (s, args) => {
        const repo = s.value as Repo;
        let list = [...repo.issues.values()];
        const states = Array.isArray(args.states) ? (args.states as string[]) : null;
        if (states !== null && states.length > 0) {
          list = list.filter((issue) => states.includes(issueState(issue)));
        }
        const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
        const descending = orderBy.direction === 'DESC';
        list.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
        const page = pageFrom(list, args);
        return obj('IssueConnection', {
          nodes: page.items.map((issue) => issueObject(repo, issue)),
          totalCount: page.totalCount,
          pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor },
        });
      },
    },
    pullRequest: {
      type: 'PullRequest',
      resolve: (s, args) => {
        const repo = s.value as Repo;
        const pull = repo.pulls.get(Number(args.number));
        return pull === undefined ? null : pullObject(repo, pull);
      },
    },
    pullRequests: {
      type: 'PullRequestConnection',
      resolve: (s, args) => {
        const repo = s.value as Repo;
        let list = [...repo.pulls.values()];
        const states = Array.isArray(args.states) ? (args.states as string[]) : null;
        if (states !== null && states.length > 0) {
          list = list.filter((pull) => states.includes(pullState(pull)));
        } else {
          list = list.filter((pull) => pullState(pull) === 'OPEN');
        }
        list.sort((a, b) => b.number - a.number);
        const page = pageFrom(list, args);
        return obj('PullRequestConnection', {
          nodes: page.items.map((pull) => pullObject(repo, pull)),
          totalCount: page.totalCount,
          pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor },
        });
      },
    },
  },
  Ref: {
    name: { type: 'String', resolve: (s) => (s.value as { name: string }).name },
    prefix: { type: 'String', resolve: (s) => `refs/heads/${(s.value as { name: string }).name}`.replace(/[^/]*$/, '') },
  },
  Issue: {
    id: { type: 'ID', resolve: (s) => globalId('Issue', (s.value as { issue: Issue }).issue.id) },
    databaseId: { type: 'Int', resolve: (s) => (s.value as { issue: Issue }).issue.id },
    number: { type: 'Int', resolve: (s) => (s.value as { issue: Issue }).issue.number },
    title: { type: 'String', resolve: (s) => (s.value as { issue: Issue }).issue.title },
    body: { type: 'String', resolve: (s) => (s.value as { issue: Issue }).issue.body },
    bodyText: { type: 'String', resolve: (s) => (s.value as { issue: Issue }).issue.body },
    state: { type: 'String', resolve: (s) => issueState((s.value as { issue: Issue }).issue) },
    url: { type: 'String', resolve: (s) => `https://forge.invalid/issues/${(s.value as { issue: Issue }).issue.number}` },
    author: { type: 'User', resolve: () => viewerObject() },
    repository: { type: 'Repository', resolve: (s) => repoObject((s.value as { repo: Repo }).repo) },
    labels: {
      type: 'LabelConnection',
      resolve: (s) => {
        const { repo, issue } = s.value as { repo: Repo; issue: Issue };
        return obj('LabelConnection', {
          nodes: issue.labels.map((name) => obj('Label', { name, color: repo.labels.get(name)?.color ?? '000000' })),
          totalCount: issue.labels.length,
          pageInfo: { hasNextPage: false, endCursor: null },
        });
      },
    },
    comments: {
      type: 'IssueCommentConnection',
      resolve: (s, args) => {
        const { issue } = s.value as { issue: Issue };
        const page = pageFrom(issue.comments, args);
        return obj('IssueCommentConnection', {
          nodes: page.items.map((comment) => obj('IssueComment', comment)),
          totalCount: page.totalCount,
          pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor },
        });
      },
    },
    createdAt: { type: 'String', resolve: (s) => new Date((s.value as { issue: Issue }).issue.createdAt * 1000).toISOString() },
    updatedAt: { type: 'String', resolve: (s) => new Date((s.value as { issue: Issue }).issue.updatedAt * 1000).toISOString() },
    closedAt: {
      type: 'String',
      resolve: (s) => {
        const closedAt = (s.value as { issue: Issue }).issue.closedAt;
        return closedAt === null ? null : new Date(closedAt * 1000).toISOString();
      },
    },
  },
  PullRequest: {
    id: { type: 'ID', resolve: (s) => globalId('PullRequest', (s.value as { pull: Pull }).pull.id) },
    databaseId: { type: 'Int', resolve: (s) => (s.value as { pull: Pull }).pull.id },
    number: { type: 'Int', resolve: (s) => (s.value as { pull: Pull }).pull.number },
    title: { type: 'String', resolve: (s) => (s.value as { pull: Pull }).pull.title },
    body: { type: 'String', resolve: (s) => (s.value as { pull: Pull }).pull.body },
    state: { type: 'String', resolve: (s) => pullState((s.value as { pull: Pull }).pull) },
    merged: { type: 'Boolean', resolve: (s) => (s.value as { pull: Pull }).pull.merged },
    mergeable: {
      type: 'String',
      resolve: (s) => {
        const { repo, pull } = s.value as { repo: Repo; pull: Pull };
        if (pull.state !== 'open') return 'UNKNOWN';
        return pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
      },
    },
    headRefName: { type: 'String', resolve: (s) => (s.value as { pull: Pull }).pull.headRef },
    baseRefName: { type: 'String', resolve: (s) => (s.value as { pull: Pull }).pull.baseRef },
    headRefOid: {
      type: 'String',
      resolve: (s) => {
        const { repo, pull } = s.value as { repo: Repo; pull: Pull };
        return branchTip(repo, pull.headRef) ?? '';
      },
    },
    baseRefOid: {
      type: 'String',
      resolve: (s) => {
        const { repo, pull } = s.value as { repo: Repo; pull: Pull };
        return branchTip(repo, pull.baseRef) ?? '';
      },
    },
    author: { type: 'User', resolve: () => viewerObject() },
    repository: { type: 'Repository', resolve: (s) => repoObject((s.value as { repo: Repo }).repo) },
    mergeCommit: {
      type: 'String',
      resolve: (s) => (s.value as { pull: Pull }).pull.mergeCommitSha,
    },
    files: {
      type: 'PullRequestChangedFileConnection',
      resolve: (s, args) => {
        const { repo, pull } = s.value as { repo: Repo; pull: Pull };
        const all = pullFiles(repo, pull).map((file) => obj('PullRequestChangedFile', { path: String(file.filename), additions: file.additions, deletions: file.deletions }));
        const page = pageFrom(all, args);
        return obj('PullRequestChangedFileConnection', {
          nodes: page.items,
          totalCount: page.totalCount,
          pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor },
        });
      },
    },
    createdAt: { type: 'String', resolve: (s) => new Date((s.value as { pull: Pull }).pull.createdAt * 1000).toISOString() },
    updatedAt: { type: 'String', resolve: (s) => new Date((s.value as { pull: Pull }).pull.updatedAt * 1000).toISOString() },
    mergedAt: {
      type: 'String',
      resolve: (s) => {
        const mergedAt = (s.value as { pull: Pull }).pull.mergedAt;
        return mergedAt === null ? null : new Date(mergedAt * 1000).toISOString();
      },
    },
  },
  PullRequestChangedFile: {
    path: { type: 'String', resolve: (s) => (s.value as { path: string }).path },
    additions: { type: 'Int', resolve: (s) => (s.value as { additions: number }).additions },
    deletions: { type: 'Int', resolve: (s) => (s.value as { deletions: number }).deletions },
  },
  IssueComment: {
    id: { type: 'ID', resolve: (s) => globalId('IssueComment', (s.value as { id: number }).id) },
    databaseId: { type: 'Int', resolve: (s) => (s.value as { id: number }).id },
    body: { type: 'String', resolve: (s) => (s.value as { body: string }).body },
    author: { type: 'User', resolve: () => viewerObject() },
    createdAt: { type: 'String', resolve: (s) => new Date((s.value as { createdAt: number }).createdAt * 1000).toISOString() },
  },
  Label: {
    name: { type: 'String', resolve: (s) => (s.value as { name: string }).name },
    color: { type: 'String', resolve: (s) => (s.value as { color: string }).color },
  },
  RateLimit: {
    limit: { type: 'Int', resolve: () => 5000 },
    remaining: { type: 'Int', resolve: () => 5000 },
    used: { type: 'Int', resolve: () => 0 },
    resetAt: { type: 'String', resolve: () => new Date(0).toISOString() },
  },
  CreateIssuePayload: {
    issue: { type: 'Issue', resolve: (s) => (s.value as { issue: GqlObject }).issue },
    clientMutationId: { type: 'String', resolve: (s) => (s.value as { clientMutationId: unknown }).clientMutationId },
  },
  CloseIssuePayload: {
    issue: { type: 'Issue', resolve: (s) => (s.value as { issue: GqlObject }).issue },
    clientMutationId: { type: 'String', resolve: (s) => (s.value as { clientMutationId: unknown }).clientMutationId },
  },
  CreatePullRequestPayload: {
    pullRequest: { type: 'PullRequest', resolve: (s) => (s.value as { pullRequest: GqlObject }).pullRequest },
    clientMutationId: { type: 'String', resolve: (s) => (s.value as { clientMutationId: unknown }).clientMutationId },
  },
  MergePullRequestPayload: {
    pullRequest: { type: 'PullRequest', resolve: (s) => (s.value as { pullRequest: GqlObject }).pullRequest },
    clientMutationId: { type: 'String', resolve: (s) => (s.value as { clientMutationId: unknown }).clientMutationId },
  },
  AddCommentPayload: {
    commentEdge: { type: 'CommentEdge', resolve: (s) => (s.value as { commentEdge: GqlObject }).commentEdge },
    clientMutationId: { type: 'String', resolve: (s) => (s.value as { clientMutationId: unknown }).clientMutationId },
  },
  CommentEdge: {
    node: { type: 'IssueComment', resolve: (s) => (s.value as { node: GqlObject }).node },
    cursor: { type: 'String', resolve: () => cursorOf(0) },
  },
};

/** Connection types share one shape: nodes, totalCount and pageInfo. */
for (const connectionType of ['IssueConnection', 'PullRequestConnection', 'LabelConnection', 'IssueCommentConnection', 'PullRequestChangedFileConnection']) {
  SCHEMA[connectionType] = {
    nodes: { type: 'Node', resolve: (s) => (s.value as { nodes: unknown }).nodes },
    totalCount: { type: 'Int', resolve: (s) => (s.value as { totalCount: number }).totalCount },
    pageInfo: {
      type: 'PageInfo',
      resolve: (s) => obj('PageInfo', (s.value as { pageInfo: { hasNextPage: boolean; endCursor: string | null } }).pageInfo),
    },
    edges: { type: 'Node', resolve: (s) => (s.value as { nodes: unknown[] }).nodes.map((node) => obj('Edge', { node })) },
  };
}
SCHEMA['Edge'] = {
  node: { type: 'Node', resolve: (s) => (s.value as { node: unknown }).node },
  cursor: { type: 'String', resolve: () => cursorOf(0) },
};
SCHEMA['PageInfo'] = {
  hasNextPage: { type: 'Boolean', resolve: (s) => (s.value as { hasNextPage: boolean }).hasNextPage },
  hasPreviousPage: { type: 'Boolean', resolve: () => false },
  startCursor: { type: 'String', resolve: () => null },
  endCursor: { type: 'String', resolve: (s) => (s.value as { endCursor: string | null }).endCursor },
};

/** The enum types __type can describe. */
const ENUM_TYPES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  StatusState: ['EXPECTED', 'ERROR', 'FAILURE', 'PENDING', 'SUCCESS'],
};

function typeDescription(name: string): GqlObject | null {
  if (SCHEMA[name] !== undefined) {
    return obj('__Type', {
      name,
      kind: 'OBJECT',
      fieldNames: Object.keys(SCHEMA[name]!),
      enumNames: [] as string[],
    });
  }
  if (ENUM_TYPES[name] !== undefined) {
    return obj('__Type', { name, kind: 'ENUM', fieldNames: [] as string[], enumNames: ENUM_TYPES[name]! });
  }
  return null;
}

SCHEMA['__Type'] = {
  name: { type: 'String', resolve: (s) => (s.value as { name: string }).name },
  kind: { type: 'String', resolve: (s) => (s.value as { kind: string }).kind },
  description: { type: 'String', resolve: () => null },
  fields: {
    type: '__Field',
    resolve: (s) => (s.value as { fieldNames: string[] }).fieldNames.map((fieldName) => obj('__Field', { name: fieldName })),
  },
  enumValues: {
    type: '__EnumValue',
    resolve: (s) => (s.value as { enumNames: string[] }).enumNames.map((enumName) => obj('__EnumValue', { name: enumName })),
  },
};
SCHEMA['__Field'] = {
  name: { type: 'String', resolve: (s) => (s.value as { name: string }).name },
  description: { type: 'String', resolve: () => null },
  type: { type: '__Type', resolve: () => obj('__Type', { name: 'String', kind: 'SCALAR', fieldNames: [], enumNames: [] }) },
};
SCHEMA['__EnumValue'] = {
  name: { type: 'String', resolve: (s) => (s.value as { name: string }).name },
  description: { type: 'String', resolve: () => null },
  isDeprecated: { type: 'Boolean', resolve: () => false },
};

function nodeById(id: string): GqlObject | null {
  const parsed = parseGlobalId(id);
  if (parsed === null) return null;
  if (parsed.type === 'Repository') {
    const repo = repoById(parsed.id);
    return repo === null ? null : repoObject(repo);
  }
  if (parsed.type === 'Issue') {
    const found = issueByGlobalId(parsed.id);
    return found === null ? null : issueObject(found.repo, found.issue);
  }
  if (parsed.type === 'PullRequest') {
    const found = pullByGlobalId(parsed.id);
    return found === null ? null : pullObject(found.repo, found.pull);
  }
  if (parsed.type === 'User') return viewerObject();
  return null;
}

// ------------------------------------------------------------------ the executor

interface ExecContext {
  variables: Record<string, unknown>;
  fragments: Map<string, SelectionNode[]>;
  errors: { message: string }[];
}

function executeSelectionSet(source: GqlObject, selections: SelectionNode[], ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const typeName = source.__type;
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined) Object.assign(out, executeSelectionSet(source, fragment, ctx));
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === typeName) {
        Object.assign(out, executeSelectionSet(source, selection.selectionSet, ctx));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    if (selection.name === '__type' && typeName === 'Query') {
      const args = evalArgs(selection, ctx);
      out[key] = completeValue(typeDescription(String(args.name ?? '')), selection, ctx);
      continue;
    }
    if (selection.name === '__schema' && typeName === 'Query') {
      out[key] = null;
      continue;
    }
    const fieldDef = SCHEMA[typeName]?.[selection.name];
    if (fieldDef === undefined) {
      ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    let value: unknown;
    try {
      value = fieldDef.resolve(source, evalArgs(selection, ctx));
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(value, selection, ctx);
  }
  return out;
}

function evalArgs(field: FieldNode, ctx: ExecContext): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const arg of field.args) args[arg.name] = evalValue(arg.value, ctx.variables);
  return args;
}

/** Finish a resolved value: recurse into objects and lists that carry a selection set. */
function completeValue(value: unknown, field: FieldNode, ctx: ExecContext): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(item, field, ctx));
  if (isGqlObject(value)) {
    if (field.selectionSet === null) return null;
    return executeSelectionSet(value, field.selectionSet, ctx);
  }
  return value;
}

/** Execute one operation document; answers the {data, errors?} body. */
export function executeGraphQL(query: string, variables: Record<string, unknown>, operationName?: string): Record<string, unknown> {
  let parsed: { operations: OperationNode[]; fragments: Map<string, SelectionNode[]> };
  try {
    parsed = new Parser(query).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  const operation = operationName !== undefined && operationName !== ''
    ? parsed.operations.find((op) => op.name === operationName) ?? parsed.operations[0]
    : parsed.operations[0];
  if (operation === undefined) return { errors: [{ message: 'no operation in document' }] };
  const ctx: ExecContext = { variables, fragments: parsed.fragments, errors: [] };
  const root = obj(operation.type === 'mutation' ? 'Mutation' : 'Query', {});
  const data = executeSelectionSet(root, operation.selectionSet, ctx);
  const body: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) body.errors = ctx.errors;
  return body;
}

// ------------------------------------------------------------------ the HTTP handler

/** Handle one POST /api/graphql (auth already checked): one operation, or a batch array. */
export function handleGraphQL(res: ServerResponse, rawBody: Buffer): void {
  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  if (Array.isArray(body)) {
    const results = body.map((entry) => runOne(entry));
    sendJson(res, 200, results);
    return;
  }
  sendJson(res, 200, runOne(body));
}

function runOne(entry: unknown): Record<string, unknown> {
  if (typeof entry !== 'object' || entry === null) return { errors: [{ message: 'invalid operation' }] };
  const record = entry as Record<string, unknown>;
  const query = typeof record.query === 'string' ? record.query : '';
  const variables = typeof record.variables === 'object' && record.variables !== null ? (record.variables as Record<string, unknown>) : {};
  const operationName = typeof record.operationName === 'string' ? record.operationName : undefined;
  if (query === '') return { errors: [{ message: 'no query' }] };
  return executeGraphQL(query, variables, operationName);
}
