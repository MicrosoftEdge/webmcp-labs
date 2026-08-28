# WebMCP Explorer

A browser extension for inspecting, debugging, and interacting with WebMCP-enabled web pages.

## Prerequisites

- A Chromium-based browser (e.g. Edge or Chrome)
- An LLM API key (see [Provider Setup](#provider-setup))

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
