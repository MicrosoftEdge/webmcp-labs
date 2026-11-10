# WebMCP Agent

A browser side-panel agent powered by the [Microsoft Copilot SDK](https://github.com/github/copilot-sdk)
that discovers and uses a page's WebMCP tools. The SDK manages conversations and
the agent loop through a local native-messaging host.

## Prerequisites

- **Node.js 22.12 or newer**, including npm.
- **Git**.
- **Microsoft Edge or Google Chrome 156 or newer**, with the WebMCP testing flag.
- **A GitHub account with Copilot access**. Model requests use your Copilot quota.

These instructions cover Windows and macOS. Windows setup has been verified;
macOS build and unit checks pass in CI, but native-host setup still needs
end-to-end verification. On macOS, open your browser once before running setup.

## Build and install the WebMCP Agent extension

### First-time setup

This is a local source install: build the extension and register its native host
before loading it. Use PowerShell on Windows or Terminal on macOS:

```sh
git clone https://github.com/MicrosoftEdge/webmcp-labs.git
cd webmcp-labs
cd webmcp-agent
npm ci
npm run setup
npm run login
npm run doctor
```

`npm run setup` runs `npm run build` to compile the extension and Node.js host,
then registers the host for your current user. A separate build is not needed
for this first installation.
`login` reuses an existing sign-in when available or starts GitHub sign-in.
`doctor` checks installation and authentication without sending a model prompt.
You do not need an administrator terminal, a separate Copilot CLI installation,
an LLM API key, or a terminal left running.

Keep the cloned folder after setup: the browser launches the host from it.
If you move the folder or change Node installations, rerun `npm run setup`.

### Load the built extension

After the build and setup complete, enable WebMCP and load the extension:

1. Open `edge://flags/#enable-webmcp-testing` or `chrome://flags/#enable-webmcp-testing`.
2. Set **WebMCP for testing** to **Enabled**, then relaunch the browser.
3. Open `edge://extensions` or `chrome://extensions`.
4. Enable **Developer mode** and choose **Load unpacked**.
5. Select the built extension folder:

| Platform | Folder inside your checkout |
|----------|-----------------------------|
| Windows | `webmcp-agent\extension\dist` |
| macOS | `webmcp-agent/extension/dist` |

Select `dist`, not the source `extension` folder. If the testing flag is missing,
use a current Canary build that exposes it. On macOS, open the new browser
channel once and rerun setup so it receives the host registration.

### Rebuild after source changes

From the `webmcp-agent` directory, run:

```sh
npm run build
```

This rebuilds the extension in `extension/dist` and the Node.js host. Reload
WebMCP Agent on the browser's extensions page, then close and reopen the side
panel. Source-only changes do not require rerunning setup.

## Use the WebMCP Agent extension

1. Open a WebMCP-enabled site, such as the [Contoso Pizza demo](https://microsoftedge.github.io/webmcp-labs/pizza-order/).
2. Click **WebMCP Agent** in the browser's Extensions menu or toolbar.
3. Check **Tools** to see what the page exposes.
4. In **Chat**, try:

   > Show me the menu. Don't create an order.

| View | Purpose |
|------|---------|
| **Chat** | Send tasks, inspect tool calls and results, answer questions, or stop a response. Enter sends; Shift+Enter adds a newline. **+** starts a new chat. |
| **Tools** | Inspect tool descriptions, origins and schemas. **Run manually** executes directly on the page and can change page state immediately. |
| **History** | Reopen SDK-owned chats. The overflow menu provides **Copy chat ID** and **Delete**. |
| **Settings** (gear) | Choose a model, show reasoning, include debugging tools, adjust result limits, inspect host logs, reconnect, or clear all chats. |

Switching tabs during a run pauses new tool calls. **Continue there** uses the
original tab; **Stop** cancels the run without deleting the chat. Available tools
refresh as the page navigates or changes its registrations.

The host starts when the panel connects and exits after five minutes with no
open panels or active runs. Reopening resumes the saved SDK chat.

## Troubleshooting

Run `npm run doctor` from `webmcp-agent` first.

| Symptom | Action |
|---------|--------|
| Host not installed or signed out | Rerun `npm run setup` or `npm run login`, then reconnect in Settings. |
| Native messaging blocked | Check `edge://policy` or `chrome://policy`. Ask your device administrator if policy blocks user-level hosts. |
| No tools on a page | Check the testing flag, reload the site, and confirm the page registers WebMCP tools. |
| Extension was rebuilt or reloaded | Reload it on the extensions page, then close and reopen the side panel. |

To uninstall host registration, run `npm run unregister`, then remove the
extension in the browser. Unregistering preserves chats, settings and sign-in
data. See [Contributing](CONTRIBUTING.md#data-and-native-host-registration) for
data locations and registration details.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow, tests and SDK
integration notes. Contributions follow the repository's
[contribution guidelines](../CONTRIBUTING.md) and [Code of Conduct](../CODE_OF_CONDUCT.md).

## Security and support

Follow the repository's [security policy](../SECURITY.md) to report vulnerabilities.
Do not report them in public GitHub issues. For bugs, feature requests and
questions, see [SUPPORT.md](../SUPPORT.md).

## Disclaimer

WebMCP Agent is an experimental developer tool, not a production browsing agent.
Page context, tool descriptions and results can be sent to Copilot. Saved chats
are stored locally by the SDK; verbose host logs can include page arguments and
results. Review logs before sharing them and delete sensitive chats when finished.

Use it only on sites you own, control or otherwise trust. Pages can mislabel
tools or inject instructions into results. Consequential hints guide the model,
not a deterministic approval gate. See the WebMCP community's
[Security and Privacy Considerations](https://github.com/webmachinelearning/webmcp#security-and-privacy-considerations).

## License

[MIT](../LICENSE.txt)
