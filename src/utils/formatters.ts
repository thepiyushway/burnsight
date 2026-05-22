function toFixedTrimmed(value: number, precision: number): string {
  return Number(value.toFixed(precision)).toString();
}

export function formatCurrency(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

export function formatRate(value: number): string {
  return `${formatCurrency(value)}/hr`;
}

export function formatInteger(value: number): string {
  return new Intl.NumberFormat('en-US').format(Math.round(value));
}

export function formatCompact(value: number): string {
  if (value >= 1000) {
    return `${toFixedTrimmed(value / 1000, 1)}k`;
  }

  return toFixedTrimmed(value, 0);
}
