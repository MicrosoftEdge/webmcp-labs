# WebMCP Agent

A browser side-panel extension for testing WebMCP-enabled websites with an agent
powered by the GitHub Copilot SDK. Inspect page tools, give the agent a task,
and review its tool calls and results.

The SDK runs the conversation and agent loop in a local native-messaging host.
The extension discovers and executes page tools; it does not run another agent
loop or persist another conversation transcript.

This is an experimental lab, not a production browsing agent. Website-declared
hints influence the model through its prompt, not through deterministic permission
gates. Use it on sites and fixtures you trust. WebMCP Explorer is unchanged.

## Setup

These instructions cover **Windows and macOS**. This is a local source install:
you build the extension and its Node.js host, then load the extension unpacked
in your browser. You do not need a separate Copilot CLI installation, provider
API key, or local HTTP server.

Windows installation and browser flows have been verified. macOS build/unit
checks pass in CI, but the macOS browser/native-host setup still needs
end-to-end verification.

### 1. Install the prerequisites

- **Node.js 22.12 or newer**, including npm.
- **Git**, to clone this repository.
- **Microsoft Edge or Google Chrome 156 or newer**, with the WebMCP testing flag
  available. Version 156 is the minimum tested version.
- **A GitHub account with Copilot access.** Model requests use that account's
  Copilot quota.

On macOS, open your chosen browser once before running setup. This lets the
installer detect its existing browser-channel profile directory.

### 2. Get the code and run setup

Use **PowerShell on Windows** or **Terminal on macOS**. The commands are the
same on both platforms. If you already have the repository, go to its
`webmcp-agent` directory and run just the two npm commands.

```sh
git clone https://github.com/MicrosoftEdge/webmcp-labs.git
cd webmcp-labs
cd webmcp-agent
npm ci
npm run setup
```

`npm run setup` builds all three workspaces and registers the native-messaging
host for your current user. You do not need to run `npm run build` separately
for this first installation, or run the terminal as an administrator.

Keep the cloned folder after setup. The browser launches the host from this
checkout, using the Node executable that ran setup.

### 3. Sign in and check the installation

From the same directory:

```sh
npm run login
npm run doctor
```

If login prints a browser URL, open it and complete GitHub sign-in. An existing
GitHub CLI sign-in can be reused; GitHub CLI itself is not a prerequisite.

Doctor should report passing checks for the host launcher, registration, SDK
handshake, and sign-in. It does not send a model prompt or check your remaining
Copilot quota.

### 4. Enable WebMCP in the browser

| Browser | Open this flags page |
|---------|----------------------|
| Edge | `edge://flags/#enable-webmcp-testing` |
| Chrome | `chrome://flags/#enable-webmcp-testing` |

Set **WebMCP for testing** to **Enabled**, then relaunch the browser. If the flag
is missing, use a current Canary build that exposes it. On macOS, if you switch
to Canary after setup, open that browser once and rerun `npm run setup` so its
profile receives the native-host registration.

### 5. Load the extension

1. Open `edge://extensions` or `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select the built extension folder inside your checkout:

| Platform | Folder to select |
|----------|------------------|
| Windows | `webmcp-agent\extension\dist` |
| macOS | `webmcp-agent/extension/dist` |

Select `dist`, not the source `extension` folder. It should contain
`manifest.json`.

### 6. Try a first task

Open the [Contoso Pizza demo](https://microsoftedge.github.io/webmcp-labs/pizza-order/).
Reload the page if it was already open before you installed the extension.
Click **WebMCP Agent** in the browser's Extensions menu or toolbar to open the
side panel.

The **Tools** tab should show the page's registered tools. In **Chat**, try:

> Show me the menu. Don't create an order.

The agent can call the page's tools through the SDK; Chat shows those calls
and their results.

After setup, you can close the terminal. The browser starts the host when the
panel connects. When no panel is open and no run is active, the worker
disconnects after five minutes and the host exits.

`npm run login` first checks the SDK's sign-in state. An existing GitHub CLI
sign-in works without signing in again. Otherwise it starts the bundled runtime's
interactive GitHub sign-in flow and prints its browser URL. It never silently
consents to plaintext credential storage. The normal Copilot CLI home and its
sessions are not used.

## Using the panel

- **Chat:** send a task, see streamed Markdown and optional reasoning, inspect
  tool arguments/results, answer inline questions, or Stop. Enter sends; Shift+Enter
  inserts a newline. A model chip sits inside the empty composer before the first
  message; afterward, change models in the dedicated Settings view. Assistant
  messages show the concrete model reported by the SDK as a small badge; its
  tooltip explains when Auto selected that model. The empty state links to the
  number of page tools available. Tool activity is collapsed by default. The
  header's **+** starts a new chat. Reasoning is a collapsed disclosure in
  conversation-event order, not a lingering "Thinking" status below the reply.
  It is a transient SDK-event projection, not a second persisted transcript.
  An explicit SDK abort adds a quiet **Response stopped** notice without
  replacing the partial reply. The notice is reconstructed from the SDK's
  stored abort event when reopening History; stopping does not delete the chat.
  Questions appear inline without a separate
  boxed heading. Choices are
  full-width suggestion buttons; free-form answers use a compact input with an
  accessible send action. These still answer the SDK's original question.
- **Tools:** owns the active-page title, origin and tool counts. Tools are compact,
  expandable rows grouped by origin, without a separate page-summary card.
  Consequential and hidden-tool badges remain visible in collapsed rows; expanded
  details show all declared hints. Technical names and JSON schemas are under
  **Technical details**. Debugging tools remain visible but are hidden from the
  agent by default. **Run manually** opens a compact JSON form with explicit
  Execute and Cancel actions. Execution runs directly on the page,
  without the model; it can change page state immediately.
- **History:** opens directly into compact conversation rows, without a duplicate
  heading or storage blurb. Rows open SDK-owned chats. Delete is in each
  row's overflow menu, alongside **Copy chat ID** for debugging. Copying remains
  available while the current turn runs; a clipboard failure shows the ID for
  manual copying. Successful copying is announced only to screen readers,
  without adding visible text or moving the chat list. The SDK-generated title is used when available; a new
  untitled session is simply `New chat`. Creating a chat refreshes this list
  from the SDK automatically. Content is kept until deleted; there is no expiry.
- **Settings:** the single gear opens a dedicated view for model, chat display,
  page tools, limits, diagnostics and deleting all chats. It never expands
  inside Chat. Conversation, Page tools, Diagnostics and Data and privacy use
  the same flat sections, field sizing, helper text and right-aligned switches.
  Host metadata and the bounded log viewer stay in a disclosure; copying logs
  reports success or an explicit clipboard error.

The browser supplies the WebMCP Agent title. Inside the panel, Chat, Tools,
History, **+** and Settings share a single navigation row; there is no duplicate
product heading. Normal `Connected` state and repeated chat/page titles are omitted.
Connecting, signed-out and offline states appear only when relevant.
Chat shows page-context UI only for exceptional states; the full context belongs
to Tools.

The model control is a Fluent-styled native select, not an editable/searchable
combobox. The browser handles opening, scrolling and keyboard navigation; there
is no custom popup or query/focus synchronization. Choosing a different model
sends one SDK `set_model` request and remembers the preference, without refreshing
page tools. Opening or dismissing the picker does not make SDK requests.
The composer and model selector share one borderless inner surface and one
outer focus indicator. The footer matches the panel background; keyboard and
Windows high-contrast focus remain visible without nested field outlines.
Canvas styles apply only to the root Fluent provider, not to the provider
classes Fluent copies into tooltip/menu portals. Floating controls must not
become opaque, viewport-height overlays.
Navigation and the composer stay inside a viewport-height layout. Only the
conversation scrolls, including reasoning, tool activity and question prompts.
New output follows the bottom while you are there; scrolling up to read older
messages pauses that following until you return to the bottom or send a message.
Tool activity uses a quiet, borderless disclosure row. Status, embedded origin,
arguments and raw results remain available without stacked cards.

There is one active chat per browser window. An idle chat follows the active tab
on its next message. Switching tabs during a run pauses new tool calls. Continue
runs them on the **original** tab; switching back also continues. Stop cancels
the browser's in-flight call and aborts the SDK turn. Closing the bound tab stops
the run. Navigation invalidates old-document calls rather than routing them into
the new page.

### SDK proxy contract

The SDK owns the agent loop, conversation persistence and completion decisions.
The host adapts browser context and page-tool declarations, routes tool outcomes
back to their SDK request IDs, and forwards the selected SDK events to the panel.
There is no extension conversation database or second agent loop.

User messages appear when the SDK emits `user.message`, not when the worker
merely sends a request. SDK assistant message IDs are preserved through deltas,
final replies and saved history, so separate replies cannot overwrite each
other. Final text replaces the matching streamed projection. Reasoning blocks
similarly retain their SDK IDs, with complete reasoning replacing its deltas.
Legacy history/fixture items without IDs remain supported.
Rejected authentication/tool preparation releases the pending send state,
without inventing an accepted user message or leaving the browser stuck busy.
New-session listing is requested after the SDK history-open completion, rather
than the early `chat_opened` notification; rows still come only from SDK metadata.

Normal completion is forwarded from `session.idle`, not `assistant.message`,
`assistant.turn_end`, `assistant.idle`, a reasoning label or a timeout.
SDK `abort` events are forwarded separately with their original event ID and
reason. The panel displays cancellation only for that event, never from an idle,
error or offline notification alone. Replayed abort IDs do not duplicate notices.
SDK-originated aborts clear queued browser routes without invoking abort again.
Toolbar-badge failures cannot block questions, idle delivery or reconnection. Stop returns
failures for pending page calls and invokes SDK abort even if a result callback
fails; callback errors remain explicit rather than being treated as success.
Questions resolve the SDK's original input handler after an answer is validated.
After a page tool settles, the worker discovers the bound page's current tools
and sends any changed catalog before returning the tool result to the host.
The host waits for all queued SDK `setTools()` calls to finish before completing
the SDK's pending tool request, so the next model request sees the new tools.
Failed SDK updates are not silently bypassed.

Full-document navigation immediately invalidates old-document tools and holds
the pending result until the replacement page finishes loading and is queried.
The content-script receiver is installed at `document_start`, before load
completion, so discovery does not race a later idle-time script injection.
That wait is cancellable with Stop and fails explicitly after 30 seconds.
History API navigation, fragment changes and WebMCP `toolchange` events also
refresh discovery. Concurrent discovery results cannot overwrite a newer
snapshot; queries target the captured browser document ID. A single event-loop
yield after page execution lets deferred next-step registrations run before
the worker queries them, as in Contoso's create-order-to-checkout transition.
Unchanged snapshots do not trigger redundant SDK tool replacements.
Routine navigation refresh does not add notices to the chat; genuine failures
remain visible.

Page-tool serialization and tab/document safety are transport responsibilities,
not agent decisions. Tool-result truncation and untrusted-output wrapping are
documented below; this is a scoped WebMCP adapter, not a pass-through for every
Copilot SDK feature.
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

The committed public key gives all unpacked installations the same extension ID:
**`keoelciaibdnnbgchdgiamlafbedcmbj`**. Only this ID is allowed in the native-host
manifest. No private signing key is stored.

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
dynamic registration, navigation, and a cancellable call. Unit tests compile the
TypeScript projects without bundling the UI; `test:ui` builds the extension first.
CI checks types and unit tests on Windows, macOS, and Linux, with GitHub Actions
pinned to full commit SHAs.

### Automated regression layers

| Layer | Command | Scope |
|-------|---------|-------|
| Vitest | `npm test` | Protocol/framing, host lifecycle, SDK adapter, worker routing, static component and Markdown contracts |
| Playwright | `npm run test:ui` | Built side-panel UI in pinned Chromium, real pointer/keyboard input, SDK-shaped events, and visual comparisons |
| Native integration | `npm run test:browser` | Real installed extension, content scripts, native registration, SDK lifecycle and genuine cross-origin WebMCP fixtures |

The Playwright suite needs **no sign-in, native host registration, secrets or
model quota**. Only the Chrome port boundary and clipboard are replaced; the
production React bundle and CSS run unchanged. Each test starts in a fresh
browser context. Incoming host events and outgoing requests are schema-checked,
external network requests are blocked, and unexpected console/page errors fail
the test. SDK calls are not simulated as a second agent loop.

```sh
npx playwright install chromium
npm run test:ui
npm run test:ui -- --project=interactions
# After one build, rerun without rebundling:
npm run test:ui:run -- --workers=4
npm run test:ui:report
```

The `interactions` project runs shared behavior once, rather than repeating
identical routing/keyboard assertions for each theme and width. It covers the
native model picker, composer, SDK question choices/free-form answers, history
loading/fragments and ID copying, chronological reasoning, tooltip/menu portals, manual tools, reconnect and safe
Markdown/copy failure behavior.
The four layout projects retain 320/440 px in light/dark mode for animation-frame
scroll checks, composer growth/focus and all 32 reviewed screenshots. Markdown
and neutral tool metadata retain 4.5:1 contrast assertions. No reviewed image
baselines were removed. Settings adds collapsed/expanded diagnostics views in
each theme and width, plus alignment and text-contrast checks.

Playwright runs independent test contexts concurrently, using all available
CPU cores by default. Override with `--workers=4` to reduce concurrency (or
`--workers=1` for debugging).
CI uses the same scheduler; native integration remains separate from the fast
UI loop. Playwright's `--shard=1/2` and `--shard=2/2` also work. For concurrent
invocations on the **same machine**, build once, then use separate shells with
distinct preview ports; reports and test output are isolated by port:

```powershell
# Shell 1
$env:WEBMCP_UI_PORT = '4179'
npm run test:ui:run -- --shard=1/2

# Shell 2
$env:WEBMCP_UI_PORT = '4180'
npm run test:ui:run -- --shard=2/2
```

The corresponding output folders are `playwright-report-4179` /
`test-results-4179` and `playwright-report-4180` / `test-results-4180`. Run
`npm run test:ui:report -- playwright-report-4179` to open a nondefault report.

CI runs the full UI suite on Windows Server 2025 with the lockfile-pinned
Playwright browser to match the committed Windows/Segoe UI visual baselines.
Interaction tests can also run on macOS/Linux; pixel comparisons are skipped there because
font rasterization differs. UI failures upload the HTML report, screenshots,
expected/actual pixel diffs and traces as `webmcp-agent-ui-failure` for seven days.
There are no automatic retries or silently accepted missing baselines.

For an **intentional** visual change, review each image before updating baselines
on Windows with `npm run test:ui:update -- visuals.spec.ts`. Commit the reviewed
PNG changes with the UI change. Do not refresh snapshots to make an unexplained
failure green. `npx playwright show-trace <trace.zip>` opens a failure trace.
These deterministic UI checks do not replace the real-extension/native-host
integration tests below or prove that every browser compositor flash is fixed.

```sh
# No model prompts; temporary isolated SDK home.
npm run probe:sdk

# Requires installed native-host registration; isolated browser/data profiles.
npm run test:browser
npm run test:browser -- --chrome
npm run test:browser -- --restricted-page
npm run test:browser -- --history

# Explicit model-quota opt-in; synthetic fixtures only.
npm run probe:live -- --allow-model-calls
npm run test:browser -- --chrome --allow-model-calls --confirm-test
npm run test:browser -- --allow-model-calls --stop-test
```

`WEBMCP_TEST_BROWSER` selects a browser executable on another platform.
The browser test defaults to Windows Edge or Chrome paths. It uses native
Node.js CDP support and does not download browsers. On official Chrome builds,
it loads the unpacked extension through the extension-debugging API rather than
the unsupported `--load-extension` flag. Add `--headed` to watch integration
execution. Each run owns its browser profile, data home and fixture/debugging
ports, so Edge and Chrome integration can run independently in parallel.
Synthetic composer/Markdown/picker/component scenarios now live only in
Playwright; their old `test:browser` flags are rejected with a migration message.
`WEBMCP_TEST_ARTIFACT_DIR` can save a final integration screenshot.

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
| Redesigned information architecture | Passed in both browsers: page context appears only in Tools, Settings is a dedicated gear destination, normal Connected state is hidden, tool/history rows are compact, the composer auto-grows without covering the response, and SDK model metadata renders on assistant messages |
| Question and tool presentation | Passed at 320/440 px in both themes, including choices/free-form answers, high-contrast focus, tool provenance, 4.5:1 neutral metadata contrast, manual JSON validation, execution/cancel and explicit result/error states; also exercised in the actual Edge sidebar |
| Same-named cross-origin iframe tools and manual inspector execution | Passed in both browsers |
| Navigation/tool-result synchronization | Worker/content/host regressions cover deferred registration, SPA/hash changes, document loading, stale discovery, cancellation and SDK update ordering; browser integration builds a synthetic cart in the actual Contoso demo and sees checkout before create-order returns, then verifies hard-navigation replacement |
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
shutdown, and live-agent tasks against Contoso Pizza/Idea Board. The Contoso
navigation regression uses manual create-order only, without inference or
checkout execution. Unit tests cover idle-alarm
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
