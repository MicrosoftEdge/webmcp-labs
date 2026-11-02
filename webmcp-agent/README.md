# WebMCP Agent

A browser side-panel agent that completes tasks using a page's WebMCP tools.
The Microsoft Copilot SDK runs the conversation and agent loop in a local
native-messaging host. The extension discovers and executes page tools; it does
not run another agent loop or persist another conversation transcript.

This is an experimental lab, not a production browsing agent. Website-declared
hints influence the model through its prompt, not through deterministic permission
gates. Use it on sites and fixtures you trust. WebMCP Explorer is unchanged.

## Setup

Requires Node.js **22.12 or newer**, npm, and Edge or Chrome **156 or newer** with
WebMCP for testing enabled. Version 156 is the minimum tested version; support for
155 has not been established.

From `webmcp-agent/`:

```sh
npm install
npm run setup
npm run login
npm run doctor
```

Then:

1. Open `edge://extensions` or `chrome://extensions` and enable Developer mode.
2. Choose **Load unpacked** and select `webmcp-agent/extension/dist`.
3. Enable **WebMCP for testing** at `edge://flags/#enable-webmcp-testing` or
   `chrome://flags/#enable-webmcp-testing`, then restart the browser.
4. Open a WebMCP-enabled page and reload it if it was open before installation.
5. Click the extension action to open WebMCP Agent.

Setup builds all three workspaces and registers the native host for the current
user. No terminal or HTTP server needs to remain open. The browser launches the
host when the panel connects. When no panel is open and no run is active, the
worker disconnects after five minutes and the host exits.

The committed public key gives all unpacked installations the same extension ID:
**`keoelciaibdnnbgchdgiamlafbedcmbj`**. Only this ID is allowed in the native-host
manifest. No private signing key is stored.

`npm run login` first checks the SDK's sign-in state. An existing GitHub CLI
sign-in works without signing in again. Otherwise it starts the bundled runtime's
interactive GitHub sign-in flow and prints its browser URL. It never silently
consents to plaintext credential storage. The normal Copilot CLI home and its
sessions are not used.

## Using the panel

- **Chat:** send a task, see streamed Markdown and optional reasoning, inspect
  tool arguments/results, answer question cards, or Stop. Enter sends; Shift+Enter
  inserts a newline. A model chip sits inside the empty composer before the first
  message; afterward, change models in Settings. The header's **+** starts a new
  chat.
- **Tools:** inspect every tool grouped by origin. Debugging tools remain visible
  but are hidden from the agent by default. **Run manually** executes directly on
  the page, without the model; it can change page state immediately.
- **History:** list, reopen, delete, or clear WebMCP Agent chats. Deletion requires
  confirmation in the UI. Creating a chat refreshes this list from the SDK
  automatically. Content is kept until deleted; there is no expiry.
- **Settings:** model, debugging tools, reasoning visibility, maximum tool-result
  characters, verbose logging, diagnostics, log copying, and host reconnect.

There is one active chat per browser window. An idle chat follows the active tab
on its next message. Switching tabs during a run pauses new tool calls. Continue
runs them on the **original** tab; switching back also continues. Stop cancels
the browser's in-flight call and aborts the SDK turn. Closing the bound tab stops
the run. Navigation invalidates old-document calls rather than routing them into
the new page.
Switching chats waits for SDK disconnect/resume and history loading to finish.
Selecting the currently open history entry reloads its SDK history without
disconnecting the session. The extension does not replay a separate transcript
into the SDK.

The model sees tool metadata, tool results, and a short page-context note. It
does not get DOM access or screenshots. Only the current `document.modelContext`
API is supported; there is no older testing-API or argument-format retry.

## Data and trust boundaries

| Component | Responsibility |
|-----------|----------------|
| React panel | Transient rendering and user input; Markdown raw HTML and remote images are not rendered |
| Service worker | Native connection, window/tab binding, document-aware routing, latest tool snapshots, settings |
| Content script | Top-frame tool discovery and execution, retaining genuine browser tool objects |
| Host | SDK sessions, declarations, questions, serial tool calls, results, history projection, logging |
| SDK runtime | Conversation state, model calls, compaction, and persisted session history |

Same-named tools from different origins or frames have different SDK names.
Names include a hashed origin label, but hashes are not authentication. Calls
are routed by chat, tab, document, and frame/tool key, never by display name alone.
Cross-origin iframe tools are included only when the browser exposes them to the
top document, using `getTools({ fromOrigins })` and the frame's opt-in exposure.
Non-HTTP(S) pages, including browser settings and extension pages, use `null` as
their protocol origin and have no page tools. This normalization is shared by
the browser and Node host, whose URL implementations handle internal origins
differently. Those pages can still open a chat.

The session allowlist is **`custom:*` plus `builtin:ask_user`**. The latter is a
verified, narrow exception required for question/confirmation cards. File, shell,
browser-control, search, MCP, and other built-in tools are not enabled. SDK
permission requests are rejected; page tools use the spec's prompt-only policy.

Consequential hints tell the model to summarize and confirm the exact action
unless the user already confirmed it. That is model behavior, not an enforcement
gate. Untrusted results are capped and enclosed in per-call random-ID markers
before the model reads them. Tool cards show the raw result before those markers.
Websites can mislabel tools and inject instructions; these mitigations are not
a guarantee against prompt injection.

Only settings are stored in `chrome.storage.local`; session storage holds
window-to-chat IDs, not message history. Reopening/reconnecting renders history
from SDK events. Historical tool provenance is recorded in that same SDK event
store, not in an extension transcript database.

The panel uses Fluent UI v9 controls and Fluent UI Contrib Chat for presentation.
Messages use React Markdown with GFM support for tables, task lists, strikethrough,
and autolinks, alongside headings, nested lists, blockquotes, and fenced code.
Code blocks preserve whitespace, show their language, and have a copy button.
Wide code and tables scroll inside their message rather than widening the panel.
Colors and typography follow the system's light/dark Fluent theme. Raw HTML and
remote images remain disabled, and unsafe link protocols are not rendered as links.
These components do not manage SDK sessions or run an agent loop.

### Data locations

| OS | WebMCP Agent data |
|----|-------------------|
| Windows | `%LOCALAPPDATA%\WebMCP Agent\` |
| macOS | `~/Library/Application Support/WebMCP Agent/` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/webmcp-agent/` |

`copilot-home/` holds SDK session state and application sign-in configuration;
`workspace/` is an empty working directory. Retained chats may contain sensitive
page content. Clear them in History when finished.

Logs rotate at 5 MiB, keeping `host.log`, `.1`, and `.2`. Windows uses the data
folder's `logs/`; macOS uses `~/Library/Logs/WebMCP Agent/`; Linux uses
`${XDG_STATE_HOME:-~/.local/state}/webmcp-agent/`.
Default logs contain metadata, not page arguments/results. Verbose mode includes
those contents, so review logs before sharing them.
SDK/session errors are also printed in the panel and service-worker developer
consoles. The host log retains error messages and stack traces, not just error
names. Failed history loads are reported immediately rather than left waiting
for an opening timeout.

`WEBMCP_AGENT_DATA_DIR` overrides the entire data location for isolated tests.
The host always supplies an explicit SDK `baseDirectory` and removes inherited
explicit tokens and runtime-path overrides. It does not configure `~/.copilot`.

## Registration and troubleshooting

Host name: **`com.microsoft.webmcp_agent`**. Generated launchers use the exact
Node executable from setup, independent of the browser's PATH.

| OS | Per-user registrations |
|----|------------------------|
| Windows | `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.microsoft.webmcp_agent` and the corresponding `Google\Chrome` key |
| macOS | `NativeMessagingHosts/` under `~/Library/Application Support/Microsoft Edge` and `Google/Chrome`; existing Edge Beta/Dev/Canary and Chrome Canary directories are included |
| Linux | `NativeMessagingHosts/` under `~/.config/microsoft-edge` and `google-chrome`; existing Beta/Dev/unstable profile directories are included; honors `XDG_CONFIG_HOME` |

Setup refuses to replace registrations pointing to another checkout unless
explicitly run with `npm run setup -- --replace`. Moving the checkout or changing
Node installations requires rerunning setup.

`npm run doctor` checks the launcher itself, native manifest/ID, registrations,
SDK handshake, and sign-in. On Windows it also checks HKCU/HKLM native-messaging
policies, including wildcard blocks and allowlist exceptions. It does not modify
policies. If policy blocks user-level hosts, ask the device administrator.

| Symptom | Action |
|---------|--------|
| Host not installed | Run setup, then Reconnect in the panel |
| Host forbidden/blocked | Run doctor; inspect `edge://policy` or `chrome://policy` |
| Signed out | Run login, then Reconnect |
| No tools on a page | Enable the testing flag, reload the site, and check its WebMCP registration |
| Extension reloaded while panel open | Close and reopen the panel |
| Tool identity changed during a run | Stop and start a new turn with the updated tools |

For browser native-messaging diagnostics, launch the browser with
`--enable-logging --log-level=1` and search its log for `native_messag` or
`launch_context`.

`npm run unregister` removes only registrations belonging to this checkout.
It preserves chats, settings, and sign-in data. Remove the unpacked extension
through the browser's extensions page separately.

## Development and verification

```sh
npm run typecheck
npm test
npm run fixtures
```

Fixtures run on two localhost origins, with hints, same-named iframe tools,
dynamic registration, navigation, and a cancellable call. The test runner builds
the extension and host first. CI checks types and unit tests on Windows, macOS,
and Linux, with GitHub Actions pinned to full commit SHAs.

```sh
# No model prompts; temporary isolated SDK home.
npm run probe:sdk

# Requires installed native-host registration; isolated browser/data profiles.
npm run test:browser
npm run test:browser -- --chrome
npm run test:browser -- --restricted-page
npm run test:browser -- --history
npm run test:browser -- --markdown

# Explicit model-quota opt-in; synthetic fixtures only.
npm run probe:live -- --allow-model-calls
npm run test:browser -- --chrome --allow-model-calls --confirm-test
npm run test:browser -- --allow-model-calls --stop-test
```

`WEBMCP_TEST_BROWSER` selects a browser executable on another platform.
The browser test defaults to Windows Edge or Chrome paths. It uses native
Node.js CDP support and does not download browsers. On official Chrome builds,
it loads the unpacked extension through the extension-debugging API rather than
the unsupported `--load-extension` flag.
The composer/Markdown presentation checks inject SDK-shaped messages into an
isolated preview document. They exercise streaming and rendering without model
calls or modifying production chat history.

`probe:live` uses up to three prompts; a browser run uses one, plus one each for
`--confirm-test` and `--stop-test`. These commands are not run by CI. Browser
tests remove their owned temporary profile and data home after shutting down.

### Verified behavior (Windows, November 2, 2026)

SDK **1.0.28**, bundled runtime **1.0.105**, Node.js **26.13.0**:

| Check | Result |
|-------|--------|
| Setup, launcher, native manifest, per-user registration, doctor | Passed for Edge and Chrome |
| Existing GitHub CLI sign-in | Passed without another login |
| Isolated home, custom declarations, tool replacement, listing, disconnect/resume | Passed |
| External tool completion, questions, model switching, populated history and recall | Passed with synthetic prompts |
| Genuine content-script access to `document.modelContext` | Passed in Edge 156.0.4314.58 and Chrome 156.0.8078.74 |
| Chat startup on restricted browser pages | Passed in both browsers without a panel protocol error or invalid native message |
| New chat and repeated History selection | Passed in both browsers, including reopening the current chat and switching among stored SDK sessions |
| Fluent chat and Markdown presentation | Passed in both browsers at 320/440 px in light/dark themes, including streaming fences, GFM tables/lists, code copying, blocked HTML/media, and 4.5:1 body-text contrast |
| Same-named cross-origin iframe tools and manual inspector execution | Passed in both browsers |
| Dynamic registration/removal | Passed in both browsers |
| Live SDK/native-host/page-tool/assistant round trip | Passed in both browsers |
| Tab switch holds calls; Continue uses original tab | Passed in both browsers |
| Host restart restores populated history and clean displayed user text | Passed in both browsers |
| Consequential tool waits for confirmation | Passed in Chrome's synthetic order fixture; still model-dependent |
| Stop cancels a real in-flight WebMCP call | Passed in Edge's cancellation fixture |

Ten synthetic model prompts were used in the initial verification. No real-site
tasks or repository contents were sent to the model.

Not yet manually verified: fresh interactive sign-in on a signed-out machine,
macOS/Linux host registration and browser operation, elapsed five-minute idle
shutdown, and tasks against Contoso Pizza/Idea Board. Unit tests cover idle-alarm
routing and the host's refusal to send while signed out; those checks do not
substitute for manual platform and fresh-account testing.

SDK `setTools()` is experimental. During a turn the host retains removed
declarations as unavailable tombstones so a call from an older model request can
still receive an explicit failure. New turns replace the active set. If an SDK
name would change identity mid-run, the update fails explicitly instead of
silently invoking another tool.

## References

- [Copilot SDK](https://github.com/github/copilot-sdk)
- [Current WebMCP draft](https://webmachinelearning.github.io/webmcp/)
- [Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Edge native messaging](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/native-messaging)

## License

[MIT](../LICENSE.txt)
