// Tab routing
const tabs = document.querySelectorAll<HTMLButtonElement>('.tab');
const panes = document.querySelectorAll<HTMLElement>('.pane');

function switchTab(paneId: string) {
  tabs.forEach((t) => {
    const isActive = t.dataset.pane === paneId;
    t.classList.toggle('active', isActive);
    t.setAttribute('aria-selected', String(isActive));
  });
  panes.forEach((p) => {
    p.classList.toggle('active', p.id === `pane-${paneId}`);
  });
}

tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    const paneId = tab.dataset.pane;
    if (paneId) switchTab(paneId);
  });
});

// Pane modules — each wires up listeners on the static HTML
import './tools-pane';
import './agent-pane';
import './config-pane';
