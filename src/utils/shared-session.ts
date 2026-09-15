/**
 * Process-wide Bitwarden session provider for a shared HTTP daemon.
 *
 * `bw-session` is the machine-local source of truth. It keeps the revocable
 * session token outside MCP requests and returns it only over a bounded child
 * stdout pipe. The token is independently validated before it is installed in
 * this process environment for subsequent `bw` child commands.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolveBwInvocation } from './bw-cli.js';
import { buildBwChildEnv } from './bw-env.js';

const PROVIDER_NAME = 'bw-session';
const PROVIDER_ENV = 'BW_SESSION_PROVIDER';
const MAX_OUTPUT_BYTES = 16 * 1024;
const QUIET_PROVIDER_TIMEOUT_MS = 15_000;
const INTERACTIVE_PROVIDER_TIMEOUT_MS = 150_000;
const VALIDATION_TIMEOUT_MS = 10_000;

export const sharedSessionTestable: { spawn: typeof spawn } = { spawn };

interface CommandResult {
  readonly ok: boolean;
  readonly stdout: string;
}

export type SharedSessionResult =
  | { readonly success: true }
  | { readonly success: false; readonly error: string };

export function usesSharedSessionProvider(): boolean {
  return process.env[PROVIDER_ENV] === PROVIDER_NAME;
}

/**
 * Best-effort startup hydration. An unavailable or locked vault must not stop
 * the HTTP listener; the user can invoke the MCP `unlock` tool later.
 */
export async function initializeSharedSession(): Promise<void> {
  if (!usesSharedSessionProvider()) return;
  await refreshSharedSession(true);
}

/** Run the canonical provider interactively from inside the existing mutex. */
export async function unlockSharedSession(): Promise<SharedSessionResult> {
  return refreshSharedSession(false);
}

async function refreshSharedSession(
  quiet: boolean,
): Promise<SharedSessionResult> {
  delete process.env['BW_SESSION'];

  const providerResult = await runBoundedCommand(
    PROVIDER_NAME,
    quiet ? ['--quiet'] : [],
    buildBwChildEnv(),
    quiet ? QUIET_PROVIDER_TIMEOUT_MS : INTERACTIVE_PROVIDER_TIMEOUT_MS,
  );
  const token = providerResult.stdout.trim();
  if (!providerResult.ok || !isPlausibleSessionToken(token)) {
    return {
      success: false,
      error: quiet
        ? 'No valid shared Bitwarden session is available.'
        : 'Shared Bitwarden unlock failed.',
    };
  }

  if (!(await validateSession(token))) {
    return {
      success: false,
      error: 'Shared Bitwarden session validation failed.',
    };
  }

  process.env['BW_SESSION'] = token;
  return { success: true };
}

function isPlausibleSessionToken(token: string): boolean {
  return (
    token.length > 0 &&
    token.length <= MAX_OUTPUT_BYTES &&
    /^[\x21-\x7e]+$/.test(token)
  );
}

async function validateSession(token: string): Promise<boolean> {
  const { command, prefixArgs } = resolveBwInvocation();
  const result = await runBoundedCommand(
    command,
    [...prefixArgs, 'status'],
    buildBwChildEnv({ BW_SESSION: token }),
    VALIDATION_TIMEOUT_MS,
  );
  if (!result.ok) return false;
  try {
    const status = JSON.parse(result.stdout) as { status?: unknown };
    return status.status === 'unlocked';
  } catch {
    return false;
  }
}

function runBoundedCommand(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = sharedSessionTestable.spawn(command, [...args], {
        shell: false,
        env,
      }) as ChildProcessWithoutNullStreams;
    } catch {
      resolve({ ok: false, stdout: '' });
      return;
    }
    let stdout = '';
    let stdoutBytes = 0;
    let settled = false;

    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const terminate = (): void => {
      try {
        child.kill('SIGTERM');
      } catch {
        // The child may already have exited.
      }
    };
    const timeout = setTimeout(() => {
      terminate();
      finish({ ok: false, stdout: '' });
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        terminate();
        finish({ ok: false, stdout: '' });
        return;
      }
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', () => {
      // Provider/CLI stderr is never exposed through MCP or startup logs.
    });
    child.once('error', () => finish({ ok: false, stdout: '' }));
    child.once('close', (code) =>
      finish({ ok: code === 0, stdout: code === 0 ? stdout : '' }),
    );
  });
}
