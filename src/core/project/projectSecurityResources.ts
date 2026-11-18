export const MCP_CONNECTION_PROJECT_ID = "mcp-connection";
export const MCP_CONNECTION_PROJECT_PATH = "mcp://connection";

export class ReservedProjectIdError extends Error {
  readonly code = "RESERVED_PROJECT_ID";
  constructor() {
    super("[RESERVED_PROJECT_ID] A virtual MCP security resource cannot be registered as a project. Operator repair is required.");
    this.name = "ReservedProjectIdError";
  }
}

export function assertProjectIdNotReserved(id: string): void {
  if (id === MCP_CONNECTION_PROJECT_ID) throw new ReservedProjectIdError();
}
