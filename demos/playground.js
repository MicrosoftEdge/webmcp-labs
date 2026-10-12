/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */

const playgroundDocumentation = (() => {
  let previousToolNames = null;

  function recordActivity(title, detail, apiExplanation = '') {
    const list = document.getElementById('playground-activity');
    const entry = document.createElement('li');
    const heading = document.createElement('strong');
    heading.textContent = title;
    const text = document.createElement('p');
    text.textContent = detail;
    entry.append(heading, text);
    if (apiExplanation) {
      const explanation = document.createElement('p');
      explanation.className = 'activity-concept';
      explanation.textContent = apiExplanation;
      entry.append(explanation);
    }
    list.prepend(entry);
    while (list.children.length > 10) list.lastElementChild.remove();
    document.getElementById('activity-empty').hidden = true;
    document.getElementById('activity-status').textContent = title;
  }

  function recordResult(toolName, inputs, result) {
    recordActivity(toolName, `Inputs: ${JSON.stringify(inputs, null, 2)}\nResult: ${result}`,
      'API: inputSchema describes these inputs; execute receives them and returns this value to the browser for the agent.');
    return result;
  }

  function showTools(tools, changeTitle = 'Tool availability changed') {
    const list = document.getElementById('playground-tools');
    list.replaceChildren();
    for (const tool of tools) {
      const item = document.createElement('li');
      const name = document.createElement('code');
      name.textContent = tool.name;
      const reason = document.createElement('span');
      reason.textContent = tool.reason;
      item.append(name, reason);
      if (tool.concept) {
        const concept = document.createElement('p');
        concept.textContent = tool.concept;
        item.append(concept);
      }
      if (tool.inputSchema || tool.parameters) {
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = tool.inputSchema ? 'Inspect inputSchema' : 'Inspect form parameters';
        details.append(summary);
        if (tool.inputSchema) {
          const schema = document.createElement('pre');
          schema.tabIndex = 0;
          schema.setAttribute('aria-label', `${tool.name} input schema`);
          schema.textContent = JSON.stringify(tool.inputSchema, null, 2);
          details.append(schema);
        } else {
          const parameters = document.createElement('ul');
          for (const parameter of tool.parameters) {
            const field = document.createElement('li');
            field.textContent = `${parameter.name} (${parameter.type}${parameter.required ? ', required' : ''}): ${parameter.description}`;
            parameters.append(field);
          }
          details.append(parameters);
        }
        item.append(details);
      }
      list.append(item);
    }
    const names = tools.map(tool => tool.name);
    if (previousToolNames !== null && names.join(',') !== previousToolNames.join(',')) {
      const added = names.filter(name => !previousToolNames.includes(name));
      const removed = previousToolNames.filter(name => !names.includes(name));
      const changes = [];
      if (added.length) changes.push(`Added: ${added.join(', ')}.`);
      if (removed.length) changes.push(`Removed: ${removed.join(', ')}.`);
      recordActivity(changeTitle, changes.join(' '),
        changeTitle === 'Form configuration changed'
          ? 'API: the selected form supplies toolname, tooldescription, and parameters. The previous form was removed from the document.'
          : 'API: registerTool adds actions that apply to the current state; aborting a registration options.signal removes actions that no longer apply.');
    }
    previousToolNames = names;
  }

  const supportStatus = document.getElementById('webmcp-status');
  const supported = supportStatus.dataset.api === 'imperative'
    ? typeof document.modelContext?.registerTool === 'function'
    : Boolean(document.modelContext);
  supportStatus.textContent = supported
    ? 'WebMCP API detected. Open your agent on this page to try a prompt. This does not indicate an agent connection.'
    : 'WebMCP API not detected. Follow the browser setup below and reload. You can still read the examples and Markdown guide.';
  supportStatus.classList.toggle('unsupported', !supported);

  document.querySelectorAll('.api-table').forEach(table => {
    table.setAttribute('role', 'table');
    const labels = [...table.querySelectorAll('thead th')].map(header => header.textContent);
    table.querySelectorAll('thead, tbody').forEach(group => group.setAttribute('role', 'rowgroup'));
    table.querySelectorAll('tr').forEach(row => row.setAttribute('role', 'row'));
    table.querySelectorAll('th').forEach(header => header.setAttribute('role', 'columnheader'));
    table.querySelectorAll('tbody tr').forEach(row => {
      [...row.cells].forEach((cell, index) => {
        cell.setAttribute('role', 'cell');
        if (cell.colSpan > 1) return;
        const label = document.createElement('span');
        label.className = 'api-cell-label';
        label.setAttribute('aria-hidden', 'true');
        label.textContent = labels[index];
        cell.prepend(label);
      });
    });
  });

  document.querySelectorAll('[data-copy-prompt]').forEach(button => {
    button.addEventListener('click', async () => {
      const prompt = document.getElementById(button.dataset.copyPrompt).textContent;
      const status = document.getElementById('prompt-status');
      try {
        await navigator.clipboard.writeText(prompt);
        status.textContent = 'Prompt copied. Paste it into your agent; copying does not run a tool.';
      } catch (error) {
        console.error('Could not copy playground prompt:', error);
        status.textContent = 'Could not copy the prompt. Select the prompt text and copy it manually.';
      }
    });
  });

  return { supported, recordActivity, recordResult, showTools };
})();
