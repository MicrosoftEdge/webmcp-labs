# Contributing to WebMCP Explorer

## Prerequisites

To contribute to WebMCP Explorer, you need to have the following installed on your device:

- [Node.js](https://nodejs.org/) (v18+)

## Build

The source code for the extension is located in the `/webmcp-explorer/src/` directory, and build artifacts are output to the `/webmcp-explorer/dist/` directory.

To rebuild the extension from source:

```bash
cd webmcp-explorer
npm install
npm run build
```

## Build in watch mode (for development)

To avoid manually rebuilding the extension after each change, you can use the watch mode, which automatically rebuilds the extension whenever a source file is modified:

```bash
cd webmcp-explorer
npm run dev
```

## Tests

The provider and conversation-history tests use Node's built-in test runner and TypeScript stripping. Run them with Node.js v22.18+ or v24+; no additional test dependencies are needed.

```bash
cd webmcp-explorer
npm test
npm run build
```

The Prompt API tests use a mock of the native tool-use contract to cover translation, capability errors, cancellation, and session cleanup. To check an actual browser/model implementation, load the extension, select **Prompt API (built-in, experimental)**, and click **Test Connection**. Then use Chat and Agent (including step mode) on a trusted WebMCP page.

### Browser integration tests

The Playwright tests exercise the built side panel using an isolated temporary profile. Playwright is pinned to 1.65.1, which provides Chromium 159.0.8154.6 (revision 1255). From `webmcp-explorer`, install and select that browser in PowerShell:

```powershell
npx playwright install chromium
$env:WEBRUN_BROWSER = node --input-type=module -e "import { chromium } from 'playwright'; console.log(chromium.executablePath());"
npm run test:browser
```

In a macOS/Linux shell, use `export WEBRUN_BROWSER="$(node --input-type=module -e "import { chromium } from 'playwright'; console.log(chromium.executablePath());")"` after installing Chromium. To test another installed Chromium browser, set `WEBRUN_BROWSER` to its absolute executable path instead. Rerun `npx playwright install chromium` after updating Playwright.

This command rebuilds the extension before running the tests. The tests serve only local build assets and mock extension APIs, page-tool execution, and model responses; no cloud credentials, real page tools, or model downloads are used. They cover Config's native round trip, Chat replay, Agent stepping and user replies, unsupported APIs, and cancellation/reset races. A separate check reports the browser's real Prompt API globals without installing the model mocks. That capability check is not a real-model inference test or proof of API availability in an extension context.

### Real extension end-to-end tests

Use a Chrome for Testing build with native Prompt API tool use and WebMCP support:

```powershell
$env:WEBRUN_BROWSER = 'C:\path\to\chrome-win64\chrome.exe'
npm run test:e2e
```

This suite loads the actual unpacked extension and opens its actual side panel in a normal, temporary browser profile. It serves the repository's Idea Board demo on loopback and uses real native WebMCP tools, extension messaging, and `chrome.storage`, with no API or model mocks. It checks tool discovery, execution, dynamic registration, invalid arguments, saved configuration, and Agent pause/Stop.

It also requires Config's native model round trip to succeed before exercising model-driven Chat and Agent page mutations. Missing native support or model provisioning failures **fail** the prerequisite test; dependent model tests are explicitly reported as blocked/skipped, never as successful. The browser can download a model, and model preparation is allowed up to ten minutes. Availability itself has the provider's 30-second limit.

The runner enables the Prompt API, native tool-use backend/model flags, the model manifest broker, and WebMCP. It keeps component updates and `OptimizationHints` enabled, unlike Playwright's default setup. Extra native features can be appended using `WEBRUN_ENABLE_FEATURES`. No personal browser profile or cloud credentials are used. Its launch arguments match Playwright 1.65.1's defaults; revisit the flags when updating Playwright. A matching browser installation does not guarantee that its experimental native tool-use interface matches the provider or that the on-device model is available.

## Load the extension

To use the extension in your browser, load it from the `webmcp-explorer/dist/` folder, as an unpacked extension:

1. Open a new browser window or tab.
1. Go to `about://extensions`.
1. Enable the **Developer mode** setting.
1. Click the **Load unpacked** button.
1. Select the `/webmcp-explorer/dist/` folder.

## Reload the extension after a build

After each rebuild, including in watch mode, you must reload the extension the browser:

1. Go to `about://extensions`.
1. Under the **WebMCP Explorer** extension entry, click **Reload**.
