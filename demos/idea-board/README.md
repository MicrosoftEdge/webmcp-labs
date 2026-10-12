# Idea Board: imperative WebMCP playground

[Open the playground](https://microsoftedge.github.io/webmcp-labs/idea-board/) | [Declarative playground guide](../event-search/README.md)

Ask an agent to build a sticky-note board and observe how the available tools
change with application state. This Markdown guide contains the prompts,
schemas, and expected transitions without requiring the visual page.

## Setup

1. Use an up-to-date Microsoft Edge Canary or Dev. Enable
   `about://flags/#enable-webmcp-testing`, then restart the browser.
   See [browser setup](https://github.com/MicrosoftEdge/webmcp-labs#test-webmcp-in-edge).
2. Load [WebMCP Explorer](https://github.com/MicrosoftEdge/webmcp-labs/tree/main/webmcp-explorer#load-the-webmcp-explorer-extension)
   and configure a tool-calling model, or use another agent with WebMCP access.
3. Open the playground and the agent on that page. Send the prompts below one
   at a time. Copying a prompt does not execute a tool.

The page checks for `document.modelContext.registerTool`. API support is not an
agent connection indicator. Without the API, no tools are registered, but the
code examples and this guide remain readable.

## Lesson 1: add ideas and discover tools

Suggested prompt:

> Add exactly three ideas for a weekend project to the board, using one sticky per idea. Then list the stickies and their IDs.

Expected sequence:

1. On an empty board, `add-sticky` and `list-stickies` are registered.
2. The first `add-sticky` call creates a note and registers `edit-sticky` and
   `clear-board`. Four tools are now available.
3. The third note registers `group-stickies`. Five tools are now available.
4. `list-stickies` returns the IDs, text, colors, and any group labels.

Inspect the board, the named tool list, and the activity log together. The
registration code tab shows how `inputSchema` describes inputs and `execute`
connects an agent invocation to an existing app function.

## Lesson 2: group the notes

After completing Lesson 1, send:

> List the stickies, then group all of their IDs under "Weekend projects".

The agent discovers the current IDs and calls `group-stickies`. Notes appear in
a labeled cluster. Grouping does not change the note count or unregister tools.
If the board has fewer than three notes, add notes first; grouping is not
registered yet. Use `edit-sticky` to change a note's text or color.

## Lesson 3: clear and unregister

Suggested prompt:

> Clear the board. Then list the stickies to confirm it is empty.

`clear-board` removes all notes and unregisters `edit-sticky`, `clear-board`,
and `group-stickies`. The two always-available tools remain.
`list-stickies` returns `The board is empty.`. Open the **Unregister** code tab
to connect this transition to `AbortController.abort()`.

| Board state | Registered tools |
|-------------|------------------|
| Empty | `add-sticky`, `list-stickies` |
| One or two notes | Above, plus `edit-sticky`, `clear-board` |
| Three or more notes | Above, plus `group-stickies` |
| After clearing | `add-sticky`, `list-stickies` |

## Tool inputs and results

All input schemas have root type `object`. IDs are strings, as returned in the
tool's textual result. Get current IDs with `list-stickies`; do not assume IDs
from a previous board session. Clearing resets the next ID to 1.

| Tool | Required inputs | Optional inputs | Result |
|------|-----------------|-----------------|--------|
| `add-sticky` | `text`: string | `color`: `yellow`, `blue`, `green`, or `pink`; defaults to `yellow` | Created note's ID, color, and text |
| `list-stickies` | None | None | Note count and each note's ID, text, color, and group, or `The board is empty.` |
| `edit-sticky` | `id`: string | `text`: string; `color`: one of the four colors | Updated note details, or `Error: sticky #<id> not found.` |
| `clear-board` | None | None | Number of removed notes |
| `group-stickies` | `label`: string; `stickyIds`: array of strings | None | Group label and matched IDs, or `Error: no matching stickies found.` |

The demo matches existing IDs when grouping. If some supplied IDs do not exist,
the result lists only matched IDs.

### Input schema equivalents

```json
{
  "add-sticky": {
    "type": "object",
    "properties": {
      "text": { "type": "string", "description": "The text content of the sticky note." },
      "color": {
        "type": "string",
        "enum": ["yellow", "blue", "green", "pink"],
        "description": "Sticky color. Defaults to yellow."
      }
    },
    "required": ["text"]
  },
  "list-stickies": { "type": "object", "properties": {} },
  "edit-sticky": {
    "type": "object",
    "properties": {
      "id": { "type": "string", "description": "The sticky ID (number shown on the note)." },
      "text": { "type": "string", "description": "New text content. Omit to keep current text." },
      "color": {
        "type": "string",
        "enum": ["yellow", "blue", "green", "pink"],
        "description": "New color. Omit to keep current color."
      }
    },
    "required": ["id"]
  },
  "clear-board": { "type": "object", "properties": {} },
  "group-stickies": {
    "type": "object",
    "properties": {
      "label": { "type": "string", "description": "Group label (e.g. \"User Research\", \"MVP Features\")." },
      "stickyIds": {
        "type": "array",
        "items": { "type": "string" },
        "description": "Array of sticky IDs to group together."
      }
    },
    "required": ["label", "stickyIds"]
  }
}
```

## Code equivalent: tool lifetime

This standalone example registers an edit tool and then unregisters it. In the
playground, the equivalent registration happens when the first sticky is added;
the abort happens when the board is cleared. An application supplies its own
editing logic inside `execute`.

```js
const controller = new AbortController();

document.modelContext.registerTool({
  name: 'edit-example',
  description: 'Demonstrate a tool with a controlled lifetime.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id']
  },
  execute: ({ id }) => `Received note ID ${id}.`
}, { signal: controller.signal });

// Later, when the action no longer applies:
controller.abort();
```

The registration's `options.signal` controls the **tool lifetime**. The signal
passed to an `execute` callback's options controls **invocation cancellation**.
They are separate concerns; the demo's callbacks do not implement asynchronous
cancellation.

## Observe and troubleshoot

- **Tools registered by this demo** lists the registrations maintained by the
  page and explains why each tool is available. Use the agent's tool list to
  confirm discovery; the page is not enumerating another agent's private state.
- Expand **Inspect inputSchema** on a tool to read the schema from its actual
  registration. Connect its required inputs to the prompt and its `execute`
  result to the activity log. Registration changes explain `registerTool` and
  the lifetime controlled by `options.signal`.
- **Tool results and lifecycle changes** keeps the last 10 page-observed results
  and registration changes, newest first. It does not expose agent reasoning.
  Each callback's inputs and returned result are shown together in the log.
- The board and log are in memory. Reloading resets both.
- If a tool is missing, check the required board state, browser setup, and the
  agent's refreshed tool list.
- When the API is unavailable, the tool badge reports zero, not a simulated
  registration count.

See [index.html](index.html) for the executable callbacks and dynamic registration
logic. The page's API reference also covers optional metadata, discovery, and
cross-origin exposure; those features are not exercised by this board.
