// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { build } from 'vite';

const output = await mkdtemp(fileURLToPath(new URL('../node_modules/.copilot-tests-', import.meta.url)));
try {
  await build({
    configFile: false,
    logLevel: 'error',
    build: {
      ssr: fileURLToPath(new URL('./copilot.test.ts', import.meta.url)),
      outDir: output,
      emptyOutDir: false,
      rollupOptions: { output: { entryFileNames: 'copilot.test.mjs' } },
    },
  });
  const result = spawnSync(process.execPath, ['--test', join(output, 'copilot.test.mjs')], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(output, { recursive: true, force: true });
}
