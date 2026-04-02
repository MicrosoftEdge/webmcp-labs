# Contributing to WebMCP Explorer

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+)

## Build

```bash
cd webmcp-explorer
npm install
npm run build
```

The built extension is output to `webmcp-explorer/dist/`.

## Dev (watch mode)

Auto-rebuilds on file save:

```bash
cd webmcp-explorer
npm run dev
```

After each rebuild, go to `edge://extensions` (or `chrome://extensions`) and click the refresh icon on the WebMCP Explorer card to pick up changes.

## Loading the extension

1. Open `edge://extensions` (or `chrome://extensions`)
2. Enable **Developer mode**
3. Click **Load unpacked** and select the `webmcp-explorer/dist/` folder
