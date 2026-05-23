import { AIRequestEvent } from '../types/aiTelemetry';

interface DedupeEntry {
  key: string;
  timestamp: number;
}

/**
 * Rolling in-memory LRU-ish dedupe cache.
 * Prevents replay inflation for watcher re-reads and repeated append callbacks.
 */
export class EventDeduper {
  private readonly seenKeys = new Map<string, number>();
  private readonly queue: DedupeEntry[] = [];

  constructor(
    private readonly maxEntries = 5000,
    private readonly ttlMs = 60 * 60 * 1000
  ) {}

  public shouldProcess(event: AIRequestEvent): boolean {
    const key = this.buildKey(event);
    const now = Date.now();

    this.evictExpired(now);

    if (this.seenKeys.has(key)) {
      return false;
    }

    this.seenKeys.set(key, now);
    this.queue.push({ key, timestamp: now });

    if (this.queue.length > this.maxEntries) {
      const oldest = this.queue.shift();
      if (oldest) {
        this.seenKeys.delete(oldest.key);
      }
    }

    return true;
  }

  private buildKey(event: AIRequestEvent): string {
    return `${event.requestId}|${event.sourceFile}|${event.fileOffset}`;
  }

  private evictExpired(now: number): void {
    while (this.queue.length > 0) {
      const first = this.queue[0];
      if (!first || now - first.timestamp <= this.ttlMs) {
        break;
      }
      this.queue.shift();
      this.seenKeys.delete(first.key);
    }
  }
}
