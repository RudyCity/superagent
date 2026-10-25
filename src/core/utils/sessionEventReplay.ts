/** Bounded in-memory replay for session-scoped chat events.
 * This buffers only small frames; history reconciliation handles large content
 * and core generations that restart without their previous replay buffer.
 */
export class SessionEventReplay {
  private nextId = 0;
  private readonly sessions = new Map<string, Array<{ id: number; frame: string }>>();
  constructor(
    private readonly maxEventsPerSession = 128,
    private readonly maxSessions = 64,
    private readonly maxFrameBytes = 16 * 1024,
  ) {}

  publish(sessionId: string, serializedEvent: string): string {
    const id = ++this.nextId;
    const frame = `id: ${id}\ndata: ${serializedEvent}\n\n`;
    if (!sessionId || Buffer.byteLength(frame) > this.maxFrameBytes) return frame;
    let events = this.sessions.get(sessionId);
    if (!events) {
      events = [];
      this.sessions.set(sessionId, events);
    } else {
      this.sessions.delete(sessionId);
      this.sessions.set(sessionId, events);
    }
    events.push({ id, frame });
    if (events.length > this.maxEventsPerSession) events.shift();
    while (this.sessions.size > this.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (!oldest) break;
      this.sessions.delete(oldest);
    }
    return frame;
  }

  since(sessionId: string, lastEventId: string | number | undefined): string[] {
    if (!sessionId || lastEventId === undefined) return [];
    const cursor = Number(lastEventId);
    if (!Number.isSafeInteger(cursor) || cursor < 0) return [];
    return (this.sessions.get(sessionId) || [])
      .filter(event => event.id > cursor)
      .map(event => event.frame);
  }
}
