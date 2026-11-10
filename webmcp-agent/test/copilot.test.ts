// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it, vi } from 'vitest';

import { compatibilitySessionConfig, isolatedClientOptions } from '../host/src/copilot.js';

describe('isolated SDK probe configuration', () => {
  it('uses empty mode and an explicit, separate data home and workspace', () => {
    expect(isolatedClientOptions('separate-home', 'empty-workspace')).toMatchObject({
      mode: 'empty', baseDirectory: 'separate-home', workingDirectory: 'empty-workspace',
      useLoggedInUser: true, logLevel: 'error',
    });
  });

  it('removes inherited explicit tokens and runtime overrides without changing the parent environment', () => {
    vi.stubEnv('COPILOT_CLI_PATH', 'developer-runtime');
    vi.stubEnv('GH_TOKEN', 'test-placeholder-not-a-credential');
    try {
      const environment = isolatedClientOptions('separate-home', 'empty-workspace').env;
      expect(environment).not.toHaveProperty('GH_TOKEN');
      expect(environment).not.toHaveProperty('GITHUB_TOKEN');
      expect(environment).not.toHaveProperty('COPILOT_GITHUB_TOKEN');
      expect(environment).not.toHaveProperty('COPILOT_CLI_PATH');
      expect(process.env.COPILOT_CLI_PATH).toBe('developer-runtime');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('uses declaration-only tools, rejects permissions, and disables ambient discovery', async () => {
    const configuration = compatibilitySessionConfig();
    expect(configuration.sessionId).toMatch(/^webmcp-agent-/);
    expect(configuration.availableTools).toEqual(['custom:*', 'builtin:ask_user']);
    expect(configuration.toolSearch).toEqual({ enabled: false });
    expect(configuration.enableSessionStore).toBe(false);
    expect(configuration.enableConfigDiscovery).toBe(false);
    expect(configuration.mcpServers).toEqual({});
    expect(configuration.tools?.[0]).toMatchObject({ skipPermission: true, defer: 'never' });
    expect(configuration.tools?.[0]).not.toHaveProperty('handler');
    const permissionHandler = configuration.onPermissionRequest;
    if (!permissionHandler) throw new Error('Missing permission handler');
    expect(await permissionHandler(
      { kind: 'read', path: 'example.txt', intention: 'Probe' },
      { sessionId: 'webmcp-agent-probe' },
    )).toEqual({ kind: 'reject' });
    expect(configuration.systemMessage).toMatchObject({
      mode: 'customize',
      sections: { environment_context: { action: 'remove' }, code_change_rules: { action: 'remove' } },
    });
  });
});
