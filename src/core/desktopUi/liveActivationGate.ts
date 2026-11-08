export interface McpServiceEvidence {
  service: string;
  port: number;
  state: string;
  ownerPid: number | null;
  ownershipVerified: boolean;
  details?: {
    publicUrl?: string;
    reloadable?: boolean;
    backendPid?: number | null;
    backendHealthy?: boolean;
    authMode?: string;
    backendGenerationDetails?: Array<{ sessions?: number; inFlight?: number }>;
  };
}

export interface DesktopMcpActivationGate {
  ready: boolean;
  reasons: string[];
  warnings: string[];
  ownerPid: number | null;
  backendPid: number | null;
}

export function assessDesktopMcpOwnerEvidence(
  status: McpServiceEvidence | undefined,
  doctor: McpServiceEvidence | undefined,
  expectedUrl: string,
): DesktopMcpActivationGate {
  const reasons: string[] = [];
  const warnings: string[] = [];

  if (!status || !doctor || status.service !== "mcp" || doctor.service !== "mcp") {
    reasons.push("MCP_SERVICE_EVIDENCE_MISSING");
  } else {
    if (status.state !== "active" || doctor.state !== "active" ||
      status.ownershipVerified !== true || doctor.ownershipVerified !== true) {
      reasons.push("MCP_OWNER_NOT_CONSISTENTLY_VERIFIED");
    }
    if (!Number.isSafeInteger(status.ownerPid) || (status.ownerPid ?? 0) <= 0 ||
      doctor.ownerPid !== status.ownerPid || doctor.port !== status.port) {
      reasons.push("MCP_OWNER_IDENTITY_CHANGED");
    }
    if (!status.details?.reloadable || !doctor.details?.reloadable ||
      status.details?.backendHealthy !== true || doctor.details?.backendHealthy !== true) {
      reasons.push("MCP_BACKEND_NOT_HEALTHY");
    }
    if (!Number.isSafeInteger(status.details?.backendPid) ||
      (status.details?.backendPid ?? 0) <= 0 ||
      status.details?.backendPid !== doctor.details?.backendPid) {
      reasons.push("MCP_BACKEND_GENERATION_CHANGED");
    }
    if (!expectedUrl || status.details?.publicUrl !== expectedUrl ||
      doctor.details?.publicUrl !== expectedUrl) {
      reasons.push("MCP_PUBLIC_URL_MISMATCH");
    }
    if (status.details?.authMode !== doctor.details?.authMode) {
      reasons.push("MCP_AUTH_MODE_CHANGED");
    }
    const generations = status.details?.backendGenerationDetails ?? [];
    const sessions = generations.reduce((sum, item) => sum + (item.sessions ?? 0), 0);
    const inFlight = generations.reduce((sum, item) => sum + (item.inFlight ?? 0), 0);
    if (sessions > 0 || inFlight > 0) {
      warnings.push("MCP_SESSIONS_OR_REQUESTS_ACTIVE");
    }
  }

  return {
    ready: reasons.length === 0,
    reasons,
    warnings,
    ownerPid: status?.ownerPid ?? null,
    backendPid: status?.details?.backendPid ?? null,
  };
}
