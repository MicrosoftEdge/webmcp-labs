# Copilot Instructions

## Code Style

- Prefer slightly verbose, descriptive names over abbreviations (e.g. `ProviderMetadata` over `ProviderMeta`, `FieldDefinition` over `FieldDef`).

## WebMCP Explorer Extension

- **Build**: `cd webmcp-explorer && npm run build`
- **Dev (watch)**: `cd webmcp-explorer && npm run dev`
- **Load extension**: Load `webmcp-explorer/dist/` as unpacked extension in `edge://extensions` (developer mode)
- After editing any file under `webmcp-explorer/src/`, always run `cd webmcp-explorer && npm run build` to rebuild the extension before confirming the change is done.
