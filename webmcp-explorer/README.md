# WebMCP Explorer

A browser extension for inspecting, debugging, and interacting with WebMCP-enabled web pages.

## Prerequisites

- A Chromium-based browser (Edge or Chrome)
- An LLM API key (see [Provider Setup](#provider-setup))

## Quick Start

1. Open `edge://extensions` (or `chrome://extensions`)
2. Enable **Developer mode**
3. Click **Load unpacked** and select the `webmcp-explorer/dist/` folder
4. Click the extension icon in the toolbar to open the side panel
5. Go to the **Config** tab and set up your LLM provider

## Demo Page

Navigate to the pizza ordering demo to test tool calling:

**https://victorhuangwq.github.io/pizza-order-demo/**

Open the WebMCP Explorer side panel, switch to the **Chat** or **Agent** tab, and try asking it to place an order.

## Provider Setup

Go to the **Config** tab in the side panel. Select a provider, fill in the fields, and click **Save**. Use **Test Connection** to verify.

### Azure OpenAI (recommended)

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

## Extension Tabs

| Tab | Purpose |
|---|---|
| **Tools** | Lists WebMCP tools exposed by the current page. Execute them manually with custom JSON args. |
| **Agent** | Run or step through an autonomous agent loop that uses page tools to accomplish a goal. |
| **Chat** | Conversational interface with tool calling — useful for demoing WebMCP to stakeholders. |
| **Config** | Set up LLM provider credentials and tune settings (max iterations, max chat messages). |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for build instructions and development workflow.
