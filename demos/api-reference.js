/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */

document.querySelectorAll('.api-reference .api-table').forEach(table => {
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
