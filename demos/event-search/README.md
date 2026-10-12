# Event Search: declarative WebMCP playground

[Open the playground](https://microsoftedge.github.io/webmcp-labs/event-search/) | [Imperative playground guide](../idea-board/README.md)

Learn by asking an agent to fill the same form in three modes: manual review,
automatic submission, and a custom tool response. This Markdown guide describes
the lessons without requiring the visual page. The demo simulates a search; it
does not retrieve real events, reserve tickets, or make payments.

## Setup

1. Use an up-to-date Microsoft Edge Canary or Dev. Enable
   `about://flags/#enable-webmcp-testing`, then restart the browser.
   See [browser setup](https://github.com/MicrosoftEdge/webmcp-labs#test-webmcp-in-edge).
2. Load [WebMCP Explorer](https://github.com/MicrosoftEdge/webmcp-labs/tree/main/webmcp-explorer#load-the-webmcp-explorer-extension)
   and configure a tool-calling model, or use another agent with WebMCP access.
3. Open the playground and the agent on that page. Select a lesson before
   sending its prompt.

The demo comes first. Below it, expand **Code examples and API explanations**
as needed. The API reference and Markdown link are below the demo.

Check the agent's tool list to confirm that the browser exposes the selected
form. Code and this guide remain readable when the API is unavailable.

## Tool inputs

All three form tools have the same required fields:

| Field | Form control | Expected value |
|-------|--------------|----------------|
| `date` | Date input | Date in `YYYY-MM-DD` format |
| `category` | Select | `concert`, `sports`, `theater`, or `comedy` |
| `artist` | Text input | Artist, team, or venue name |
| `location` | Text input | City or region |

The browser derives the input schema from the HTML form controls. The page does
not register a JavaScript `inputSchema` for these tools.

## Lesson 1: manual review

Select **Manual Review**. The active form tool is `search-events-manual`.

Suggested prompt:

> Use search-events-manual to find concert tickets for an artist named Example Band in Seattle on 2030-06-15. Fill the form and wait for me to review and submit.

Expected sequence:

1. The agent fills the required fields.
2. The invocation waits for the user to review and click **Search**.
3. The page shows a confirmation.

`toolname` names the tool; `tooldescription` tells the agent what it does.
Without `toolautosubmit`, submitting is the user's responsibility. A user click
during an active tool invocation still has `event.agentInvoked === true`.
An ordinary submission outside an invocation has `false`.

## Lesson 2: auto-submit

Select **Auto Submit**. The active form tool is `search-events-auto`.

Suggested prompt:

> Use search-events-auto to find concert tickets for an artist named Example Band in Seattle on 2030-06-15.

Expected sequence: the agent fills the form and submits without requiring a
manual click. Adding `toolautosubmit` is the change that enables this behavior.
A person can still fill and submit the same form.

The demo prevents navigation and shows a confirmation. It does not supply a
custom result through `respondWith()` in this mode.

## Lesson 3: custom response

Select **Custom Response**. The active form tool is `search-events-custom`.

Suggested prompt:

> Use search-events-custom to find concert tickets for an artist named Example Band in Seattle on 2030-06-15. Tell me the tool's returned result.

The agent fills and submits automatically. The page supplies this simulated
result to the browser through `event.respondWith()`:

```text
Found 3 events for "Example Band" on 2030-06-15 in Seattle.
```

Compare that result in the agent with the confirmation on the page.
An ordinary user submission does not call `respondWith()`.

## Code equivalent

This standalone example demonstrates the custom-response lesson. To compare the
other modes, remove the custom submit handler; remove `toolautosubmit` as well
for manual review. The playground's manual and auto handlers prevent navigation
and show simulated confirmations rather than contacting a backend.

```html
<form id="event-search"
      toolname="search-events-custom"
      tooldescription="Search for event tickets (custom agent response)"
      toolautosubmit>
  <label for="date">Date</label>
  <input id="date" name="date" type="date" required
         toolparamdescription="Event date in YYYY-MM-DD format">
  <label for="category">Category</label>
  <select id="category" name="category" required
          toolparamdescription="Type of event: Concert, Sports, Theater, or Comedy">
    <option value="concert">Concert</option>
    <option value="sports">Sports</option>
    <option value="theater">Theater</option>
    <option value="comedy">Comedy</option>
  </select>
  <label for="artist">Artist / Venue</label>
  <input id="artist" name="artist" required
         toolparamdescription="Name of the artist, team, or venue">
  <label for="location">Location</label>
  <input id="location" name="location" required
         toolparamdescription="City or region to search in">
  <button type="submit">Search</button>
</form>
<script>
  const form = document.getElementById('event-search');
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!event.agentInvoked) return;
    const data = new FormData(form);
    event.respondWith(Promise.resolve(
      `Found 3 events for "${data.get("artist")}" ` +
      `on ${data.get("date")} in ${data.get("location")}.`
    ));
  });
</script>
```

## Observe and troubleshoot

- Only the selected lesson's form is in the document. Selecting another lesson
  removes the old form and inserts the selected form. Finish an invocation
  before switching lessons.
- Use the code examples to connect each control's name, required state, and
  `toolparamdescription` to the agent's inputs. Use the agent's own trace to
  inspect fills and pending invocations.
- If manual review appears stalled after the fields are filled, click
  **Search**. If submission is blocked, check all required fields.
- If no tool appears, check browser setup, reload, and refresh your agent's
  tool list.

## Attribute and event reference

| Surface | Purpose |
|---------|---------|
| `toolname` | Unique form tool name |
| `tooldescription` | Natural-language tool description |
| `tooltitle` | Optional display title; invocation uses `toolname` |
| `toolautosubmit` | Allow agent submission without a manual click |
| `toolparamdescription` | Explain an input, select, or textarea parameter |
| `event.agentInvoked` | Identify a submission during an active tool invocation |
| `event.respondWith(promise)` | Supply a custom tool result after `preventDefault()`, when `agentInvoked` is true |

For the executable demo and highlighted examples, see [index.html](index.html).
