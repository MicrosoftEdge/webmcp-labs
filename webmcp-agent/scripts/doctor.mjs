// Copyright (c) Microsoft Corporation. Licensed under the MIT License.
import { existsSync, readFileSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { extensionId, callerOrigin, registrations, registrationValue, isMissingRegistration, launcherPath, manifestPath, hostName, requireNode, root } from './platform.mjs';
import { encodeNativeMessage, NativeMessageDecoder } from '../host/dist/nativeMessaging.js';
import { validateToExtension } from '../shared/dist/validate.js';

requireNode();
let failed = false;
function check(ok, text) { console.log(`${ok ? 'PASS' : 'FAIL'} ${text}`); if (!ok) failed = true; }
check(existsSync(launcherPath), 'Host launcher exists');
check(existsSync(manifestPath), 'Native manifest exists');
if (!existsSync(manifestPath) || !existsSync(launcherPath)) throw new Error('Run npm run setup first.');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
check(manifest.path === launcherPath && manifest.allowed_origins?.length === 1 && manifest.allowed_origins[0] === callerOrigin, 'Manifest launcher and caller ID match');
for (const registration of registrations()) {
  try {
    const matches = process.platform === 'win32' ? registrationValue(registration) === manifestPath
      : JSON.stringify(JSON.parse(readFileSync(registration, 'utf8'))) === JSON.stringify(manifest);
    check(matches, `Registration: ${registration}`);
  }
  catch { check(false, `Registration missing: ${registration}`); }
}
if (process.platform === 'win32') {
  for (const browser of ['Microsoft\\Edge', 'Google\\Chrome']) {
    for (const hive of ['HKCU', 'HKLM']) {
      const base = `${hive}\\Software\\Policies\\${browser}`;
      const query = args => {
        try { return execFileSync('reg.exe', ['query', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
        catch (error) { if (isMissingRegistration(error)) return ''; throw error; }
      };
      check(!/REG_DWORD\s+0x0\b/i.test(query([base, '/v', 'NativeMessagingUserLevelHosts'])), `${base}: user-level hosts allowed`);
      const values = text => [...text.matchAll(/REG_SZ\s+(.+)/g)].map(match => match[1].trim());
      const blocked = values(query([base + '\\NativeMessagingBlocklist']));
      const allowed = values(query([base + '\\NativeMessagingAllowlist']));
      check(!((blocked.includes('*') || blocked.includes(hostName)) && !allowed.includes(hostName)), `${base}: no effective host block`);
    }
  }
}
// Spawn the generated launcher itself, not just node main.js.
const child = process.platform === 'win32'
  ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${launcherPath}" ${callerOrigin}`], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], windowsVerbatimArguments: true })
  : spawn(launcherPath, [callerOrigin], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
const decoder = new NativeMessageDecoder(reason => check(false, reason));
child.stdout.pipe(decoder);
let diagnostics = '';
child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-4000); });
const timeout = setTimeout(() => { child.kill(); }, 60000);
let ready;
try {
  child.stdin.write(encodeNativeMessage({ type: 'hello', protocolVersion: 1, extensionVersion: '0.1.0' }));
  for await (const value of decoder) {
    const result = validateToExtension(value);
    check(result.success, 'Valid native protocol response');
    if (!result.success) break;
    if (result.data.type === 'error') { check(false, result.data.message); break; }
    if (result.data.type === 'ready') { ready = result.data; break; }
  }
  check(!!ready, 'Launcher starts native host and SDK');
  if (!ready && diagnostics) console.error(diagnostics);
  if (ready) { check(ready.signedIn, 'Signed in (otherwise run npm run login)'); console.log(`Extension: ${extensionId}\nData: ${ready.dataPath}\nHost: ${ready.hostVersion}; SDK: ${ready.sdkVersion}`); }
} finally {
  const exited = child.exitCode === null ? once(child, 'exit') : undefined;
  child.stdin.end();
  if (exited) await exited;
  clearTimeout(timeout);
}
if (failed) process.exitCode = 1;
