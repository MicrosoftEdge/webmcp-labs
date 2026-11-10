# Contributing to WebMCP Agent

Read the [repository contribution guidelines](../CONTRIBUTING.md) for CLA
requirements and the [Code of Conduct](../CODE_OF_CONDUCT.md) before contributing.
For first-time installation, see the [README](README.md).

## Prerequisites

- Node.js 22.12 or newer, including npm.
- Microsoft Edge or Google Chrome with WebMCP enabled for browser integration.
- Copilot access only for native-host authentication and live model checks.

Build and unit tests run on Windows, macOS and Linux in CI. Native browser flows
have been verified on Windows; macOS/Linux registration and fresh interactive
sign-in still need end-to-end verification.

## Build and reload

From `webmcp-agent`:

```sh
npm ci
npm run build
```

The build compiles the shared protocol, Node.js host and extension. Load
`extension/dist` as the unpacked extension, not its source directory.

After changing source files, rebuild, reload WebMCP Agent on the browser's
extensions page, then close and reopen the side panel. If the host still uses an
older build, use **Settings > Diagnostics > Reconnect host**.

`npm run setup` builds and registers the host for the current user. It is needed
for first installation, or after moving the checkout or changing Node
installations, not after every source edit.

## Tests

| Command | Scope |
|---------|-------|
| `npm run typecheck` | Type-check source, unit tests and UI tests. |
| `npm test` | Protocol/framing, SDK adapter, native host and worker routing, component and Markdown contracts. |
| `npm run test:ui` | Build and exercise the production panel with Playwright, synthetic SDK-shaped events and visual comparisons. |
| `npm run probe:sdk` | Check real SDK session, tool replacement and history APIs without a model prompt. |
| `npm run test:browser` | Real Edge extension, native messaging and local WebMCP fixtures, without model prompts by default. |

### Playwright

Install the lockfile-pinned Chromium before the first UI run:

```sh
npx playwright install chromium
npm run test:ui
```

UI tests do not require authentication or native-host registration. They replace
only the Chrome-port and clipboard boundaries, validate messages, block external
requests, and fail on unexpected browser errors. Shared interactions run once;
layout and visuals run at 320/440 px in light/dark mode.

After a build, use `npm run test:ui:run` to rerun without rebundling.
`npm run test:ui:report` opens the report. Tests use all available CPU cores by
default; pass `--workers=4` to reduce concurrency.

Visual baselines use Windows fonts. Review each changed image before accepting
an intentional update on Windows:

```sh
npm run test:ui:update -- visuals.spec.ts
```

Do not refresh baselines to hide unexplained failures. CI runs UI checks on
Windows and uploads failure reports, traces and screenshots. For concurrent runs
on one machine, set a distinct `WEBMCP_UI_PORT` in each shell; reports and test
output are separated by port. Playwright's `--shard` option is also supported.

### Native browser integration

Install the native host with `npm run setup`, authenticate with `npm run login`,
and check it with `npm run doctor`. Then run:

```sh
npm run test:browser -- --history --restricted-page
npm run test:browser -- --chrome --history --restricted-page
```

These runs use isolated browser profiles and SDK data homes. Fixtures cover
annotations, same-named cross-origin tools, dynamic registration, navigation,
and SDK chat switching. The local Contoso fixture creates a synthetic cart to
check deferred checkout-tool discovery, but does not execute checkout.

`WEBMCP_TEST_BROWSER` selects the browser executable; `--headed` shows the
browser. `WEBMCP_TEST_ARTIFACT_DIR` saves a final screenshot. For standalone
fixture debugging, `npm run fixtures` serves two localhost origins.

Live checks are opt-in and consume Copilot quota. They are not run by CI:

```sh
npm run probe:live -- --allow-model-calls
npm run test:browser -- --allow-model-calls --stop-test
```

`probe:live` uses up to three prompts. A browser run uses one prompt, plus one
each for `--stop-test` or `--confirm-test`. The latter exercises a consequential
synthetic order, so run it only when that test is intended.

## Architecture and SDK boundaries

| Component | Responsibility |
|-----------|----------------|
| React panel | Transient UI and user input; no separate conversation store. |
| Service worker | Native connection, window/tab binding, document identity and current tool catalogs. |
| Content script | Discover and execute genuine browser tool objects from `document.modelContext`. |
| Native host | Adapt page tools and events to SDK sessions, questions, history and logging. |
| Microsoft Copilot SDK | Agent loop, model calls, compaction and persisted conversation history. |

The npm package is `@github/copilot-sdk`. Keep the SDK as the source of truth:
do not add another agent loop or replay an extension-owned transcript into it.
Preserve SDK message/reasoning IDs, use `session.idle` for normal completion, and
use SDK abort events for stopped-response notices.

The tool allowlist is `custom:*` plus `builtin:ask_user`. File, shell, MCP and
other built-in tools are not enabled. SDK permission requests are rejected.
The model receives page context and declared tools, not DOM access or screenshots.
Consequential annotations influence the prompt; they are not permission gates.
Tool results are capped and untrusted output is wrapped, but these measures do
not guarantee protection against prompt injection.

Route tools by chat, tab, document and frame/tool key, not display name. Include
cross-origin tools only when the browser exposes them through `getTools({ fromOrigins })`
and the frame opts in. Browser settings and extension pages have no page tools.

Refresh the bound document's tools before completing a tool result. Await queued
SDK `setTools()` calls so the next model request sees the new catalog, including
deferred SPA registrations. Stop and navigation must cancel stale document calls.
`setTools()` is experimental; removed declarations can remain as unavailable
tombstones during an active turn, but must not retain executable routes.

Local `Port.disconnect()` does not fire that port's `onDisconnect` listener.
Explicitly reset connection state for idle shutdown, opening timeouts and manual
reconnects. Preserve saved chat IDs and ignore callbacks from replaced ports.

## Data and native-host registration

Only settings are stored in `chrome.storage.local`; session storage holds
window-to-chat IDs. Message history and tool provenance come from SDK events.

| OS | Application data |
|----|------------------|
| Windows | `%LOCALAPPDATA%\WebMCP Agent\` |
| macOS | `~/Library/Application Support/WebMCP Agent/` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/webmcp-agent/` |

`copilot-home` holds SDK state and application sign-in configuration; `workspace`
is an empty working directory. `WEBMCP_AGENT_DATA_DIR` overrides the application
data and log locations for isolated testing. The normal Copilot CLI home and its
sessions are not used; an existing GitHub CLI sign-in can still be reused.

Default logs contain metadata, not page arguments/results. Verbose logs can
contain both. Logs rotate at 5 MiB, retaining `host.log`, `.1` and `.2`. They live
under application data on Windows, `~/Library/Logs/WebMCP Agent/` on macOS, and
`${XDG_STATE_HOME:-~/.local/state}/webmcp-agent/` on Linux. Review before sharing.

The native host is `com.microsoft.webmcp_agent`. The committed public key fixes
the unpacked extension ID to `keoelciaibdnnbgchdgiamlafbedcmbj`; the host manifest
allows only that caller. No private signing key is stored.

Windows setup registers under the Edge and Google Chrome
`HKCU\Software\...\NativeMessagingHosts` keys. macOS/Linux use per-user
`NativeMessagingHosts` directories; setup also detects existing supported browser
channel directories. Generated launchers use the exact Node executable from setup.

Setup refuses to replace another checkout's registration. Use
`npm run setup -- --replace` only when intentionally switching installations.
`npm run unregister` removes only this checkout's registrations and preserves
chat, settings and authentication data.

`npm run doctor` checks the launcher, registration, SDK handshake and sign-in.
On Windows it also checks effective native-messaging policy; it does not change
policy. For browser-level diagnostics, launch with `--enable-logging --log-level=1`
and search its log for `native_messag` or `launch_context`.

## Security and support

Follow the shared [security policy](../SECURITY.md) for vulnerabilities; do not
open public issues for them. See [SUPPORT.md](../SUPPORT.md) for other questions
and bug reports. Do not include credentials or sensitive page data in reports.
