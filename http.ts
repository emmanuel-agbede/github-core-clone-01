// http.ts — the response discipline every surface shares: JSON bodies, a non-empty
// X-GitHub-Request-Id on every API reply (a counter, so ids never repeat), and bearer auth against
// the token the harness put in MAKEFUN_SHOP_TOKEN.

import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

/** Answer with a JSON body and the forge's standard headers. */
export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  requestCounter += 1;
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'x-github-request-id': `forge-${requestCounter.toString(16).padStart(8, '0')}`,
    ...(text === '' ? {} : { 'content-length': Buffer.byteLength(text) }),
    ...headers,
  });
  res.end(text);
}

/** Answer with no body (204), still carrying the request id. */
export function sendEmpty(res: ServerResponse, status: number): void {
  requestCounter += 1;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'x-github-request-id': `forge-${requestCounter.toString(16).padStart(8, '0')}`,
  });
  res.end();
}

/** The token the suite must present; empty only in local development, where auth is open. */
export function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

/** Whether the request carries the suite's bearer token. */
export function authorized(req: IncomingMessage): boolean {
  const token = expectedToken();
  if (token === '') return true;
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  return header === `Bearer ${token}` || header === `token ${token}`;
}

/** Refuse an unauthenticated API call the way GitHub does: 401 with a JSON message. */
export function refuseAuth(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Bad credentials' });
}

/** Read a request's whole body. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON body; `{ ok: false }` for malformed JSON (the caller answers 400). */
export function parseJsonBody(body: Buffer): { ok: true; value: Record<string, unknown> } | { ok: false } {
  const text = body.toString('utf8').trim();
  if (text === '') return { ok: true, value: {} };
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

/** Decode one URL path segment. */
export function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
