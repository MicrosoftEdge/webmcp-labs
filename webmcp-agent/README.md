# WebMCP Agent

WebMCP Agent is an experimental side-panel extension for testing [WebMCP](https://github.com/webmachinelearning/webmcp)-enabled web pages with your GitHub Copilot account.

It uses the [Microsoft Copilot SDK](https://github.com/github/copilot-sdk) over a local native-messaging host to handle conversations, tool calling, and chat history. No LLM API keys or separate Copilot CLI install needed.

## Prerequisites

- **Node.js 22.12+** (includes npm) and **Git**
- **Microsoft Edge or Google Chrome 156+** with the WebMCP testing flag (for Edge, use [Edge Canary or Dev](https://explore.microsoft.com/edge/download/insider))
- **A GitHub account with Copilot access** (requests use your Copilot quota)

## Quick start

### 1. Clone and set up the local host

```sh
git clone https://github.com/MicrosoftEdge/webmcp-labs.git
cd webmcp-labs/webmcp-agent
npm ci
npm run setup
```

`npm run setup` builds the extension and host, registers the native-messaging host for this checkout, signs you in with GitHub (reusing `gh` CLI credentials or opening browser sign-in), and verifies the setup. Pass `-- --replace` to overwrite another checkout's registration.

Once setup finishes, you can close the terminal, but keep this checkout on disk since the browser launches the host from it. Run `npm run login` or `npm run doctor` on their own later if you need to re-authenticate or diagnose issues.

### 2. Enable WebMCP in your browser

1. Open `about://flags/#enable-webmcp-testing`.
2. Set **WebMCP for testing** to **Enabled**.
3. Relaunch the browser.

### 3. Load the unpacked extension

1. Open `about://extensions`.
2. Turn on **Developer mode**.
3. Select **Load unpacked** and choose `webmcp-agent/extension/dist` (not the `extension` source folder).

## Try it out

1. Open a WebMCP-enabled site, such as one of the demos in this repo:
   - [Contoso Pizza](https://microsoftedge.github.io/webmcp-labs/pizza-order/) (menu, order, and checkout tools)
   - [Idea Board](https://microsoftedge.github.io/webmcp-labs/idea-board/) (dynamically registered tools)
   - [Event Search](https://microsoftedge.github.io/webmcp-labs/event-search/) (declarative `<form>` tools)
2. Open **WebMCP Agent** from the Extensions menu or toolbar.
3. Check the **Tools** tab to inspect the page's tools, schemas, and annotations.
4. Switch to **Chat** and try a read-only prompt:

   > Show me the menu. Don't create an order.

5. Then try a multi-step prompt:

   > Add a large pepperoni pizza to my order, then ask me before checking out.

## How it works

```text
Web page (document.modelContext)
   ↕  content script + service worker
Extension side panel (Chat, Tools, History, Settings)
   ↕  Chrome/Edge native messaging (stdio)
Local Node.js host  ──▶  Microsoft Copilot SDK  ──▶  GitHub Copilot
```

- **Page tools only:** The agent can only call WebMCP tools declared by the active tab (plus an `ask_user` prompt for clarifying questions). It cannot read the DOM, take screenshots, or access local files, shells, or MCP servers.
- **Dynamic tool discovery:** Tool catalogs update automatically as pages navigate or register/unregister tools.
- **Tab-bound runs:** Runs stay bound to the tab where they started. Switching tabs mid-run pauses new tool calls so you can choose **Continue there** or **Stop**.
- **On-demand host:** The browser starts the local host when you open the side panel and exits it after 5 minutes of inactivity.

## WebMCP Agent vs. WebMCP Explorer

| | WebMCP Agent | [WebMCP Explorer](../webmcp-explorer/README.md) |
|---|---|---|
| **Model access** | GitHub Copilot account (no API keys) | Bring your own API key or local endpoint (Azure OpenAI, OpenAI, Anthropic, Ollama, etc.) |
| **Setup** | Build + local native-messaging host + GitHub sign-in | Load unpacked extension + configure provider in UI |
| **Agent loop & history** | Copilot SDK with persistent chat history and follow-up prompts | Browser-hosted Chat and Agent modes |
| **Best for** | Testing end-to-end Copilot agent flows and dynamic tool updates | Quick setup, switching providers, or inspecting raw tool-calling loops |

## Troubleshooting

Run `npm run doctor` from `webmcp-agent` to check host files, registration, policy blocks, SDK startup, and sign-in without using Copilot quota.

| Symptom | Fix |
|---------|-----|
| Host not installed or signed out | Run `npm run setup` (or `npm run login` to sign in again), then click **Reconnect host** in Settings. |
| "Another WebMCP Agent installation owns..." | Unregister the old checkout, or run `npm run setup -- --replace`. |
| Checkout moved or Node version changed | Rerun `npm run setup` to regenerate the launcher. |
| Native messaging blocked | Check `about://policy` for `NativeMessagingUserLevelHosts` or `NativeMessagingBlocklist`. |
| WebMCP testing flag missing | Update to Edge Canary/Dev or Chrome 156+. On macOS, launch the new browser channel once and rerun `npm run setup`. |
| No tools appear on a page | Confirm the flag is enabled, reload the page, and test with [Contoso Pizza](https://microsoftedge.github.io/webmcp-labs/pizza-order/). Browser and extension pages never expose tools. |
| Panel behaves strangely after updating | Reload the extension on `about://extensions`, then reopen the side panel (or click **Reconnect host** in Settings). |

## Uninstall

1. Run `npm run unregister` from `webmcp-agent`.
2. Remove **WebMCP Agent** from `about://extensions`.

This removes the host registration while preserving saved chats, settings, and sign-in data. See [CONTRIBUTING.md](CONTRIBUTING.md#data-and-native-host-registration) for local data and log paths if you also want to delete them.

## Security, privacy, and disclaimer

WebMCP Agent is an experimental developer tool, not a production browsing agent:

- **Data sent to Copilot:** Page context (title, URL, origin), tool metadata, and tool results can be sent to GitHub Copilot when you chat.
- **Local storage and logs:** Chats are stored locally by the Copilot SDK. **Verbose host logs** records tool arguments and results on disk; review logs before sharing and delete sensitive chats when done.
- **Untrusted pages:** Only use WebMCP Agent on sites you own, control, or trust. Pages can mislabel tools or attempt prompt injection, and annotations like `consequential` are hints rather than a security gate. See the WebMCP [Security and Privacy Considerations](https://github.com/webmachinelearning/webmcp#security-and-privacy-considerations).

Report security issues via [SECURITY.md](../SECURITY.md); see [SUPPORT.md](../SUPPORT.md) for bugs and questions.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for building, testing, and architecture details. Contributions follow the repository's [contribution guidelines](../CONTRIBUTING.md) and [Code of Conduct](../CODE_OF_CONDUCT.md).

## License

[MIT](../LICENSE.txt)
