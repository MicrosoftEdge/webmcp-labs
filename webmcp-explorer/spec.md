# Spec: webmcp-explorer — Chrome Extension for WebMCP

## Overview

A Chrome Side Panel extension that lets developers inspect, debug, and interact with WebMCP-enabled web pages. It connects to the `ModelContextTesting` browser API to list/execute tools, and supports autonomous agent loops powered by OpenAI and Azure OpenAI.

**Extension type:** Edge Manifest V3, side panel (Chromium-based; also compatible with Chrome)  
**Build output:** `webmcp-explorer/dist/` — load as unpacked extension via `edge://extensions`  
**Language:** TypeScript (bundled)  
**Dependencies:** `openai` npm package (covers both OpenAI and Azure OpenAI via `AzureOpenAI` class)
**Design system:** MAI design tokens via CSS custom properties (`--smtc-*`)
**API key storage:** `chrome.storage.local` (per-extension isolated, encrypted at rest by Chrome)

---

## WebMCP IDL (ModelContextTesting)

The extension interacts with pages via the `ModelContextTesting` interface exposed by Chromium:

```webidl
dictionary RegisteredTool {
  required DOMString name;
  required DOMString description;
  DOMString inputSchema;
};

dictionary ExecuteToolOptions {
  AbortSignal signal;
};

interface ModelContextTesting : EventTarget {
  sequence<RegisteredTool> listTools();
  Promise<DOMString?> executeTool(DOMString tool_name, DOMString input_arguments, optional ExecuteToolOptions options = {});
  attribute EventHandler ontoolchange;
};
```

The extension injects a content script that accesses `ModelContextTesting` on the page. The side panel communicates with the content script via `chrome.tabs.sendMessage`.

### Error Handling (from Chromium source)

`executeTool()` rejects with `DOMException` (code `UnknownError`) for these `ScriptToolErrorCode` values:

| Error Code | Message |
|---|---|
| `kInvalidToolName` | "Tool was not executed due to invalid name" |
| `kInvalidInputArguments` | "Tool was not executed due to invalid input arguments" |
| `kMissingRequiredSubmitButton` | "Tool was not executed due to missing required submit button" |
| `kToolInvocationFailed` | "Tool was executed but the invocation failed" |
| `kToolCancelled` | "Tool was cancelled" |

Additional behaviors:
- `toolchange` event is **non-cancelable** and **non-bubbling**
- Error messages may include additional context appended after `": "`

---

## UI Architecture

The side panel contains a **tab bar** (styled after MAI `tablist`/`tab` pattern) with three panes:

### 1. Tools Pane

**Purpose:** List all WebMCP tools registered on the current page and let the user inspect/execute them individually.

- Calls `listTools()` on page load and on `ontoolchange` events
- Displays a scrollable list of tool cards (MAI card pattern) showing:
  - Tool **name** (bold)
  - Tool **description** (secondary text)
  - Expandable **input schema** (JSON, syntax-highlighted, MAI accordion pattern)
- Each tool card has an **"Execute"** button (MAI button styling) that opens a tool input UI
- **Tool input:** toggle between **schema-driven form UI** (auto-generated from `inputSchema`, MAI input/dropdown styling) and **raw JSON textarea**
- Execution result displayed inline below the tool card
- **Refresh** button to manually re-fetch tools
- **Badge** showing tool count in the tab header

### 2. Agent Pane

**Purpose:** Run an autonomous agent loop that uses WebMCP tools to accomplish a user-defined goal.

- User enters a **goal** in a text input at the top
- **"Run" / "Stop"** button to start/abort the loop
- Agent loop logic:
  1. Send goal + available tools (from `listTools()`) + built-in agent tools + conversation history to the configured LLM
  2. LLM responds with either a tool call or a final answer
  3. If tool call → `executeTool()` (or handle built-in tools) → append result to history → repeat
  4. If final answer → display and stop
  5. Configurable **max iterations** (default: 10) as safety limit
- **Built-in agent tools** (injected alongside WebMCP tools):
  - `task_complete` — agent calls this when the goal is achieved; includes a summary message
  - `ask_user` — agent calls this to request clarification; pauses the loop and prompts the user for input, then resumes
- System prompt: simple, max ~5 steps guidance, WebMCP-aware (e.g. "You have tools to interact with the current web page. Use them to accomplish the user's goal. Call task_complete when done. Call ask_user if you need more information.")
- Displays a **step-by-step trace** showing each iteration:
  - LLM reasoning/thought
  - Tool called + arguments
  - Tool result
  - Final answer
- Each step is an expandable card (MAI accordion pattern)
- MAI-styled spinner shown during LLM calls and tool execution
- MAI-styled message bar for errors (e.g., API failures, tool execution errors)
- AbortController wired to the Stop button → passes `signal` to `executeTool()`


### 3. Configuration Pane

**Purpose:** Configure LLM provider settings and extension preferences.

- **Provider selection** dropdown (MAI dropdown styling):
  - OpenAI
  - Azure OpenAI
- Per-provider fields:
  - **OpenAI:** API key, model name (dropdown: gpt-4o, gpt-4o-mini, etc.)
  - **Azure OpenAI:** endpoint URL, API key, deployment name, API version
- **Common settings:**
  - Max agent iterations (number input, default 10)
- **Save** button (MAI button styling) → persists to `chrome.storage.local`
- **Test Connection** button → sends a minimal request to validate credentials
- MAI-styled message bar for save confirmation / validation errors
- All sensitive fields (API keys) shown as password inputs (MAI input styling) with show/hide toggle

---

## Extension Architecture

```
webmcp-explorer/
├── manifest.json              # Chrome Manifest V3
├── package.json               # npm project, TypeScript
├── tsconfig.json
├── vite.config.ts             # Vite bundler config (with CRXJS or manual)
├── src/
│   ├── sidepanel/
│   │   ├── index.html         # Side panel HTML shell
│   │   ├── index.ts           # Entry point, tab routing
│   │   ├── styles.css         # Global styles, MAI design tokens
│   │   ├── tools-pane.ts      # Tools pane logic
│   │   ├── agent-pane.ts      # Agent pane UI + loop logic
│   │   └── config-pane.ts     # Configuration pane logic
│   ├── content-script.ts      # Injected into pages, bridges ModelContextTesting
│   ├── service-worker.ts      # Extension service worker
│   ├── lib/
│   │   ├── llm/
│   │   │   ├── provider.ts     # LLMProvider interface
│   │   │   ├── openai.ts      # OpenAIProvider extends LLMProvider
│   │   │   └── azure-openai.ts # AzureOpenAIProvider extends LLMProvider
│   │   └── storage.ts         # chrome.storage.local wrapper
│   └── types/
│       └── webmcp.d.ts        # TypeScript types for ModelContextTesting IDL
└── README.md
```

## Messaging Architecture

```
[Web Page: ModelContextTesting API]
        ↕ (window / DOM)
[Content Script: content-script.ts]
        ↕ (chrome.tabs.sendMessage / onMessage)
[Side Panel: pane modules]
        ↕ (openai npm package)
[LLM APIs: OpenAI / Azure OpenAI]
```

[Service Worker: service-worker.ts] — handles extension lifecycle (side panel open on icon click)

- **Content script** is auto-injected on every page via manifest `content_scripts`
- Content script accesses `ModelContextTesting` and responds to messages
- Side panel panes call `chrome.tabs.sendMessage(tabId, ...)` directly to interact with the content script
- LLM API calls go directly from the side panel (not through the content script)
- **Permissions:** `activeTab` only (minimal), plus `sidePanel` and `storage`
- **Tool call execution:** sequential only (one tool at a time), no parallel tool calls

## LLM Provider

A common `LLMProvider` interface with implementations for OpenAI and Azure OpenAI, both using the `openai` npm package.

```typescript
interface LLMProvider {
  chatCompletion(messages: ChatMessage[], tools: ToolDefinition[], options?: { signal?: AbortSignal }): Promise<ChatCompletion>;
}
```

- **`OpenAIProvider`** — extends `LLMProvider`, wraps `new OpenAI({ apiKey })`
- **`AzureOpenAIProvider`** — extends `LLMProvider`, wraps `new AzureOpenAI({ endpoint, apiKey, deployment, apiVersion })`
- Config pane instantiates the correct provider class directly based on the selected provider type
- Tool definitions are mapped from `RegisteredTool` (with `inputSchema` parsed as JSON Schema) to the `tools` parameter format expected by the SDK

## MAI Design Implementation

The entire extension UI should look and feel like a native MAI (Microsoft AI) application:

- Use MAI CSS design token naming convention (`--smtc-*` custom properties) for all colors, spacing, typography, and radii
- Component patterns to replicate with tokens:
  - **Tablist / Tab** — tab bar with active indicator, hover/focus states
  - **Button** — primary, secondary, and ghost variants
  - **Card** — elevated surface with consistent padding and border radius
  - **Accordion** — expandable/collapsible sections with chevron indicator
  - **Input / Textarea** — bordered inputs with focus ring, label styling
  - **Dropdown / Select** — styled select with custom chevron
  - **Spinner** — loading indicator for async operations
  - **Message bar** — info, success, warning, error notification bars
- Light/dark mode via `prefers-color-scheme` media query, swapping token values
- MAI typography scale for headings, body text, and labels
- Pure CSS + vanilla TS — no external UI component dependencies

---

## Implementation Steps

### Phase 1: Scaffolding
1. Create `webmcp-explorer/` subfolder with `manifest.json`, `package.json`, `tsconfig.json`, Vite config
2. Set up TypeScript build pipeline with Vite
3. Create `manifest.json` with side_panel, content_scripts, service_worker permissions
4. Create basic side panel HTML shell with tab navigation

### Phase 2: WebMCP Content Script (*parallel with Phase 3*)
5. Define TypeScript types for `ModelContextTesting` IDL in `types/webmcp.d.ts`
6. Implement content script that accesses `ModelContextTesting` and handles messages
7. Implement service worker for extension lifecycle

### Phase 3: LLM Provider (*parallel with Phase 2*)
8. Define `LLMProvider` interface in `provider.ts`
9. Implement `OpenAIProvider` and `AzureOpenAIProvider` extending the interface
10. Implement `storage.ts` wrapper for `chrome.storage.local`

### Phase 4: UI Panes (*depends on Phase 2 & 3*)
11. Implement Configuration pane (needed first for other panes to work)
12. Implement Tools pane
13. Implement Agent pane with loop logic

### Phase 5: Polish
14. Error handling and edge cases (no tools available, API errors)
15. Light/dark mode theming

---

## Verification

1. `npm run build` succeeds with no TypeScript errors
2. Extension loads in Chrome via `chrome://extensions` (developer mode, load unpacked)
3. Side panel opens and shows three tabs
4. Navigate to a WebMCP-enabled test page:
   - Tools pane lists registered tools
   - Tools pane refreshes on `ontoolchange`
   - Execute a tool and see the result
5. Configure an LLM provider in Configuration pane:
   - Settings persist across extension restarts
   - "Test Connection" validates credentials
6. Agent pane: enter a goal, run the loop, observe step-by-step trace
7. Verify `chrome.storage.local` stores API keys properly
8. Verify AbortController cancels in-flight tool executions and LLM calls

## Key Decisions

- **Side panel** (not DevTools panel) — more accessible and doesn't require DevTools to be open
- **`openai` npm package** — single SDK for both OpenAI and Azure OpenAI (`AzureOpenAI` class), no custom HTTP/SSE layer
- **TypeScript + npm** — no React/Vue/Angular
- **MAI design tokens** — adopt `--smtc-*` CSS custom properties for consistent styling, no `@mai-ui` package dependency
- **Agent built-in tools** — `task_complete` and `ask_user` injected alongside WebMCP tools
- **Content script** — auto-injected on every page via manifest
- **Permissions** — `activeTab` (minimal), `sidePanel`, `storage`
- **Tool calls** — sequential execution only (no parallel)
- **Agent history** — in-memory only, lost on panel close
