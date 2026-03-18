/**
 * Metrics — Simple counters and timers for NewClaw observability.
 *
 * Tracks: totalTokens, totalEvents, totalToolCalls, uptime.
 * Exposed via terminal /status command.
 */

export class Metrics {
  totalTokensIn = 0;
  totalTokensOut = 0;
  totalEvents = 0;
  totalToolCalls = 0;
  toolCallsByName = new Map<string, number>();
  private startTime = Date.now();

  get uptime(): number {
    return Date.now() - this.startTime;
  }

  get totalTokens(): number {
    return this.totalTokensIn + this.totalTokensOut;
  }

  recordTokens(input: number, output: number): void {
    this.totalTokensIn += input;
    this.totalTokensOut += output;
  }

  recordEvent(): void {
    this.totalEvents++;
  }

  recordToolCall(toolName: string): void {
    this.totalToolCalls++;
    this.toolCallsByName.set(toolName, (this.toolCallsByName.get(toolName) ?? 0) + 1);
  }

  /** Format uptime as human-readable string. */
  formatUptime(): string {
    const ms = this.uptime;
    const s = Math.floor(ms / 1000) % 60;
    const m = Math.floor(ms / 60000) % 60;
    const h = Math.floor(ms / 3600000);
    return h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  /** Get a formatted status string for display. */
  getStatusReport(): string {
    const topTools = [...this.toolCallsByName.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => `  ${name}: ${count}`)
      .join('\n');

    return [
      `Uptime: ${this.formatUptime()}`,
      `Events processed: ${this.totalEvents}`,
      `Total tokens: ${this.totalTokens} (in: ${this.totalTokensIn}, out: ${this.totalTokensOut})`,
      `Tool calls: ${this.totalToolCalls}`,
      topTools ? `Top tools:\n${topTools}` : '',
    ].filter(Boolean).join('\n');
  }
}

/** Global singleton metrics instance. */
export const metrics = new Metrics();
