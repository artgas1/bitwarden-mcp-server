import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { executeCliCommand } from '../src/utils/cli.js';
import { handleCreateItem, handleEditItem } from '../src/handlers/cli.js';
import { createItemSchema, editItemSchema } from '../src/schemas/cli.js';
import { createItemTool, editItemTool } from '../src/tools/cli.js';

jest.mock('../src/utils/cli.js', () => ({ executeCliCommand: jest.fn() }));
const cli = jest.mocked(executeCliCommand);
const sshKey = {
  privateKey: 'TEST PRIVATE KEY\nsecond line\n',
  publicKey: 'ssh-ed25519 TEST-PUBLIC-KEY',
  keyFingerprint: 'SHA256:TEST',
};

describe('standard SSH key items', () => {
  beforeEach(() => {
    cli.mockReset();
  });

  it('advertises type 5 and standard fields to MCP clients', () => {
    expect(createItemTool.inputSchema.properties?.['type']).toMatchObject({
      enum: [1, 2, 3, 4, 5],
    });
    expect(createItemTool.inputSchema.properties?.['sshKey']).toMatchObject({
      required: ['privateKey', 'publicKey', 'keyFingerprint'],
    });
    expect(editItemTool.inputSchema.properties?.['sshKey']).toHaveProperty(
      'properties',
    );
  });

  it('requires complete SSH fields on creation, allowing partial edits', () => {
    expect(
      createItemSchema.safeParse({ name: 'test', type: 5, sshKey }).success,
    ).toBe(true);
    for (const missing of Object.keys(sshKey)) {
      const fields: Record<string, string> = { ...sshKey };
      delete fields[missing];
      expect(
        createItemSchema.safeParse({ name: 'test', type: 5, sshKey: fields })
          .success,
      ).toBe(false);
    }
    expect(createItemSchema.safeParse({ name: 'test', type: 5 }).success).toBe(
      false,
    );
    expect(
      createItemSchema.safeParse({ name: 'test', type: 1, login: {}, sshKey })
        .success,
    ).toBe(false);
    expect(
      editItemSchema.safeParse({ id: 'test', sshKey: { publicKey: 'updated' } })
        .success,
    ).toBe(true);
  });

  it('sends a type 5 item with multiline private key unchanged', async () => {
    cli.mockResolvedValue({ output: '{}' });
    await handleCreateItem({
      name: 'test',
      type: 5,
      sshKey,
      folderId: 'folder',
    });
    const args = cli.mock.calls[0]?.[1];
    expect(JSON.parse(Buffer.from(args![1]!, 'base64').toString())).toEqual({
      name: 'test',
      type: 5,
      sshKey,
      folderId: 'folder',
    });
  });

  it('preserves untouched key fields and unrelated item metadata during edits', async () => {
    const item = {
      id: 'test',
      type: 5,
      name: 'test',
      sshKey,
      favorite: true,
      collectionIds: ['collection'],
    };
    cli
      .mockResolvedValueOnce({ output: JSON.stringify(item) })
      .mockResolvedValueOnce({ output: '{}' });
    await handleEditItem({
      id: 'test',
      sshKey: { keyFingerprint: 'SHA256:UPDATED' },
    });
    const args = cli.mock.calls[1]?.[1];
    expect(JSON.parse(Buffer.from(args![2]!, 'base64').toString())).toEqual({
      ...item,
      sshKey: { ...sshKey, keyFingerprint: 'SHA256:UPDATED' },
    });
  });

  it('refuses to attach SSH fields to a non-SSH item', async () => {
    cli.mockResolvedValueOnce({
      output: JSON.stringify({ id: 'test', type: 1, login: {} }),
    });
    const result = await handleEditItem({ id: 'test', sshKey });
    expect(result.isError).toBe(true);
    expect(cli).toHaveBeenCalledTimes(1);
  });
});
