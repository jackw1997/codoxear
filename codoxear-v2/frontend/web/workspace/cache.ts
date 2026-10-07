// Serialized payload bounds, not a promise about total browser heap usage.
export class ConversationCache extends Map<string, any> {
  readonly maxAgents = 3;
  readonly maxEvents = 200;
  readonly maxBytes = 5 * 1024 * 1024;
  private directoryBytes = 0;
  private encoder = new TextEncoder();
  private allowed: Set<string> | null = null;
  setDirectory(agents: Array<{ id: string; access?: string }>) {
    const bytes = this.encoder.encode(JSON.stringify(agents)).length;
    if (bytes > this.maxBytes) {
      this.clear();
      throw new Error("Agent directory exceeds the browser cache limit.");
    }
    this.directoryBytes = bytes;
    this.allowed = new Set(agents.map((a) => a.id));
    for (const id of this.keys()) if (!this.allowed.has(id)) this.delete(id);
    this.trim();
  }
  get bytes() {
    return [...this].reduce(
      (n, [id, v]) => n + this.encoder.encode(id + JSON.stringify(v)).length,
      this.directoryBytes,
    );
  }
  override get(id: string) {
    const value = super.get(id);
    if (value) {
      super.delete(id);
      super.set(id, value);
    }
    return value;
  }
  override set(id: string, value: any) {
    if (this.allowed && !this.allowed.has(id)) return this;
    const events = (value.events ?? []).slice(-this.maxEvents);
    const cut = events.length < (value.events ?? []).length;
    // Never keep an older-history cursor that would skip truncated messages.
    const limited = {
      ...value,
      events,
      ...(cut
        ? {
            historyCursor: events[0]?.history_cursor ?? null,
            hasOlder: !!events[0]?.history_cursor,
          }
        : {}),
    };
    super.delete(id);
    if (
      this.encoder.encode(id + JSON.stringify(limited)).length +
        this.directoryBytes >
      this.maxBytes
    )
      return this;
    super.set(id, limited);
    this.trim();
    return this;
  }
  private trim() {
    while (
      this.size &&
      (this.size > this.maxAgents || this.bytes > this.maxBytes)
    )
      super.delete(this.keys().next().value!);
  }
}
export const conversationCache = new ConversationCache();
