export const SENTINEL = '__WISPY_EOF__';

export interface FeedResult {
  paths: string[];
  sentinelSeen: boolean;
}

export class QueueParser {
  private buffer = '';
  private seen = new Set<string>();

  feed(chunk: string): FeedResult {
    this.buffer += chunk;
    const newlineIdx = this.buffer.lastIndexOf('\n');
    if (newlineIdx === -1) {
      return { paths: [], sentinelSeen: false };
    }
    const complete = this.buffer.slice(0, newlineIdx);
    this.buffer = this.buffer.slice(newlineIdx + 1);

    const paths: string[] = [];
    let sentinelSeen = false;

    for (const line of complete.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed === SENTINEL) {
        sentinelSeen = true;
        break;
      }
      for (const path of trimmed.split(/\s+/)) {
        if (!path || this.seen.has(path)) continue;
        this.seen.add(path);
        paths.push(path);
      }
    }

    return { paths, sentinelSeen };
  }
}
