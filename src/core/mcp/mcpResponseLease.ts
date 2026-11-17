/**
 * Keep one MCP session lease until both the HTTP response and the async
 * handler have settled. SSE responses can outlive handleRequest(), while
 * aborted clients must not release still-running tool side effects.
 */
import type { ServerResponse } from "node:http";

export interface McpResponseLease {
  handlerResolved(): void;
  handlerRejected(): void;
}

export function createMcpResponseLease(
  response: Pick<ServerResponse, "once">,
  onRelease: () => void,
): McpResponseLease {
  let responseDone = false;
  let handlerDone = false;
  let released = false;
  const release = () => {
    if (released || !responseDone || !handlerDone) return;
    released = true;
    onRelease();
  };
  const responseFinished = () => {
    responseDone = true;
    release();
  };
  response.once("finish", responseFinished);
  response.once("close", responseFinished);
  return {
    handlerResolved() {
      handlerDone = true;
      release();
    },
    handlerRejected() {
      // A failed handler cannot continue; drop its lease even when the
      // response is no longer writable or never emitted finish.
      handlerDone = true;
      responseDone = true;
      release();
    },
  };
}
