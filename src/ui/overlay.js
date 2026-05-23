const vscode = acquireVsCodeApi();

const titleEl = document.getElementById('title');
const versionEl = document.getElementById('version');
const runtimeLabelEl = document.getElementById('runtime-label');
const modelSpendBody = document.getElementById('model-spend-body');
const workflowSpendBody = document.getElementById('workflow-spend-body');

let lastDashboardSignature = '';

function safeText(value) {
  return value === undefined || value === null ? '' : String(value);
}

function formatApproxCurrency(value) {
  return `~$${Number(value || 0).toFixed(2)}`;
}

function formatTokenCount(value) {
  const numeric = Math.max(0, Math.round(Number(value || 0)));
  if (numeric >= 1000000) {
    return `${(numeric / 1000000).toFixed(1)}m tokens`;
  }
  if (numeric >= 1000) {
    return `${(numeric / 1000).toFixed(1)}k tokens`;
  }
  return `${numeric} tokens`;
}

function formatDuration(ms) {
  const totalSeconds = Math.floor(Math.max(0, Number(ms || 0)) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) {
    element.textContent = safeText(value);
    console.log(`[DOM] patching ${id}`);
  } else {
    console.log(`[DOM] node missing: ${id}`);
  }
}

function setBodyState(viewModel) {
  const runtimeState = viewModel && viewModel.isLive ? 'active' : 'idle';
  document.body.setAttribute('data-runtime-state', runtimeState);
  document.body.setAttribute('data-debug', viewModel && viewModel.debugEnabled ? 'true' : 'false');
  if (runtimeLabelEl) {
    runtimeLabelEl.textContent = safeText(viewModel?.runtimeLabel || 'IDLE');
  }
}

function patchKeyValueRows(viewModel) {
  setText('total-requests', viewModel.totalRequests);
  setText('estimated-session-cost', formatApproxCurrency(viewModel.estimatedSessionCostUsd));
  setText('estimated-burn-rate', `${formatApproxCurrency(viewModel.estimatedBurnRateUsdPerHour)}/hr`);
  setText('estimated-input-tokens', formatTokenCount(viewModel.estimatedInputTokens));
  setText('estimated-output-tokens', formatTokenCount(viewModel.estimatedOutputTokens));
  setText('estimated-total-tokens', formatTokenCount(viewModel.estimatedTotalTokens));
  setText('average-latency-ms', viewModel.averageLatencyMs > 0 ? `${Math.round(viewModel.averageLatencyMs)}ms` : '0ms');
  setText('session-duration', formatDuration(viewModel.sessionDurationMs));
  setText('retry-count', viewModel.retries);
  setText('escalation-count', viewModel.escalations);
  setText('active-model', viewModel.activeModel || 'none');
  setText('active-models', viewModel.activeModels.length > 0 ? viewModel.activeModels.join(', ') : 'none');
  setText('most-used-model', viewModel.mostUsedModel || 'none');
  setText('most-expensive-model', viewModel.mostExpensiveModel || 'none');
  setText('top-workflow', viewModel.topWorkflow || 'none');
  setText('retry-cost-share', `${Math.round(viewModel.retryCostSharePct)}%`);
  setText('request-distribution', viewModel.requestDistribution || 'none');
  setText('session-artifacts', viewModel.sessionArtifacts);
  setText('average-request-cost', formatApproxCurrency(viewModel.averageRequestCostUsd));

  const progressFill = document.getElementById('session-progress-fill');
  if (progressFill) {
    progressFill.style.width = `${Math.min(100, Number(viewModel.totalRequests || 0))}%`;
    console.log('[DOM] patching session-progress-fill');
  } else {
    console.log('[DOM] node missing: session-progress-fill');
  }
}

function syncTableBody(body, rows, renderRow) {
  if (!body) {
    console.log('[DOM] node missing: table-body');
    return;
  }

  const nextKeys = new Set(rows.map((row) => renderRow.key(row)));

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const key = renderRow.key(row);
    let rowEl = Array.from(body.children).find((child) => child.dataset && child.dataset.key === key);

    if (!rowEl) {
      rowEl = renderRow.create(row);
      rowEl.dataset.key = key;
    }

    const nextSibling = body.children[index] || null;
    if (rowEl !== nextSibling) {
      body.insertBefore(rowEl, nextSibling);
    }

    renderRow.update(rowEl, row);
  }

  Array.from(body.children).forEach((child) => {
    if (!nextKeys.has(child.dataset.key)) {
      child.remove();
    }
  });
}

function patchModelSpendRows(viewModel) {
  syncTableBody(modelSpendBody, viewModel.modelSpendRows || [], {
    key: (row) => row.model,
    create: (row) => createModelRow(row),
    update: (rowEl, row) => updateModelRow(rowEl, row),
  });
}

function patchWorkflowSpendRows(viewModel) {
  syncTableBody(workflowSpendBody, viewModel.workflowSpendRows || [], {
    key: (row) => row.workflow,
    create: (row) => createWorkflowRow(row),
    update: (rowEl, row) => updateWorkflowRow(rowEl, row),
  });
}

function createModelRow(row) {
  const tr = document.createElement('tr');
  tr.appendChild(createCell(row.model));
  tr.appendChild(createCell(row.requests, true));
  tr.appendChild(createCell(formatApproxCurrency(row.spendUsd), true, 'accent-cyan'));
  return tr;
}

function updateModelRow(rowEl, row) {
  const cells = rowEl.querySelectorAll('td');
  if (cells[0]) {
    cells[0].textContent = safeText(row.model);
  }
  if (cells[1]) {
    cells[1].textContent = safeText(row.requests);
  }
  if (cells[2]) {
    cells[2].textContent = formatApproxCurrency(row.spendUsd);
  }
}

function createWorkflowRow(row) {
  const tr = document.createElement('tr');
  tr.appendChild(createCell(row.workflow));
  tr.appendChild(createCell(row.requests, true));
  tr.appendChild(createCell(formatApproxCurrency(row.spendUsd), true, 'accent-cyan'));
  return tr;
}

function updateWorkflowRow(rowEl, row) {
  const cells = rowEl.querySelectorAll('td');
  if (cells[0]) {
    cells[0].textContent = safeText(row.workflow);
  }
  if (cells[1]) {
    cells[1].textContent = safeText(row.requests);
  }
  if (cells[2]) {
    cells[2].textContent = formatApproxCurrency(row.spendUsd);
  }
}

function createCell(value, alignRight = false, className = '') {
  const cell = document.createElement('td');
  if (alignRight) {
    cell.style.textAlign = 'right';
  }
  if (className) {
    cell.className = className;
  }
  cell.textContent = safeText(value);
  return cell;
}

function patchDebug(viewModel) {
  setText('debug-active-model', viewModel.activeModel || 'none');
  setText('debug-request-count', viewModel.totalRequests);
  setText('debug-avg-latency', viewModel.averageLatencyMs > 0 ? `${Math.round(viewModel.averageLatencyMs)}ms` : '0ms');
  setText('debug-runtime-signal', viewModel.debug.lastRuntimeSignal || 'none');
  setText('debug-runtime-confidence', viewModel.debug.lastRuntimeSignalConfidence || '0%');
  setText('debug-last-command', viewModel.debug.lastCopilotCommand || 'none');
  setText('debug-last-event', viewModel.debug.lastEventRaw || 'none');

  const eventsRoot = document.getElementById('debug-events');
  if (!eventsRoot) {
    return;
  }

  const recentEvents = viewModel.debug.recentEvents || [];
  const existing = Array.from(eventsRoot.children);

  for (let index = 0; index < recentEvents.length; index += 1) {
    const line = recentEvents[index];
    let item = existing[index];
    if (!item) {
      item = document.createElement('div');
      item.className = 'debug-event';
      eventsRoot.appendChild(item);
    }
    item.textContent = line;
  }

  while (eventsRoot.children.length > recentEvents.length) {
    eventsRoot.removeChild(eventsRoot.lastElementChild);
  }
}

function updateDashboard(viewModel) {
  if (!viewModel) {
    return;
  }

  const signature = JSON.stringify({
    totalRequests: viewModel.totalRequests,
    estimatedSessionCostUsd: viewModel.estimatedSessionCostUsd,
    estimatedInputTokens: viewModel.estimatedInputTokens,
    estimatedOutputTokens: viewModel.estimatedOutputTokens,
    estimatedTotalTokens: viewModel.estimatedTotalTokens,
    averageLatencyMs: viewModel.averageLatencyMs,
    retries: viewModel.retries,
    escalations: viewModel.escalations,
    activeModel: viewModel.activeModel,
    updatedAt: viewModel.updatedAt,
    debug: viewModel.debug,
    modelSpendRows: viewModel.modelSpendRows,
    workflowSpendRows: viewModel.workflowSpendRows,
  });

  if (signature === lastDashboardSignature) {
    return;
  }

  console.log('[WEBVIEW] dashboard update received');
  setText('title', 'BURNSIGHT_RUNTIME_OBSERVABILITY');
  setText('version', viewModel.version);
  if (titleEl) {
    titleEl.textContent = 'BURNSIGHT_RUNTIME_OBSERVABILITY';
  }
  if (versionEl) {
    versionEl.textContent = safeText(viewModel.version);
  }

  setBodyState(viewModel);
  patchKeyValueRows(viewModel);
  patchModelSpendRows(viewModel);
  patchWorkflowSpendRows(viewModel);
  patchDebug(viewModel);

  lastDashboardSignature = signature;
  console.log('[WEBVIEW] metrics patched');
  console.log('[WEBVIEW] update applied');
}

console.log('[WEBVIEW] message listener registered');
window.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || message.type !== 'dashboard-update') {
    return;
  }

  console.log('[WEBVIEW] dashboard-update received');
  updateDashboard(message.payload);
});

vscode.postMessage({ type: 'dashboard:ready' });
