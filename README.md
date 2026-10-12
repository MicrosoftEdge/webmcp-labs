# WebMCP Labs

The WebMCP Labs repo contains experimental projects and samples for [WebMCP](https://github.com/webmachinelearning/webmcp), a specification developed by the [Web Machine Learning Community Group](https://www.w3.org/community/webmachinelearning/).

WebMCP is a browser web API which lets you expose your web app's functionality as tools which can be run by an AI browsing agent.

In WebMCP, tools are registered either via JavaScript functions or HTML `<form>` elements. Tools are described by using natural language and structured schemas, designed for AI agent ingestion.

## Experimental projects

| Project | Description |
|---------|-------------|
| [WebMCP Explorer](webmcp-explorer/) | WebMCP Explorer is a browser extension that lets you interact with web pages through WebMCP, with an autonomous agent loop and multi-provider LLM support. |

## Samples

| Live demo | Description |
|------|-------------|
| [Event Search](https://microsoftedge.github.io/webmcp-labs/event-search/) | Interactive playground showing declarative WebMCP HTML attributes on a `<form>`. |
| [Idea Board](https://microsoftedge.github.io/webmcp-labs/idea-board/) | Sticky board playground showing WebMCP tool registration using the JavaScript WebMCP API, with tools that dynamically appear and disappear based on the state of the board. |
| [Contoso Pizza](https://microsoftedge.github.io/webmcp-labs/pizza-order/) | Pizza-ordering site with WebMCP tools that let an agent browse the menu, create and update an order, and check out. |

## Test WebMCP in Edge

To test WebMCP, use an up to date version of Microsoft Edge Canary or Dev. See [Become a Microsoft Edge Insider](https://explore.microsoft.com/edge/download/insider).

To enable WebMCP in Edge:

1. Open a new window or tab.
1. Go to `about://flags/#enable-webmcp-testing`.
1. In the **WebMCP for testing** section, select **Enabled**.
1. Restart the browser.

Then, see [WebMCP Explorer](webmcp-explorer/) to test any of our samples or your own WebMCP-enabled site.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for CLA and general guidelines. Each project has its own setup instructions in its README.

## License

[MIT](LICENSE.txt)
