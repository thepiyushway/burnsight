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

let previousSnapshot = undefined;

function safeText(value) {
  return value === undefined || value === null ? '' : String(value);
}

function parseCurrency(value) {
  return Number(String(value || '').replace(/[^0-9.-]/g, '')) || 0;
}

function animateValue(element, from, to, formatter, durationMs) {
  if (!element || Number.isNaN(from) || Number.isNaN(to)) {
    return;
  }

  const start = performance.now();

  const tick = (now) => {
    const elapsed = now - start;
    const progress = Math.min(1, elapsed / durationMs);
    const eased = 1 - Math.pow(1 - progress, 3);
    const value = from + (to - from) * eased;
    element.textContent = formatter(value);

    if (progress < 1) {
      requestAnimationFrame(tick);
    }
  };

  requestAnimationFrame(tick);
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
  const prevCards = previousSnapshot ? previousSnapshot.cards || [] : [];
  const prevSession = prevCards.find((card) => card.kind === 'session' && card.id === 'session');
  const nextSession = (snapshot.cards || []).find(
    (card) => card.kind === 'session' && card.id === 'session'
  );

  if (!nextSession) {
    return;
  }

  const burnEl = cardsRoot.querySelector('[data-animate="session-burn"]');
  const ctxEl = cardsRoot.querySelector('[data-animate="context-remaining"]');

  if (burnEl) {
    const fromBurn = prevSession ? parseCurrency(prevSession.mainValue) : parseCurrency(nextSession.mainValue);
    const toBurn = parseCurrency(nextSession.mainValue);

    animateValue(
      burnEl,
      fromBurn,
      toBurn,
      (value) => '$' + value.toFixed(2),
      snapshot.runtimeState === 'BURST' ? 180 : 320
    );
  }

  if (ctxEl) {
    const fromCtx = prevSession ? Number(prevSession.progressPct || 0) : Number(nextSession.progressPct || 0);
    const toCtx = Number(nextSession.progressPct || 0);

    animateValue(
      ctxEl,
      fromCtx,
      toCtx,
      (value) => Math.round(value) + '%',
      300
    );
  }
}

function renderSnapshot(snapshot) {
  if (!snapshot) {
    return;
  }

  titleEl.textContent = safeText(snapshot.title);
  versionEl.textContent = safeText(snapshot.version);

  applyRuntimeState(snapshot);

  const html = (snapshot.cards || []).map((card) => renderCard(card)).join('');
  cardsRoot.innerHTML = html;
  debugShell.innerHTML = renderDebugSection(snapshot.debug);

  applyAnimatedValues(snapshot);

  previousSnapshot = snapshot;
}

window.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || message.type !== 'overlay:update') {
    return;
  }

  renderSnapshot(message.payload);
});

vscode.postMessage({ type: 'overlay:ready' });
