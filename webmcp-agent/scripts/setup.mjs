// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { dataDirectory } from '../host/dist/paths.js';
import { requireNode, root, launcherPath, manifestPath, registrations, registrationValue, isMissingRegistration, callerOrigin, extensionId, hostName } from './platform.mjs';

requireNode();
mkdirSync(dataDirectory(), { recursive: true });
for (const registration of registrations()) {
  let existing;
  try { existing = registrationValue(registration); }
  catch (error) {
    if (!isMissingRegistration(error)) throw error;
  }
  const expected = process.platform === 'win32' ? manifestPath : launcherPath;
  if (existing && existing !== expected && !process.argv.includes('--replace')) {
    throw new Error(`Another WebMCP Agent installation owns ${registration}. Unregister it, or rerun setup with --replace.`);
  }
}
const launcher = process.platform === 'win32'
  ? `@echo off\r\n"${process.execPath}" "%~dp0dist\\main.js" %*\r\n`
  : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$(dirname "$0")/dist/main.js" "$@"\n`;
writeFileSync(launcherPath, launcher, { mode: 0o755 });
if (process.platform !== 'win32') chmodSync(launcherPath, 0o755);
const nativeManifest = { name: hostName, description: 'WebMCP Agent host', path: launcherPath, type: 'stdio', allowed_origins: [callerOrigin] };
writeFileSync(manifestPath, JSON.stringify(nativeManifest, null, 2) + '\n');
for (const registration of registrations()) {
  if (process.platform === 'win32') execFileSync('reg.exe', ['add', registration, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], { stdio: 'pipe' });
  else { mkdirSync(dirname(registration), { recursive: true }); writeFileSync(registration, readFileSync(manifestPath)); }
}
console.log(`WebMCP Agent host registered. Extension ID: ${extensionId}`);
console.log(`Load unpacked: ${root}${process.platform === 'win32' ? '\\extension\\dist' : '/extension/dist'}`);
console.log('Enable WebMCP for testing in edge://flags or chrome://flags, then restart.');
console.log('Run npm run login, then npm run doctor. No terminal needs to stay open afterwards.');
