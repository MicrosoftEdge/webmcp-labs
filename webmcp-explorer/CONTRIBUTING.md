# Contributing to WebMCP Explorer

## Prerequisites

To contribute to WebMCP Explorer, you need to have the following installed on your device:

- [Node.js](https://nodejs.org/) (v18.17+; a currently supported LTS release is recommended)

## Build

The source code for the extension is located in the `/webmcp-explorer/src/` directory, and build artifacts are output to the `/webmcp-explorer/dist/` directory.

To rebuild the extension from source:

```bash
cd webmcp-explorer
npm install
npm run build
```

## Tests

```bash
cd webmcp-explorer
npm test
```

The Copilot regression tests use Node's built-in test runner and the existing
Vite build tooling, with no additional test dependencies. They exercise a mocked
SDK runtime over real loopback HTTP: pairing, origins/Host checks, request limits,
page-tool result handoff (including parallel calls), cancellation, expiry,
cleanup, protocol validation, and removal of legacy browser-stored GitHub tokens.
They also assert the SDK tool-restriction configuration. They do not install or
run the real SDK, require credentials, or consume subscription usage.

To exercise the settings UI without an account or additional dependencies:

```bash
cd webmcp-explorer
npm exec vite -- . --host 127.0.0.1 --port 4173
```

Open `http://127.0.0.1:4173/tests/config-pane.html`. The fixture mocks network
requests and extension storage. Use only fake pairing tokens. Verify model
discovery, safe rendering of remote labels, save/reload, and forgetting
credentials without losing the pre-populated OpenAI settings. Remote model
labels containing HTML must display as text, not execute as markup.

## Build in watch mode (for development)

To avoid manually rebuilding the extension after each change, you can use the watch mode, which automatically rebuilds the extension whenever a source file is modified:

```bash
cd webmcp-explorer
npm run dev
```

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
