// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { defineConfig } from 'vite';
import { copyFileSync } from 'node:fs';

export default defineConfig({
  plugins: [{ name: 'manifest', closeBundle() {
    copyFileSync('manifest.json', 'dist/manifest.json');
    copyFileSync('../README.md', 'dist/README.md');
  } }],
  build: {
    rollupOptions: {
      onwarn(warning, warn) {
        // Server-component boundaries do not apply to a client-only extension.
        if (warning.code === 'MODULE_LEVEL_DIRECTIVE' && warning.message.includes('"use client"')) return;
        warn(warning);
      },
      input: { sidepanel: 'sidepanel.html', background: 'src/background/index.ts' },
      output: { entryFileNames: '[name].js' },
    },
    target: 'chrome155',
  },
});
