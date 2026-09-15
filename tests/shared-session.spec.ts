import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { EventEmitter } from 'node:events';
import {
  initializeSharedSession,
  sharedSessionTestable,
  unlockSharedSession,
  usesSharedSessionProvider,
} from '../src/utils/shared-session.js';
import {
  __testable as unlockTestable,
  _resetUnlockStateForTests,
  runUnlockFlow,
} from '../src/utils/unlock.js';

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: jest.Mock;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  return child;
}

type SpawnScenario = (child: FakeChild) => void;

describe('shared Bitwarden session provider', () => {
  const realSharedSpawn = sharedSessionTestable.spawn;
  const realUnlockSpawn = unlockTestable.spawn;
  const originalProvider = process.env['BW_SESSION_PROVIDER'];
  const originalSession = process.env['BW_SESSION'];
  const originalUnrelatedSecret = process.env['UNRELATED_TEST_SECRET'];
  const spawnMock = jest.fn();

  function route(options: {
    provider?: SpawnScenario;
    validation?: SpawnScenario;
  }): void {
    spawnMock.mockImplementation(((...args: unknown[]) => {
      const command = args[0] as string;
      const commandArgs = (args[1] as readonly string[]) ?? [];
      const child = fakeChild();
      const scenario =
        command === 'bw-session'
          ? options.provider
          : commandArgs.at(-1) === 'status'
            ? options.validation
            : undefined;
      process.nextTick(() => {
        if (scenario) scenario(child);
        else
          child.emit(
            'error',
            Object.assign(new Error('missing'), { code: 'ENOENT' }),
          );
      });
      return child;
    }) as never);
    sharedSessionTestable.spawn = spawnMock as never;
  }

  const providerToken: SpawnScenario = (child) => {
    child.stdout.emit('data', Buffer.from('test-shared-token\n'));
    child.emit('close', 0);
  };
  const statusUnlocked: SpawnScenario = (child) => {
    child.stdout.emit('data', Buffer.from('{"status":"unlocked"}'));
    child.emit('close', 0);
  };

  beforeEach(() => {
    spawnMock.mockReset();
    process.env['BW_SESSION_PROVIDER'] = 'bw-session';
    delete process.env['BW_SESSION'];
    process.env['UNRELATED_TEST_SECRET'] = 'must-not-leak';
    _resetUnlockStateForTests();
  });

  afterEach(() => {
    sharedSessionTestable.spawn = realSharedSpawn;
    unlockTestable.spawn = realUnlockSpawn;
    _resetUnlockStateForTests();
    if (originalProvider === undefined)
      delete process.env['BW_SESSION_PROVIDER'];
    else process.env['BW_SESSION_PROVIDER'] = originalProvider;
    if (originalSession === undefined) delete process.env['BW_SESSION'];
    else process.env['BW_SESSION'] = originalSession;
    if (originalUnrelatedSecret === undefined) {
      delete process.env['UNRELATED_TEST_SECRET'];
    } else {
      process.env['UNRELATED_TEST_SECRET'] = originalUnrelatedSecret;
    }
  });

  it('hydrates startup from bw-session --quiet only after validation', async () => {
    route({ provider: providerToken, validation: statusUnlocked });

    await initializeSharedSession();

    expect(process.env['BW_SESSION']).toBe('test-shared-token');
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[0]?.[0]).toBe('bw-session');
    expect(spawnMock.mock.calls[0]?.[1]).toEqual(['--quiet']);
    expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({ shell: false });
    const providerEnv = (
      spawnMock.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv }
    ).env;
    expect(providerEnv['UNRELATED_TEST_SECRET']).toBeUndefined();
    expect(providerEnv['USER']).toBe(process.env['USER']);
    const validationEnv = (
      spawnMock.mock.calls[1]?.[2] as { env: NodeJS.ProcessEnv }
    ).env;
    expect(validationEnv['BW_SESSION']).toBe('test-shared-token');
  });

  it('starts locked when the quiet provider returns no session', async () => {
    route({
      provider: (child) => child.emit('close', 1),
      validation: statusUnlocked,
    });

    await expect(initializeSharedSession()).resolves.toBeUndefined();
    expect(process.env['BW_SESSION']).toBeUndefined();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a provider token that the Bitwarden CLI does not validate', async () => {
    route({
      provider: providerToken,
      validation: (child) => {
        child.stdout.emit('data', Buffer.from('{"status":"locked"}'));
        child.emit('close', 0);
      },
    });

    const result = await unlockSharedSession();
    expect(result).toEqual({
      success: false,
      error: 'Shared Bitwarden session validation failed.',
    });
    expect(process.env['BW_SESSION']).toBeUndefined();
  });

  it('rejects malformed provider output before spawning validation', async () => {
    route({
      provider: (child) => {
        child.stdout.emit('data', Buffer.from('first-line\nsecond-line'));
        child.emit('close', 0);
      },
      validation: statusUnlocked,
    });

    const result = await unlockSharedSession();
    expect(result.success).toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(process.env['BW_SESSION']).toBeUndefined();
  });

  it('uses the interactive provider without --quiet for MCP unlock', async () => {
    route({ provider: providerToken, validation: statusUnlocked });
    const statusChild = fakeChild();
    unlockTestable.spawn = jest.fn(() => {
      process.nextTick(() => {
        statusChild.stdout.emit('data', Buffer.from('{"status":"locked"}'));
        statusChild.emit('close', 0);
      });
      return statusChild;
    }) as never;

    const result = await runUnlockFlow();

    expect(result).toEqual({
      success: true,
      message: 'Shared Bitwarden session unlocked successfully.',
    });
    expect(spawnMock.mock.calls[0]?.[0]).toBe('bw-session');
    expect(spawnMock.mock.calls[0]?.[1]).toEqual([]);
    expect(process.env['BW_SESSION']).toBe('test-shared-token');
  });

  it('does nothing unless the provider is explicitly selected', async () => {
    delete process.env['BW_SESSION_PROVIDER'];
    sharedSessionTestable.spawn = spawnMock as never;

    expect(usesSharedSessionProvider()).toBe(false);
    await initializeSharedSession();
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
