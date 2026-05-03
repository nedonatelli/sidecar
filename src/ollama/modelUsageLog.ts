export interface ModelUsageEntry {
  model: string;
  role: 'chat' | 'complete';
  timestamp: Date;
}

export class ModelUsageLog {
  static readonly MAX_ENTRIES = 1000;

  private ring: Array<ModelUsageEntry | undefined>;
  private head = 0;
  private count = 0;

  constructor() {
    this.ring = new Array(ModelUsageLog.MAX_ENTRIES);
  }

  push(entry: ModelUsageEntry): void {
    const cap = ModelUsageLog.MAX_ENTRIES;
    this.ring[this.head] = entry;
    this.head = (this.head + 1) % cap;
    if (this.count < cap) this.count++;
  }

  getAll(): ModelUsageEntry[] {
    const cap = ModelUsageLog.MAX_ENTRIES;
    const result: ModelUsageEntry[] = new Array(this.count);
    const start = (this.head - this.count + cap) % cap;
    for (let i = 0; i < this.count; i++) {
      result[i] = this.ring[(start + i) % cap]!;
    }
    return result;
  }

  clear(): void {
    this.ring = new Array(ModelUsageLog.MAX_ENTRIES);
    this.head = 0;
    this.count = 0;
  }

  get size(): number {
    return this.count;
  }

  buildTrailers(fallbackModel: string): string {
    if (this.count === 0) {
      return `X-AI-Model: ${fallbackModel}`;
    }

    const agg = new Map<string, { roles: Set<string>; count: number }>();
    for (const entry of this.getAll()) {
      const existing = agg.get(entry.model);
      if (existing) {
        existing.roles.add(entry.role);
        existing.count++;
      } else {
        agg.set(entry.model, { roles: new Set([entry.role]), count: 1 });
      }
    }

    const lines: string[] = [];
    for (const [model, { roles, count }] of agg) {
      const roleStr = [...roles].join(', ');
      const callStr = count === 1 ? '1 call' : `${count} calls`;
      lines.push(`X-AI-Model: ${model} (${roleStr}, ${callStr})`);
    }
    if (agg.size > 1) {
      lines.push(`X-AI-Model-Count: ${agg.size}`);
    }
    return lines.join('\n');
  }
}
