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
