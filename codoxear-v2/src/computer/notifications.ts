import { SqliteDocument } from "../persistence/document.js";
import { Notification, NOTIFICATION_TTL } from "../protocol/notifications.js";
type State = {
  cursor: number;
  events: Array<Notification & { acked: boolean }>;
};
/** Only notification hints retry. This journal never contains executable commands. */
export class CompletionOutbox {
  private state: SqliteDocument<State>;
  constructor(
    path: string,
    scope: string,
    private now: () => number = Date.now,
  ) {
    this.state = new SqliteDocument(path, scope, () => ({
      cursor: now(),
      events: [],
    }));
  }
  cursor() {
    return this.state.read().cursor;
  }
  observe(events: Notification[]) {
    const parsed = events.map((e) => Notification.parse(e));
    this.state.change((s) => {
      s.events = s.events.filter(
        (e) => e.occurredAt > this.now() - NOTIFICATION_TTL,
      );
      for (const event of parsed) {
        if (event.occurredAt > this.now() + 60000)
          throw new Error("Invalid completion timestamp");
        if (
          event.occurredAt < this.now() - NOTIFICATION_TTL ||
          event.occurredAt < s.cursor - 1000
        )
          continue;
        if (!s.events.some((e) => e.id === event.id))
          s.events.push({ ...event, acked: false });
      }
      if (s.events.length > 10000) throw new Error("Completion outbox is full");
      s.cursor = parsed.reduce(
        (cursor, e) => Math.max(cursor, e.occurredAt),
        s.cursor,
      );
    });
  }
  pending() {
    return this.state
      .read()
      .events.filter(
        (e) => !e.acked && e.occurredAt > this.now() - NOTIFICATION_TTL,
      )
      .slice(0, 100)
      .map(({ acked, ...event }) => event);
  }
  acknowledge(id: string) {
    this.state.change((s) => {
      const event = s.events.find((e) => e.id === id);
      if (event) event.acked = true;
    });
  }
  close() {
    this.state.close();
  }
}
