// Copyright (c) Microsoft Corporation. Licensed under the MIT License.
import { unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { registrations, registrationValue, isMissingRegistration, manifestPath, launcherPath } from './platform.mjs';

for (const registration of registrations()) {
  try {
    const expected = process.platform === 'win32' ? manifestPath : launcherPath;
    if (registrationValue(registration) !== expected) {
      console.warn(`Not removing a registration owned by another installation: ${registration}`);
      continue;
    }
    if (process.platform === 'win32') execFileSync('reg.exe', ['delete', registration, '/f'], { stdio: 'pipe' });
    else unlinkSync(registration);
    console.log(`Removed ${registration}`);
  } catch (error) {
    if (isMissingRegistration(error)) console.warn(`Registration missing: ${registration}`);
    else throw error;
  }
}
console.log('Chats and sign-in data were retained. Use Clear WebMCP chats in the panel to delete chats.');
