// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { defineConfig } from '@playwright/test';

const port = Number(process.env.WEBMCP_UI_PORT ?? 4178);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('WEBMCP_UI_PORT must be an integer from 1 to 65535.');
const baseURL = `http://127.0.0.1:${port}`;
const runSuffix = port === 4178 ? '' : `-${port}`;

export default defineConfig({
  testDir: './test-ui',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  failOnFlakyTests: !!process.env.CI,
  retries: 0,
  updateSnapshots: 'none',
  workers: '100%',
  outputDir: `test-results${runSuffix}`,
  timeout: 30_000,
  expect: {
    timeout: 5_000,
    toHaveScreenshot: { animations: 'disabled', caret: 'hide', maxDiffPixels: 0, threshold: 0.1 },
  },
  snapshotPathTemplate: '{testDir}/snapshots/{projectName}/{arg}{ext}',
  reporter: [['list'], ['html', { open: 'never', outputFolder: `playwright-report${runSuffix}` }]],
  use: {
    browserName: 'chromium',
    baseURL,
    viewport: { width: 440, height: 900 },
    locale: 'en-US',
    timezoneId: 'UTC',
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'interactions', testMatch: '**/sidepanel.spec.ts', use: { viewport: { width: 320, height: 900 }, colorScheme: 'light' } },
    { name: 'narrow-light', testMatch: '**/{layout,visuals}.spec.ts', use: { viewport: { width: 320, height: 900 }, colorScheme: 'light' } },
    { name: 'narrow-dark', testMatch: '**/{layout,visuals}.spec.ts', use: { viewport: { width: 320, height: 900 }, colorScheme: 'dark' } },
    { name: 'wide-light', testMatch: '**/{layout,visuals}.spec.ts', use: { colorScheme: 'light' } },
    { name: 'wide-dark', testMatch: '**/{layout,visuals}.spec.ts', use: { colorScheme: 'dark' } },
  ],
  webServer: {
    command: `npm run preview --workspace @webmcp-agent/extension -- --port ${port}`,
    url: `${baseURL}/sidepanel.html`,
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
