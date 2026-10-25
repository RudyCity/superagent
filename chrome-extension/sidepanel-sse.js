// Header-authenticated SSE transport. Native EventSource cannot set Authorization,
// so it would expose long-lived bearer credentials through a URL query string.
function createAuthorizedEventStream(url) {
  let closed = false;
  let controller = null;
  let retryTimer = null;
  let retryDelay = 1000;
  let lastEventId = null;
  const stream = {
    onmessage: null,
    onerror: null,
    onopen: null,
    close() {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (controller) controller.abort();
    },
  };

  async function connect() {
    if (closed) return;
    controller = new AbortController();
    try {
      const streamUrl = new URL(url);
      if (lastEventId !== null) streamUrl.searchParams.set("lastEventId", lastEventId);
      const response = await fetch(streamUrl.toString(), {
        method: "GET",
        headers: { "Accept": "text/event-stream" },
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error("Event stream unavailable (HTTP " + response.status + ")");
      }
      retryDelay = 1000;
      if (!closed && typeof stream.onopen === "function") stream.onopen();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!closed) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        // Protect the sidepanel from unbounded frames, including a broken proxy.
        if (buffer.length > 4 * 1024 * 1024) throw new Error("SSE frame too large");
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame.split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          const eventId = frame.split("\n").find(line => line.startsWith("id:"));
          if (eventId) {
            const nextId = eventId.slice(3).trim();
            if (/^\d+$/.test(nextId)) lastEventId = nextId;
          }
          if (data && typeof stream.onmessage === "function") {
            stream.onmessage({ data, lastEventId });
          }
        }
      }
      if (!closed) throw new Error("Event stream disconnected");
    } catch (error) {
      if (!closed && typeof stream.onerror === "function") stream.onerror(error);
    }
    if (!closed) {
      const delay = retryDelay;
      retryDelay = Math.min(30000, retryDelay * 2);
      retryTimer = setTimeout(connect, delay);
    }
  }
  Promise.resolve().then(connect);
  return stream;
}
