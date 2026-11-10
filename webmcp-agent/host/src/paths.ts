// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { homedir } from 'node:os';
import { join } from 'node:path';

export function dataDirectory(): string {
  if (process.env.WEBMCP_AGENT_DATA_DIR) return process.env.WEBMCP_AGENT_DATA_DIR;
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'WebMCP Agent');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'WebMCP Agent');
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'webmcp-agent');
}

export function logDirectory(): string {
  if (process.env.WEBMCP_AGENT_DATA_DIR || process.platform === 'win32') return join(dataDirectory(), 'logs');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Logs', 'WebMCP Agent');
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'webmcp-agent');
}
