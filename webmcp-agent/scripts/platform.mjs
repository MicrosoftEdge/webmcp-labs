// Copyright (c) Microsoft Corporation. Licensed under the MIT License.
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const hostName = 'com.microsoft.webmcp_agent';
export const manifestPath = join(root, 'host', `${hostName}.json`);
export const manifest = JSON.parse(readFileSync(join(root, 'extension', 'manifest.json'), 'utf8'));
export const extensionId = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)
  .replace(/[0-9a-f]/g, character => String.fromCharCode(97 + parseInt(character, 16)));
export const callerOrigin = `chrome-extension://${extensionId}/`;
export const launcherPath = join(root, 'host', process.platform === 'win32' ? 'run-host.cmd' : 'run-host.sh');

export function requireNode() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12)) throw new Error('Node.js 22.12 or newer is required.');
}
export function registrations() {
  if (process.platform === 'win32') return [
    `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${hostName}`,
    `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${hostName}`,
  ];
  if (process.platform === 'darwin') {
    const base = join(homedir(), 'Library', 'Application Support');
    return ['Microsoft Edge', 'Microsoft Edge Beta', 'Microsoft Edge Dev', 'Microsoft Edge Canary',
      'Google/Chrome', 'Google/Chrome Canary'].filter((name, index) => [0, 4].includes(index) || existsSync(join(base, name)))
      .map(name => join(base, name, 'NativeMessagingHosts', `${hostName}.json`));
  }
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return ['microsoft-edge', 'microsoft-edge-beta', 'microsoft-edge-dev', 'google-chrome', 'google-chrome-beta', 'google-chrome-unstable']
    .filter((name, index) => [0, 3].includes(index) || existsSync(join(base, name)))
    .map(name => join(base, name, 'NativeMessagingHosts', `${hostName}.json`));
}
export function registrationValue(registration) {
  if (process.platform !== 'win32') return existsSync(registration) ? JSON.parse(readFileSync(registration, 'utf8')).path : undefined;
  const result = execFileSync('reg.exe', ['query', registration, '/ve'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return result.match(/REG_SZ\s+(.+)/)?.[1]?.trim();
}
export function isMissingRegistration(error) {
  return error?.code === 'ENOENT' || /unable to find|not found|cannot find|does not exist/i.test(String(error?.stderr ?? error?.message ?? error));
}
