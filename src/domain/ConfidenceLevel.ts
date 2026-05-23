/**
 * Confidence classification carried by every derived metric.
 *
 * REAL      – directly observed from a VS Code / provider API with no
 *             interpretation or approximation.
 * OBSERVED  – captured from runtime signals (logs, IPC) without provable
 *             completeness; some data may be absent.
 * ESTIMATED – calculated from REAL/OBSERVED observations using a published
 *             or well-known formula (e.g. tokens ≈ chars / 4).
 * INFERRED  – deduced from indirect evidence (e.g. latency → throughput).
 * HEURISTIC – approximated when direct observation is impossible; derived
 *             from model profiles and workflow weights.
 *
 * Dashboard labels must always surface the confidence tier to the user.
 * Never present ESTIMATED or HEURISTIC values as exact billing truth.
 */
export enum ConfidenceLevel {
  REAL = 'REAL',
  OBSERVED = 'OBSERVED',
  ESTIMATED = 'ESTIMATED',
  INFERRED = 'INFERRED',
  HEURISTIC = 'HEURISTIC',
}
