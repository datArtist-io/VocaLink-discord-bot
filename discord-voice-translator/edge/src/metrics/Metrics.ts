/** Edge metrics: per-stage latency windows + counters, Prometheus text output. */

export class Metrics {
  private windows = new Map<string, number[]>();
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();
  constructor(private readonly size = 2000) {}

  observe(name: string, ms: number): void {
    if (!Number.isFinite(ms)) return;
    let w = this.windows.get(name);
    if (!w) this.windows.set(name, (w = []));
    w.push(ms);
    if (w.length > this.size) w.splice(0, w.length - this.size);
  }

  inc(name: string, n = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + n);
  }

  gauge(name: string, v: number): void {
    this.gauges.set(name, v);
  }

  pct(name: string, p: number): number | null {
    const w = this.windows.get(name);
    if (!w?.length) return null;
    const s = [...w].sort((a, b) => a - b);
    const k = (s.length - 1) * p;
    const f = Math.floor(k);
    const c = Math.min(f + 1, s.length - 1);
    return s[f]! + (s[c]! - s[f]!) * (k - f);
  }

  snapshot(): Record<string, unknown> {
    const lat: Record<string, unknown> = {};
    for (const k of this.windows.keys()) {
      lat[k] = { n: this.windows.get(k)!.length, p50: round(this.pct(k, 0.5)), p90: round(this.pct(k, 0.9)), p99: round(this.pct(k, 0.99)) };
    }
    return { latency_ms: lat, counters: Object.fromEntries(this.counters), gauges: Object.fromEntries(this.gauges) };
  }

  prometheus(prefix = 'dvt_edge'): string {
    const out: string[] = [];
    const clean = (s: string) => s.replace(/[^a-zA-Z0-9_]/g, '_');
    for (const [k, v] of this.counters) out.push(`${prefix}_${clean(k)}_total ${v}`);
    for (const [k, v] of this.gauges) out.push(`${prefix}_${clean(k)} ${v}`);
    for (const k of this.windows.keys()) {
      for (const q of [0.5, 0.9, 0.99]) out.push(`${prefix}_latency_ms{stage="${clean(k)}",quantile="${q}"} ${round(this.pct(k, q)) ?? 0}`);
    }
    return out.join('\n') + '\n';
  }
}

function round(x: number | null): number | null {
  return x === null ? null : Math.round(x * 10) / 10;
}
