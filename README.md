# BurnSight

BurnSight is a VS Code extension for realtime observability of GitHub Copilot Chat runtime behavior.

It is a telemetry-driven analytics layer that reads observable Copilot runtime logs, reconstructs request lifecycle events, and computes estimated economics for the current live session.

BurnSight does not use official Copilot billing APIs and does not claim billing-accurate token or cost parity.

## What BurnSight Is Today

BurnSight currently is:

- A realtime AI observability extension for GitHub Copilot Chat in VS Code
- A telemetry-driven runtime analytics system
- An estimated AI economics monitor for the active session

BurnSight currently works by reconstructing activity from observable VS Code/Copilot telemetry logs, not by querying provider-native usage APIs.

## Core Capabilities (Current Implementation)

BurnSight currently implements:

- Live Copilot telemetry discovery and ingestion from VS Code log roots
- Realtime request lifecycle tracking from canonical `ccreq:...` events
- Model attribution detection (including routed model chain extraction)
- Workflow/feature classification from runtime telemetry markers
- Retry detection (`retry` marker and retry count extraction)
- Escalation detection from model chain hops (for example `modelA -> modelB`)
- Estimated token accounting based on deterministic heuristics
- Estimated economics calculation using pricing registry lookup
- Session-scoped aggregation (request counts, latency, model/workflow distributions)
- Live dashboard updates in a VS Code webview overlay
- Runtime observability output in `BurnSight Telemetry` output channel

BurnSight does not currently provide:

- Official Copilot billing totals
- Exact provider token counts
- Provider-native API usage reconciliation

## How It Works

High-level runtime path:

`GitHub Copilot Runtime -> VS Code telemetry logs -> BurnSight discovery engine -> live log tailing -> parser normalization -> telemetry aggregation -> economics estimation -> reactive dashboard UI`

Concrete runtime architecture:

- Discovery: recursively scans VS Code logs on macOS, validates Copilot sources by path/signature tokens, and attaches file watchers
- Ingestion: tails append-only file deltas using byte offsets and EOF attach semantics
- Parsing: extracts canonical request records, model, status, latency, workflow tag, provider markers
- Deduping: suppresses duplicate lines/events by fingerprint and request/source offsets
- Enrichment: computes estimated tokens and estimated cost per request
- Aggregation: updates session metrics, timeline, model/workflow rollups, and burn-rate estimate
- UI sync: debounced view model publication to webview and incremental DOM patching

Detailed technical documentation is in [docs/architecture.md](docs/architecture.md).

## Telemetry Strategy

BurnSight classifies metrics by confidence level:

- `REAL`: direct log-observed fields (request IDs, model strings, latency markers, statuses, workflow tags)
- `ESTIMATED`: deterministic calculations derived from real telemetry (token/cost/burn-rate estimates)
- `HEURISTIC`: inference where direct observability is impossible (for example some runtime edit signals)

All accounting is session-local and event-driven. Metrics are updated only when validated telemetry events are ingested.

## Important Limitations

The following constraints are fundamental to current behavior:

- VS Code exposes no official Copilot token or billing API to this extension
- Economics in BurnSight are estimates, not invoice truth
- Token counts are heuristic/estimated from observable runtime signals
- Billing parity is not achievable through currently available public APIs
- Model/provider attribution depends on telemetry markers present in runtime logs
- Telemetry schemas may change with VS Code/Copilot releases

## Current Status

- Status: Alpha / experimental
- Platform support: macOS (current discovery root implementation)
- Primary target: GitHub Copilot Chat runtime in VS Code
- Architecture maturity: stable event-driven runtime pipeline, evolving estimation and analytics depth

## Screenshots

Screenshots are not yet committed in this repository. Placeholders:

- `[Dashboard screenshot placeholder](docs/assets/dashboard-placeholder.png)`
- `[Telemetry log screenshot placeholder](docs/assets/telemetry-placeholder.png)`
- `[Live economics example placeholder](docs/assets/economics-placeholder.png)`

## Development

Requirements:

- Node.js and pnpm
- VS Code (extension development host)
- macOS for current runtime log discovery path

Common commands:

```bash
pnpm install
pnpm run check-types
pnpm run lint
pnpm run compile
```

Watch mode:

```bash
pnpm run watch
```

Run tests:

```bash
pnpm test
```

## Roadmap (Realistic Near-Term)

- Windows and Linux discovery/tailing support
- Historical session analytics beyond current live-session focus
- Richer economics modeling and calibration controls
- Additional provider adapters and attribution normalization
- Trend charts and time-series views in overlay UI
- Deeper AI workflow analytics (routing patterns, retry heatmaps)

## Contributing

Contributions are welcome. BurnSight is built as an architecture-first observability system.

When contributing:

- Prefer observability-driven development with explicit confidence labels
- Preserve event-driven pipeline boundaries (discovery -> parse -> enrich -> aggregate -> present)
- Keep telemetry assumptions auditable and documented
- Avoid introducing claims of billing truth without direct official API evidence

## License

See repository license information when published.
