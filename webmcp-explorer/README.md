# WebMCP Explorer

A browser extension for inspecting, debugging, and interacting with WebMCP-enabled web pages.

## Prerequisites

- A Chromium-based browser (e.g. Edge or Chrome)
- An LLM API key or an eligible GitHub Copilot subscription (see [Provider Setup](#provider-setup))

## Load the WebMCP Explorer extension

To load the WebMCP Explorer extension:

1. Clone this git repo: `git clone https://github.com/MicrosoftEdge/webmcp-labs.git`.
1. Open a new browser window or tab.
1. Go to `about://extensions`.
1. Enable the **Developer mode** setting.
1. Click the **Load unpacked** button.
1. In the file explorer, navigate to where you cloned the webmcp-labs repository.
1. Select the `/webmcp-explorer/dist/` folder to load the extension in your browser.
1. Click the webmcp-explorer extension icon in the browser toolbar to open the extension side panel.
1. In the side panel, click **Config**, and set up your LLM provider. See [Provider Setup](#provider-setup), below.

## Use the WebMCP Explorer extension

To use the WebMCP Explorer extension, first enable WebMCP in your browser:

1. Open a new browser window or tab.
1. Go to `about://flags/#enable-webmcp-testing`.
1. In the **WebMCP for testing** section, select **Enabled**.
1. Restart your browser.

To use the extension:

1. In your browser open a site that uses WebMCP. For example, go to the [Contoso Pizza demo](https://microsoftedge.github.io/webmcp-labs/pizza-order/).
1. Open the WebMCP Explorer side panel.
1. In the side panel, click **Chat** or **Agent**, and ask the agent to place an order. For example, click **Agent**, type "Order pepperoni pizza for a party of 10, deliver to 123 main road", and press **Enter**.

## Provider setup

The WebMCP Explorer extension requires an LLM provider to function. You can choose from multiple providers.

To configure your LLM provider:

1. In the WebMCP Extension side panel, click **Config**.
1. Under **Provider**, select a provider.
1. Fill the fields. The required information depends on the provider. See the sections below for more details.
1. Click **Save**.
1. Optionally, click **Test Connection** to verify your settings.

### Azure OpenAI

| Field | Description |
|---|---|
| **Endpoint URL** | Your Azure OpenAI resource endpoint (e.g. `https://your-resource.openai.azure.com/`) |
| **API Key** | Key from Azure Portal → your resource → Keys and Endpoint |
| **Deployment Name** | The name of your model deployment (e.g. `gpt-5.6-sol`) |
| **API Version** | API version string (default: `2025-03-01-preview`) |

### OpenAI

| Field | Description |
|---|---|
| **API Key** | From [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| **Model** | e.g. `gpt-5.6-sol` |

### Anthropic

| Field | Description |
|---|---|
| **API Key** | From [console.anthropic.com](https://console.anthropic.com/) |
| **Model** | e.g. `claude-opus-5` |

### GitHub Copilot (local companion)

This provider uses the documented
[GitHub Copilot SDK](https://github.com/github/copilot-sdk) and its
[CLI authentication](https://github.com/github/copilot-sdk/blob/main/docs/auth/authenticate.md).
The extension does not call private Copilot endpoints, implement GitHub OAuth,
reuse another application's OAuth client ID, or read CLI credential files.
Your Copilot subscription, model availability, usage charges, and account policies
still apply. The companion is a local, single-user service, not a hosted gateway.

#### Start the companion

1. Install **Node.js 22.12+** and the
   [official Copilot CLI](https://github.com/github/copilot-cli#installation).
   Run the following command in your terminal and complete its GitHub authorization
   instructions:

   ```powershell
   copilot login
   ```

   Never paste a GitHub credential into the extension.
1. Install and build the isolated companion package:

   ```bash
   cd webmcp-explorer/copilot-service
   npm ci
   npm run build
   npm start -- --cli-path "$env:APPDATA\npm\node_modules\@github\copilot\npm-loader.js"
   ```

   Run `npm start` (or `npm run start`), not `npm run` by itself: the latter
   only lists available scripts.

1. Keep its terminal running. After SDK startup and authentication succeed, it
   prints `http://127.0.0.1:8787` and a **service pairing token**. This token is a
   separate local secret, not a GitHub token.
1. In the extension's **Config** tab, select **GitHub Copilot (local service)**,
   enter the URL and pairing token, and click **Refresh models**.
1. Select a discovered model, click **Save**, and optionally **Test Connection**.
   Testing sends a real Copilot request and can consume subscription usage.

The SDK normally manages its bundled CLI. If an explicit CLI executable is needed,
pass `npm start -- --cli-path "<path>"` or set `WEBMCP_COPILOT_CLI_PATH` in the
companion's environment to an SDK-compatible executable or JavaScript entry
point. The command-line option takes precedence over the environment variable.
The companion uses the CLI's normal sign-in and credential handling.
Revoked credentials must be renewed in the CLI.

**Already signed in, but the service reports otherwise?** The SDK's bundled CLI
can differ from the installation used by `copilot login`. Select that same
installation explicitly. For a globally npm-installed CLI on Windows, run the
following in the `copilot-service` directory:

```powershell
npm start -- --cli-path "$env:APPDATA\npm\node_modules\@github\copilot\npm-loader.js"
```

The first `--` tells npm to forward `--cli-path` to the service. The value is the
path to the CLI, not a GitHub credential. Rebuild with `npm run build` after
updating the service source to use the new option.

This example applies to the standard Windows global npm prefix. If your CLI was
installed elsewhere, use its actual executable or JavaScript entry point, not a
PowerShell or batch wrapper. This setting selects the CLI; it does not copy or
replace credentials. Pass the option on each start, or set
`WEBMCP_COPILOT_CLI_PATH` in your local environment to keep using `npm start`
without arguments.

#### Local service behavior

- The service binds only to `127.0.0.1`. `WEBMCP_COPILOT_PORT` changes its port.
  Remote URLs, `localhost` aliases, URL credentials, and URL query strings are
  deliberately rejected. Do not tunnel or expose the service publicly.
- Every API operation requires the pairing token. By default a new token is
  generated on each start, requiring the extension's saved token to be updated.
  A strong `WEBMCP_COPILOT_SERVICE_TOKEN` can be supplied by your local secret
  management if stable pairing is needed. Never commit it.
- The extension stores only connection settings and the pairing token in
  `chrome.storage.local`, which is not an encrypted vault. GitHub credentials
  remain under CLI control. Host permission is limited to loopback HTTP.
- The SDK can request only the registered WebMCP tools. Their execution remains
  in the existing browser Chat/Agent loop, including step mode and user questions.
  SDK built-in shell, filesystem, network, and subagent tools are not permitted.
  The companion does not fetch URLs or run commands supplied by page tools.
- SDK conversations are closed after final responses, cancellation, and normal
  loop completion. Abandoned sessions expire after 15 minutes. There are at most
  16 simultaneous sessions and a 1 MiB request-body limit.
  The working directory is temporary; session state uses the CLI's configured
  store so the SDK can delete its transcripts during cleanup.
- New runs reconstruct the existing text/tool transcript as explicit prompt data;
  the SDK's high-level session API is not an OpenAI-compatible inference endpoint.
  During a run, tool results are returned through real SDK tool handlers, not
  fabricated or independently executed by the companion.

**Forget credentials** removes only this provider's local connection settings.
It does not sign out the CLI or stop requests already running; stop those first.
Use the CLI's own sign-out controls to revoke its local sign-in. Configurations
from the previous direct-endpoint Copilot implementation are automatically
removed on load, including their browser-stored GitHub token.

> **Release readiness:** The companion pins the published SDK
> `1.0.0-beta.4`, a public-preview/beta dependency. A documented API is not a
> promise of stable production compatibility. Actual SDK installation, companion
> compilation, and the live-account checks in [CONTRIBUTING.md](CONTRIBUTING.md)
> must pass before shipping. The mocked regression suite is not a substitute.

### Chat Completions API (Ollama, LM Studio, etc.)

Use any OpenAI-compatible endpoint, local or remote. Works with Ollama, LM Studio, llama.cpp, vLLM, and other servers that expose the `/v1/chat/completions` route.

| Field | Description |
|---|---|
| **Base URL** | Server URL (e.g. `http://localhost:11434/v1` for Ollama) |
| **API Key** | Optional. Leave blank if the server doesn't require authentication |
| **Model** | Model name served by the endpoint (e.g. `llama3`, `mistral`) |

> **Note:** The model must support tool calling. When you click **Test Connection**, the extension sends a probe request with a dummy tool. If the model doesn't return a tool call, you'll see a warning that tool-based features may not work.

## Extension tabs

Here is a description of each tab in the WebMCP Explorer side panel:

| Tab | Purpose |
|---|---|
| **Tools** | List of the WebMCP tools that are exposed by the currently loaded page. You can run each tool individually with custom JSON arguments. |
| **Agent** | To run or step through an autonomous agent loop that uses page tools to accomplish a user goal. |
| **Chat** | Conversational interface with tool calling. |
| **Config** | To set up your LLM provider credentials and alter settings such as the maximum agent iterations and maximum chat messages. |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for build instructions and development workflow.

## Disclaimer

WebMCP Explorer is a developer tool for exploring and demoing WebMCP. It is intentionally a thin harness: tool metadata and execution results from the page are passed to the LLM as-is. That makes it useful for seeing how WebMCP behaves end-to-end, but it also means a page could manipulate the model through the tools it registers. Use WebMCP Explorer only on sites you own, control, or otherwise trust.

Hardening agents against the realities of the open web is an active area of discussion for the WebMCP community. See the Web Machine Learning Community Group's [Security and Privacy Considerations](https://github.com/webmachinelearning/webmcp#security-and-privacy-considerations) for the current state of that conversation.
