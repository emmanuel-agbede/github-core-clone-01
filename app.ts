// app.ts — the forge's HTTP server: the health probe, the REST v3 surface under /api/v3, GraphQL
// at /api/graphql, MCP at /mcp, and git smart HTTP at /{owner}/{repo}.git. Everything else is
// GitHub's JSON 404. Authentication (the bearer token in MAKEFUN_SHOP_TOKEN) guards the three API
// surfaces; /healthz is the env's boot probe and takes none.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { authorized, decodeSegment, readBody, refuseAuth, sendJson } from './http.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './gql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit } from './gitd.ts';

/** Build the server. It binds nothing until the caller listens; the entry listens on port 0. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void route(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end();
    });
  });
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const path = url.pathname;

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!authorized(req)) {
      refuseAuth(res);
      return;
    }
    const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
    handleRest(req, res, url, body);
    return;
  }

  if (path === '/api/graphql') {
    if (!authorized(req)) {
      refuseAuth(res);
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    handleGraphQL(res, await readBody(req));
    return;
  }

  if (path === '/mcp') {
    if (!authorized(req)) {
      refuseAuth(res);
      return;
    }
    if (method === 'DELETE') {
      sendJson(res, 200, {});
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    handleMcp(res, await readBody(req));
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/<tail>
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch !== null) {
    const owner = decodeSegment(gitMatch[1]!);
    const name = decodeSegment(gitMatch[2]!);
    const tail = gitMatch[3]!;
    const body = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
    handleGit(req, res, owner, name, tail, url.searchParams, body);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}
