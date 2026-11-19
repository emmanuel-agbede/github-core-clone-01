// main.ts — process lifecycle for the forge entry.
//
// The trial harness owns this process. Its whole job, start to finish:
//
//   1. Read MAKEFUN_ENV_URL, the origin of the harness environment. With no
//      environment to report to there is nothing to do, so a missing or
//      malformed value is a fatal startup error (exit 1).
//   2. Build the forge server (app.ts) and bind port 0 so the kernel assigns
//      a free ephemeral port. Port 8080 belongs to the environment itself and
//      is never bound here.
//   3. Announce the bound port with POST /register {"port": N}. The
//      environment takes the caller's address plus N as the entry's base URL
//      and routes all trial traffic there. Registration is first-come: a 409
//      means another process registered first and is accepted as final, while
//      400/405 mean the request broke the contract and abort the process. Any
//      other failure (refused connection, timeout, 5xx) is retried with
//      backoff because the environment may still be starting.
//   4. Poll GET /done. The environment answers immediately with
//      {"done": false} while the trial runs, so this is a poll loop, not a
//      held request. The process must not exit before {"done": true}.
//   5. Close the server and exit 0 so the harness can collect the trial.
//
// Beyond that contract this file adds its own operational behaviour: every
// lifecycle step is logged with a timestamp, the environment URL is
// validated before anything binds, and SIGINT/SIGTERM shut the server down
// cleanly instead of leaving a listener behind.

import { createApp } from './app.ts';

/** One environment request may hang at most this long before it is retried. */
const ENV_CALL_TIMEOUT_MS = 30_000;
/** Backoff between failed environment calls: first gap, and the ceiling. */
const BACKOFF_FIRST_MS = 250;
const BACKOFF_CEILING_MS = 2_000;

/** Timestamped lifecycle log on stdout; the harness keeps these with the trial record. */
function note(message: string): void {
  process.stdout.write(`[forge ${new Date().toISOString()}] ${message}\n`);
}

/** Timestamped error log on stderr, kept apart from the lifecycle log. */
function complain(message: string): void {
  process.stderr.write(`[forge ${new Date().toISOString()}] ERROR: ${message}\n`);
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Delay before retry number `attempt`: doubles from BACKOFF_FIRST_MS, capped at the ceiling. */
function backoffMs(attempt: number): number {
  const grown = BACKOFF_FIRST_MS * 2 ** Math.min(attempt, 8);
  return Math.min(BACKOFF_CEILING_MS, grown);
}

/**
 * Resolve and validate the environment origin from MAKEFUN_ENV_URL.
 * Trailing slashes are stripped so paths can be appended unconditionally.
 * Throws a plain-language Error when the variable is absent or not an
 * http(s) URL; the caller treats that as fatal.
 */
function environmentOrigin(): string {
  const raw = (process.env.MAKEFUN_ENV_URL ?? '').trim().replace(/\/+$/, '');
  if (raw === '') {
    throw new Error('MAKEFUN_ENV_URL is not set: no environment to register with');
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`MAKEFUN_ENV_URL is not a valid URL: ${JSON.stringify(raw)}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`MAKEFUN_ENV_URL must be http or https, got ${parsed.protocol}`);
  }
  return raw;
}

/** Raised when the environment rejects registration as a contract violation (HTTP 400/405). */
class RegistrationRefused extends Error {
  constructor(status: number, detail: string) {
    super(`register refused with HTTP ${status}${detail === '' ? '' : `: ${detail}`}`);
    this.name = 'RegistrationRefused';
  }
}

/**
 * POST the bound port to /register until the environment settles it.
 * Success and 409 (a first registration already won) both end the loop.
 * A RegistrationRefused propagates and ends the process; every other
 * failure is retried after a backoff pause.
 */
async function announcePort(origin: string, port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${origin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(ENV_CALL_TIMEOUT_MS),
      });
      if (response.status === 200 || response.status === 409) {
        note(response.status === 200 ? 'registration accepted' : 'another entry registered first (409); standing by');
        return;
      }
      if (response.status === 400 || response.status === 405) {
        throw new RegistrationRefused(response.status, (await response.text()).trim());
      }
      note(`register answered HTTP ${response.status}; will retry`);
    } catch (err) {
      if (err instanceof RegistrationRefused) throw err;
      note(`register attempt ${attempt + 1} failed (${err instanceof Error ? err.message : String(err)}); will retry`);
    }
    await pause(backoffMs(attempt));
  }
}

/** Poll GET /done until the environment answers {"done": true}; never returns earlier. */
async function awaitTrialEnd(origin: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${origin}/done`, {
        signal: AbortSignal.timeout(ENV_CALL_TIMEOUT_MS),
      });
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Unreachable or slow environment: the trial is by definition not over.
    }
    await pause(backoffMs(attempt));
  }
}

/** Bind the forge server on an ephemeral port and report the port the kernel chose. */
async function bindServer(server: ReturnType<typeof createApp>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('server bound without a TCP port (unexpected address)');
  }
  return address.port;
}

/** Close the server, resolving once its listener is fully released. */
function closeServer(server: ReturnType<typeof createApp>): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * Run the lifecycle: validate the environment, bind, register, wait for the
 * trial to end, then shut down. Signal handlers installed here close the
 * server and exit 0 if the harness stops the process early.
 */
async function runLifecycle(): Promise<void> {
  const origin = environmentOrigin();
  const server = createApp();

  let shuttingDown = false;
  const onSignal = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    note(`received ${signal}; closing the server`);
    void closeServer(server).then(() => process.exit(0));
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  const port = await bindServer(server);
  note(`forge listening on ephemeral port ${port}`);

  await announcePort(origin, port);
  note('registered with the environment; waiting for the trial to finish');

  await awaitTrialEnd(origin);
  await closeServer(server);
  note('environment reports done; exiting');
}

try {
  await runLifecycle();
  process.exit(0);
} catch (err) {
  complain(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
