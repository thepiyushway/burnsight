import { renderDebugSection } from './sections/debugSection.js';
import { renderListCard } from './sections/listSection.js';
import { renderSessionCard } from './sections/sessionSection.js';
import { renderTableCard } from './sections/tableSection.js';

const vscode = acquireVsCodeApi();

const cardsRoot = document.getElementById('cards');
const debugShell = document.getElementById('debug-shell');
const titleEl = document.getElementById('title');
const versionEl = document.getElementById('version');
const runtimeLabelEl = document.getElementById('runtime-label');

function safeText(value) {
  return value === undefined || value === null ? '' : String(value);
}

function renderCard(card) {
  if (card.kind === 'session') {
    return renderSessionCard(card);
  }

  if (card.kind === 'table') {
    return renderTableCard(card);
  }

  return renderListCard(card);
}

function applyRuntimeState(snapshot) {
  const runtimeState = String(snapshot.runtimeState || 'IDLE').toLowerCase();
  document.body.setAttribute('data-runtime-state', runtimeState);
  runtimeLabelEl.textContent = safeText(snapshot.runtimeLabel || snapshot.runtimeState || 'IDLE');
  document.body.setAttribute('data-debug', snapshot.debug?.enabled ? 'true' : 'false');
}

function applyAnimatedValues(snapshot) {
  const nextSession = (snapshot.cards || []).find(
    (card) => card.kind === 'session' && card.id === 'session'
  );

  if (!nextSession) {
    return;
  }

  const burnEl = cardsRoot.querySelector('[data-animate="session-burn"]');
  const ctxEl = cardsRoot.querySelector('[data-animate="context-remaining"]');

  if (burnEl) {
    burnEl.textContent = safeText(nextSession.mainValue);
  }

  if (ctxEl) {
    ctxEl.textContent = safeText(nextSession.progressValue);
  }
}

function renderSnapshot(snapshot) {
  if (!snapshot) {
    return;
  }

  titleEl.textContent = safeText(snapshot.title);
  versionEl.textContent = safeText(snapshot.version);

  applyRuntimeState(snapshot);

  patchCards(snapshot.cards || []);
  debugShell.innerHTML = renderDebugSection(snapshot.debug);

  applyAnimatedValues(snapshot);

}

function patchCards(cards) {
  const nextIds = new Set(cards.map((card) => safeText(card.id)));
  const existingSections = cardsRoot.querySelectorAll('[data-card-id]');

  existingSections.forEach((section) => {
    const id = safeText(section.getAttribute('data-card-id'));
    if (!nextIds.has(id)) {
      section.remove();
    }
  });

  cards.forEach((card, index) => {
    const cardId = safeText(card.id);
    const newMarkup = renderCard(card);
    const existing = cardsRoot.querySelector('[data-card-id="' + cardId + '"]');

    if (!existing) {
      const wrapper = document.createElement('div');
      wrapper.innerHTML = newMarkup;
      const created = wrapper.firstElementChild;
      if (!created) {
        return;
      }
      const nextSibling = cardsRoot.children[index] || null;
      cardsRoot.insertBefore(created, nextSibling);
      return;
    }

    if (existing.outerHTML !== newMarkup) {
      const wrapper = document.createElement('div');
      wrapper.innerHTML = newMarkup;
      const replacement = wrapper.firstElementChild;
      if (replacement) {
        existing.replaceWith(replacement);
      }
    }
  });
}

window.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || message.type !== 'overlay:update') {
    return;
  }

  renderSnapshot(message.payload);
});

vscode.postMessage({ type: 'overlay:ready' });
