# WebMCP Explorer

A browser extension for inspecting, debugging, and interacting with WebMCP-enabled web pages.

## Prerequisites

- A Chromium-based browser (e.g. Edge or Chrome)
- An LLM API key (see [Provider Setup](#provider-setup))

## Quick Start

1. Enable the WebMCP for testing flag at `about://flags/#enable-webmcp-testing`
1. Clone the repo:`git clone https://github.com/MicrosoftEdge/webmcp-labs.git`
1. Open `about://extensions`
1. Enable **Developer mode**
1. Click **Load unpacked** and select the `webmcp-explorer/dist/` folder
1. Click the extension icon in the toolbar to open the side panel
1. Go to the **Config** tab and set up your LLM provider

## Demo Page

Navigate to the pizza ordering demo to test tool calling:

**https://victorhuangwq.github.io/pizza-order-demo/**

Open the WebMCP Explorer side panel, switch to the **Chat** or **Agent** tab, and try asking it to place an order.

## Provider Setup

Go to the **Config** tab in the side panel. Select a provider, fill in the fields, and click **Save**. Use **Test Connection** to verify.

### Azure OpenAI

| Field | Description |
|---|---|
| **Endpoint URL** | Your Azure OpenAI resource endpoint (e.g. `https://your-resource.openai.azure.com/`) |
| **API Key** | Key from Azure Portal → your resource → Keys and Endpoint |
| **Deployment Name** | The name of your model deployment |
| **API Version** | API version string (default: `2025-03-01-preview`) |

### OpenAI

| Field | Description |
|---|---|
| **API Key** | From [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| **Model** | e.g. `gpt-5`, `gpt-5.3-chat` |

### Anthropic

| Field | Description |
|---|---|
| **API Key** | From [console.anthropic.com](https://console.anthropic.com/) |
| **Model** | e.g. `claude-sonnet-4-6` |

### Chat Completions API (Ollama, LM Studio, etc.)

Use any OpenAI-compatible endpoint, local or remote. Works with Ollama, LM Studio, llama.cpp, vLLM, and other servers that expose the `/v1/chat/completions` route.

| Field | Description |
|---|---|
| **Base URL** | Server URL (e.g. `http://localhost:11434/v1` for Ollama) |
| **API Key** | Optional. Leave blank if the server doesn't require authentication |
| **Model** | Model name served by the endpoint (e.g. `llama3`, `mistral`) |

> **Note:** The model must support tool calling. When you click **Test Connection**, the extension sends a probe request with a dummy tool. If the model doesn't return a tool call, you'll see a warning that tool-based features may not work.

## Extension Tabs

| Tab | Purpose |
|---|---|
| **Tools** | Lists WebMCP tools exposed by the current page. Execute them manually with custom JSON args. |
| **Agent** | Run or step through an autonomous agent loop that uses page tools to accomplish a goal. |
| **Chat** | Conversational interface with tool calling. Useful for demoing WebMCP to stakeholders. |
| **Config** | Set up LLM provider credentials and tune settings (max iterations, max chat messages). |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for build instructions and development workflow.

## Disclaimer

WebMCP Explorer is a developer tool for exploring and demoing the WebMCP API. It is intentionally a thin harness: tool metadata and execution results from the page are passed to the LLM as-is. That makes it useful for seeing how WebMCP behaves end to end, but it also means a hostile page can manipulate the model through the tools it registers. Use it on sites you own, control, or otherwise trust.

Hardening agents against the realities of the open web is an active area of discussion for the WebMCP community. See the WebMCP community group's [Security and Privacy Considerations](https://github.com/webmachinelearning/webmcp/blob/main/docs/security-privacy-considerations.md) for the current state of that conversation.
