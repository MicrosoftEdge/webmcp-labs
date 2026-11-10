// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { defineConfig } from 'vite';
export default defineConfig({
  build: {
    emptyOutDir: false,
    lib: { entry: 'src/content/index.ts', name: 'WebMCPAgentContent', formats: ['iife'], fileName: () => 'content.js' },
    target: 'chrome155',
  },
});
