/**
 * mcpCapabilityMatrix.ts — Unified Tool Capability Matrix for SuperAgent MCP.
 *
 * Single source of truth for all MCP tools and actions/subcommands.
 * Defines OAuth scopes, project capabilities, host file-policy requirements,
 * native approvals, dependencies, runtime services, session requirements,
 * readiness states, and test status ledgers.
 */

import { MCP_TOOL_CLASSIFICATION, DISABLED_MCP_TOOLS, PRIVILEGED_MCP_TOOLS } from "./mcpToolPolicy.js";
import { WORKSPACE_SCOPED_MCP_TOOLS, PROJECT_REGISTRY_TOOL_NAMES } from "./mcpWorkspacePolicy.js";
import { MCP_GATEWAY_TOOL_NAMES } from "./mcpToolGateway.js";
import { getProjectCapabilityForTool, type ProjectAccessCapability } from "../project/projectAccessPolicy.js";
import { getPermanentFileToolReadiness, fileRulesRegistered } from "../tools/registeredFileToolGate.js";

export type ToolActionReadiness =
  | "ready"
  | "approval_required"
  | "unsupported_here"
  | "dependency_missing"
  | "service_unavailable"
  | "policy_blocked";

export type ToolActionTestStatus =
  | "discovered"
  | "schema_valid"
  | "policy_classified"
  | "authorized"
  | "dependency_ready"
  | "runtime_reachable"
  | "smoke_tested"
  | "end_to_end_verified"
  | "not_tested_by_design";

export type HostFilePolicyRequirement =
  | "not_applicable"
  | "certified_read"
  | "certified_write"
  | "requires_explicit_files"
  | "certified_web"
  | "certified_upload_ingress"
  | "uncertified";

export type NativeApprovalRequirement =
  | "not_required"
  | "operator_approval"
  | "device_owner_approval"
  | "target_claim_required";

export interface ActionCapabilityDescriptor {
  toolName: string;
  action: string;
  description: string;
  oauthScopes: string[];
  projectCapability: ProjectAccessCapability | null;
  hostFilePolicy: HostFilePolicyRequirement;
  nativeApproval: NativeApprovalRequirement;
  dependencies: string[];
  runtimeService: string | null;
  targetSessionRequirement: "none" | "principal_bound" | "target_lease" | "profile_claimed";
  pathFileScope: "none" | "workspace_only" | "ingress_staged" | "explicit_files" | "project_root";
  readiness: ToolActionReadiness;
  testStatus: ToolActionTestStatus;
  runtimeEvidence?: string;
  remediation?: string;
}

export interface CapabilityEvaluationContext {
  identity?: { scopes?: string[]; subject?: string } | null;
  projectId?: string | null;
  hasProjectAccess?: (cap: ProjectAccessCapability) => boolean;
  hostPolicyActive?: boolean;
  args?: Record<string, unknown>;
  dependencyCheck?: (dep: string) => boolean;
  serviceCheck?: (service: string) => boolean;
  targetClaimed?: boolean;
  sessionLeased?: boolean;
}

export interface EvaluatedActionCapability extends ActionCapabilityDescriptor {
  effectiveReadiness: ToolActionReadiness;
  reasonCode: string;
  remediationMessage?: string;
  blockers: string[];
}

/** Registry of fine-grained multi-action capabilities for nuanced tools */
const MULTI_ACTION_CAPABILITY_REGISTRY: Record<string, Record<string, Partial<ActionCapabilityDescriptor>>> = {
  superagent_chrome_cdp: {
    list_targets: {
      description: "List reachable browser tabs and targets.",
      oauthScopes: ["mcp:tools"],
      projectCapability: null,
      hostFilePolicy: "certified_read",
      nativeApproval: "not_required",
      dependencies: [],
      runtimeService: "cdp",
      targetSessionRequirement: "none",
      pathFileScope: "none",
      readiness: "ready",
      testStatus: "smoke_tested",
      runtimeEvidence: "Returns CDP target inventory over HTTP/WS port 9222",
    },
    transport_status: {
      description: "Inspect browser transport readiness and active connections.",
      oauthScopes: ["mcp:tools"],
      projectCapability: null,
      hostFilePolicy: "certified_read",
      nativeApproval: "not_required",
      dependencies: [],
      runtimeService: "cdp",
      targetSessionRequirement: "none",
      pathFileScope: "none",
      readiness: "ready",
      testStatus: "smoke_tested",
    },
    snapshot: {
      description: "Extract accessibility snapshot or text from claimed tab.",
      oauthScopes: ["mcp:tools"],
      projectCapability: null,
      hostFilePolicy: "certified_web",
      nativeApproval: "target_claim_required",
      dependencies: [],
      runtimeService: "cdp",
      targetSessionRequirement: "target_lease",
      pathFileScope: "none",
      readiness: "ready",
      testStatus: "smoke_tested",
    },
    read_page: {
      description: "Read parsed page content and metadata.",
      oauthScopes: ["mcp:tools"],
      projectCapability: null,
      hostFilePolicy: "certified_web",
      nativeApproval: "target_claim_required",
      dependencies: [],
      runtimeService: "cdp",
      targetSessionRequirement: "target_lease",
      pathFileScope: "none",
      readiness: "ready",
      testStatus: "smoke_tested",
    },
    extract_links: {
      description: "Extract public links from current claimed web page.",
      oauthScopes: ["mcp:tools"],
      projectCapability: null,
      hostFilePolicy: "certified_web",
      nativeApproval: "target_claim_required",
      dependencies: [],
      runtimeService: "cdp",
      targetSessionRequirement: "target_lease",
      pathFileScope: "none",
      readiness: "ready",
      testStatus: "smoke_tested",
    },
    claim_target: {
      description: "Obtain an unforgeable session lease on a specific browser target.",
      oauthScopes: ["mcp:tools", "mcp:tools:write"],
      projectCapability: null,
      hostFilePolicy: "certified_web",
      nativeApproval: "target_claim_required",
      dependencies: [],
      runtimeService: "cdp",
      targetSessionRequirement: "principal_bound",
      pathFileScope: "none",
      readiness: "ready",
      testStatus: "end_to_end_verified",
    },
    release_target: {
      description: "Release an active session lease on a browser target.",
      oauthScopes: ["mcp:tools", "mcp:tools:write"],
      projectCapability: null,
      hostFilePolicy: "certified_web",
      nativeApproval: "not_required",
      dependencies: [],
      runtimeService: "cdp",
      targetSessionRequirement: "target_lease",
      pathFileScope: "none",
      readiness: "ready",
      testStatus: "end_to_end_verified",
    },
    navigate: {
      description: "Navigate active tab to a certified public HTTP/HTTPS URL.",
      oauthScopes: ["mcp:tools", "mcp:tools:write"],
      projectCapability: null,
      hostFilePolicy: "certified_web",
      nativeApproval: "target_claim_required",
      dependencies: [],
      runtimeService: "cdp",
      targetSessionRequirement: "target_lease",
      pathFileScope: "none",
      readiness: "ready",
      testStatus: "end_to_end_verified",
    },
    click: {
      description: "Click a certified web DOM selector or point.",
      oauthScopes: ["mcp:tools", "mcp:tools:write"],
      projectCapability: null,
      hostFilePolicy: "certified_web",
      nativeApproval: "target_claim_required",
      dependencies: [],
      runtimeService: "cdp",
      targetSessionRequirement: "target_lease",
      pathFileScope: "none",
      readiness: "ready",
      testStatus: "end_to_end_verified",
    },
    type: {
      description: "Type text into a certified form element.",
      oauthScopes: ["mcp:tools", "mcp:tools:write"],
      projectCapability: null,
      hostFilePolicy: "certified_web",
      nativeApproval: "target_claim_required",
      dependencies: [],
      runtimeService: "cdp",
      targetSessionRequirement: "target_lease",
      pathFileScope: "none",
      readiness: "ready",
      testStatus: "end_to_end_verified",
    },
    list_file_inputs: {
      description: "Inspect file upload input elements on the current page.",
      oauthScopes: ["mcp:tools"],
      projectCapability: null,
      hostFilePolicy: "certified_web",
      nativeApproval: "target_claim_required",
      dependencies: [],
      runtimeService: "cdp",
      targetSessionRequirement: "target_lease",
      pathFileScope: "none",
      readiness: "ready",
      testStatus: "smoke_tested",
    },
    upload_file: {
      description: "Upload user-selected file through isolated secure ingress path.",
      oauthScopes: ["mcp:tools", "mcp:tools:write"],
      projectCapability: null,
      hostFilePolicy: "certified_upload_ingress",
      nativeApproval: "operator_approval",
      dependencies: [],
      runtimeService: "cdp",
      targetSessionRequirement: "target_lease",
      pathFileScope: "ingress_staged",
      readiness: "approval_required",
      testStatus: "policy_classified",
      runtimeEvidence: "Core stages the source only after native host read authorization, verifies MIME and SHA-256, binds a short-lived receipt to the authenticated principal and exact Delegate lease, then uses CDP setFileInputFiles.",
      remediation: "Call upload_file on an exact claimed Delegate target with confirmUpload:true, filePath, sessionToken and expectedRevision. Grant native host read access to the exact source file first; project grants and chat approval do not replace this file permission.",
    },
    handle_file_chooser: {
      description: "Handle native file chooser using verified staged ingress file.",
      oauthScopes: ["mcp:tools", "mcp:tools:write"],
      projectCapability: null,
      hostFilePolicy: "certified_upload_ingress",
      nativeApproval: "operator_approval",
      dependencies: [],
      runtimeService: "cdp",
      targetSessionRequirement: "target_lease",
      pathFileScope: "ingress_staged",
      readiness: "approval_required",
      testStatus: "end_to_end_verified",
    },
    verify_upload: {
      description: "Verify uploaded files attached to target input element.",
      oauthScopes: ["mcp:tools"],
      projectCapability: null,
      hostFilePolicy: "certified_web",
      nativeApproval: "target_claim_required",
      dependencies: [],
      runtimeService: "cdp",
      targetSessionRequirement: "target_lease",
      pathFileScope: "none",
      readiness: "ready",
      testStatus: "smoke_tested",
    },
    eval_js: {
      description: "Execute arbitrary JavaScript in page context.",
      oauthScopes: ["mcp:tools", "mcp:tools:write"],
      projectCapability: "execute",
      hostFilePolicy: "uncertified",
      nativeApproval: "operator_approval",
      dependencies: ["chrome"],
      runtimeService: "cdp",
      targetSessionRequirement: "target_lease",
      pathFileScope: "none",
      readiness: "policy_blocked",
      testStatus: "not_tested_by_design",
      remediation: "eval_js is uncertified when permanent host file policy is active. Use certified DOM actions instead.",
    },
  },
  superagent_git_action: {
    status: {
      description: "Read git repository status.",
      oauthScopes: ["mcp:tools"],
      projectCapability: "read",
      hostFilePolicy: "requires_explicit_files",
      nativeApproval: "not_required",
      dependencies: [],
      runtimeService: null,
      targetSessionRequirement: "none",
      pathFileScope: "project_root",
      readiness: "ready",
      testStatus: "smoke_tested",
    },
    diff: {
      description: "Read git diff of working tree or staged changes.",
      oauthScopes: ["mcp:tools"],
      projectCapability: "read",
      hostFilePolicy: "requires_explicit_files",
      nativeApproval: "not_required",
      dependencies: [],
      runtimeService: null,
      targetSessionRequirement: "none",
      pathFileScope: "project_root",
      readiness: "ready",
      testStatus: "smoke_tested",
    },
    log: {
      description: "Read git commit log.",
      oauthScopes: ["mcp:tools"],
      projectCapability: "read",
      hostFilePolicy: "requires_explicit_files",
      nativeApproval: "not_required",
      dependencies: [],
      runtimeService: null,
      targetSessionRequirement: "none",
      pathFileScope: "project_root",
      readiness: "ready",
      testStatus: "smoke_tested",
    },
    add: {
      description: "Stage specified files in git.",
      oauthScopes: ["mcp:tools", "mcp:tools:write"],
      projectCapability: "git",
      hostFilePolicy: "requires_explicit_files",
      nativeApproval: "not_required",
      dependencies: [],
      runtimeService: null,
      targetSessionRequirement: "none",
      pathFileScope: "explicit_files",
      readiness: "ready",
      testStatus: "end_to_end_verified",
    },
    commit: {
      description: "Record git commit with message.",
      oauthScopes: ["mcp:tools", "mcp:tools:write"],
      projectCapability: "git",
      hostFilePolicy: "requires_explicit_files",
      nativeApproval: "operator_approval",
      dependencies: [],
      runtimeService: null,
      targetSessionRequirement: "none",
      pathFileScope: "project_root",
      readiness: "ready",
      testStatus: "end_to_end_verified",
    },
    restore: {
      description: "Restore working tree files.",
      oauthScopes: ["mcp:tools", "mcp:tools:write"],
      projectCapability: "git",
      hostFilePolicy: "requires_explicit_files",
      nativeApproval: "operator_approval",
      dependencies: [],
      runtimeService: null,
      targetSessionRequirement: "none",
      pathFileScope: "explicit_files",
      readiness: "approval_required",
      testStatus: "not_tested_by_design",
    },
  },
  superagent_desktop_ui: {
    probe: {
      description: "Probe local desktop UI automation capabilities.",
      oauthScopes: ["mcp:tools", "mcp:tools:write"],
      projectCapability: "execute",
      hostFilePolicy: "certified_read",
      nativeApproval: "not_required",
      dependencies: [],
      runtimeService: null,
      targetSessionRequirement: "none",
      pathFileScope: "none",
      readiness: "ready",
      testStatus: "smoke_tested",
    },
    // Certified read-only discovery (CERTIFIED_DESKTOP_DISCOVERY +
    // DISCOVERY_COMMAND_FIELDS) is declared explicitly so capability preflight
    // never derives it from the generic tool classification. `stats` returns a
    // bounded metrics snapshot only: no titles, no screenshot, no window
    // session, no input. Classification stays as conservative as its siblings.
    stats: {
      description: "Read bounded Desktop UI perception metrics (latency, carrier health, change ratio).",
      oauthScopes: ["mcp:tools", "mcp:tools:write"],
      projectCapability: "execute",
      hostFilePolicy: "certified_read",
      nativeApproval: "not_required",
      dependencies: [],
      runtimeService: null,
      targetSessionRequirement: "none",
      pathFileScope: "none",
      readiness: "ready",
      testStatus: "smoke_tested",
    },
    list_windows: {
      description: "List desktop windows and bounds.",
      oauthScopes: ["mcp:tools", "mcp:tools:write"],
      projectCapability: "execute",
      hostFilePolicy: "certified_read",
      nativeApproval: "not_required",
      dependencies: [],
      runtimeService: null,
      targetSessionRequirement: "none",
      pathFileScope: "none",
      readiness: "ready",
      testStatus: "smoke_tested",
    },
    get_active_window: {
      description: "Get currently active foreground desktop window metadata.",
      oauthScopes: ["mcp:tools", "mcp:tools:write"],
      projectCapability: "execute",
      hostFilePolicy: "certified_read",
      nativeApproval: "not_required",
      dependencies: [],
      runtimeService: null,
      targetSessionRequirement: "none",
      pathFileScope: "none",
      readiness: "ready",
      testStatus: "smoke_tested",
    },
    find_window: {
      description: "Search visible desktop windows by title/application/PID.",
      oauthScopes: ["mcp:tools", "mcp:tools:write"],
      projectCapability: "execute",
      hostFilePolicy: "certified_read",
      nativeApproval: "not_required",
      dependencies: [],
      runtimeService: null,
      targetSessionRequirement: "none",
      pathFileScope: "none",
      readiness: "ready",
      testStatus: "smoke_tested",
    },
    list_monitors: {
      description: "List active monitors and display bounds.",
      oauthScopes: ["mcp:tools", "mcp:tools:write"],
      projectCapability: "execute",
      hostFilePolicy: "certified_read",
      nativeApproval: "not_required",
      dependencies: [],
      runtimeService: null,
      targetSessionRequirement: "none",
      pathFileScope: "none",
      readiness: "ready",
      testStatus: "smoke_tested",
    },
    list_installed_apps: {
      description: "List installed desktop applications.",
      oauthScopes: ["mcp:tools", "mcp:tools:write"],
      projectCapability: "execute",
      hostFilePolicy: "certified_read",
      nativeApproval: "not_required",
      dependencies: [],
      runtimeService: null,
      targetSessionRequirement: "none",
      pathFileScope: "none",
      readiness: "ready",
      testStatus: "smoke_tested",
    },
    live_inventory: {
      description: "Inspect owned Desktop Live sessions.",
      oauthScopes: ["mcp:tools", "mcp:tools:write"],
      projectCapability: "execute",
      hostFilePolicy: "certified_read",
      nativeApproval: "not_required",
      dependencies: [],
      runtimeService: null,
      targetSessionRequirement: "none",
      pathFileScope: "none",
      readiness: "ready",
      testStatus: "smoke_tested",
    },
    inspect_security_prompts: {
      description: "Inspect native security prompt metadata.",
      oauthScopes: ["mcp:tools", "mcp:tools:write"],
      projectCapability: "execute",
      hostFilePolicy: "certified_read",
      nativeApproval: "not_required",
      dependencies: [],
      runtimeService: null,
      targetSessionRequirement: "none",
      pathFileScope: "none",
      readiness: "ready",
      testStatus: "smoke_tested",
    },
    live_stop: {
      description: "Stop an owned Desktop Live session by liveId and leaseToken.",
      oauthScopes: ["mcp:tools", "mcp:tools:write"],
      projectCapability: "execute",
      hostFilePolicy: "certified_read",
      nativeApproval: "target_claim_required",
      dependencies: [],
      runtimeService: null,
      targetSessionRequirement: "target_lease",
      pathFileScope: "none",
      readiness: "ready",
      testStatus: "smoke_tested",
    },
    close: {
      description: "Close an open Desktop UI session token.",
      oauthScopes: ["mcp:tools", "mcp:tools:write"],
      projectCapability: "execute",
      hostFilePolicy: "certified_read",
      nativeApproval: "target_claim_required",
      dependencies: [],
      runtimeService: null,
      targetSessionRequirement: "target_lease",
      pathFileScope: "none",
      readiness: "ready",
      testStatus: "smoke_tested",
    },
    open: {
      description: "Open a scoped Desktop UI session for a registered application.",
      oauthScopes: ["mcp:tools", "mcp:tools:write"],
      projectCapability: "execute",
      hostFilePolicy: "certified_read",
      nativeApproval: "operator_approval",
      dependencies: [],
      runtimeService: null,
      targetSessionRequirement: "none",
      pathFileScope: "none",
      readiness: "approval_required",
      testStatus: "end_to_end_verified",
      remediation: "Requires an approved permanent desktop rule in Tray Active Rules via superagent_request_application_access, exact full title, and foreground focus when requesting input (allowInput: true; use focus_window first if needed).",
    },
    snapshot: {
      description: "Capture semantic accessibility tree and optional screenshot for an open session.",
      oauthScopes: ["mcp:tools", "mcp:tools:write"],
      projectCapability: "execute",
      hostFilePolicy: "certified_read",
      nativeApproval: "operator_approval",
      dependencies: [],
      runtimeService: null,
      targetSessionRequirement: "target_lease",
      pathFileScope: "none",
      readiness: "approval_required",
      testStatus: "end_to_end_verified",
      remediation: "Requires an approved permanent desktop view rule in Tray Active Rules and active sessionToken.",
    },
    inspect_window: {
      description: "One-shot read-only inspection of an approved application window.",
      oauthScopes: ["mcp:tools", "mcp:tools:write"],
      projectCapability: "execute",
      hostFilePolicy: "certified_read",
      nativeApproval: "operator_approval",
      dependencies: [],
      runtimeService: null,
      targetSessionRequirement: "none",
      pathFileScope: "none",
      readiness: "approval_required",
      testStatus: "end_to_end_verified",
      remediation: "Requires an approved permanent desktop view rule in Tray Active Rules via superagent_request_application_access (captures by exact PID/window ID even in background on Windows via PrintWindow and on macOS via screencapture -l <cgWindowId>).",
    },
    action: {
      description: "Dispatch semantic click/type/key/scroll to an approved desktop window element.",
      oauthScopes: ["mcp:tools", "mcp:tools:write"],
      projectCapability: "execute",
      hostFilePolicy: "certified_write",
      nativeApproval: "operator_approval",
      dependencies: [],
      runtimeService: null,
      targetSessionRequirement: "target_lease",
      pathFileScope: "none",
      readiness: "approval_required",
      testStatus: "end_to_end_verified",
      remediation: "Requires an approved permanent desktop input rule in Tray Active Rules and fresh expectedRevision/expectedHash.",
    },
    focus_window: {
      description: "Focus an approved application window.",
      oauthScopes: ["mcp:tools", "mcp:tools:write"],
      projectCapability: "execute",
      hostFilePolicy: "certified_write",
      nativeApproval: "operator_approval",
      dependencies: [],
      runtimeService: null,
      targetSessionRequirement: "none",
      pathFileScope: "none",
      readiness: "approval_required",
      testStatus: "end_to_end_verified",
    },
    close_app: {
      description: "Close an approved application window.",
      oauthScopes: ["mcp:tools", "mcp:tools:write"],
      projectCapability: "execute",
      hostFilePolicy: "certified_write",
      nativeApproval: "operator_approval",
      dependencies: [],
      runtimeService: null,
      targetSessionRequirement: "none",
      pathFileScope: "none",
      readiness: "approval_required",
      testStatus: "not_tested_by_design",
    },
    restart_app: {
      description: "Restart an approved application window.",
      oauthScopes: ["mcp:tools", "mcp:tools:write"],
      projectCapability: "execute",
      hostFilePolicy: "certified_write",
      nativeApproval: "operator_approval",
      dependencies: [],
      runtimeService: null,
      targetSessionRequirement: "none",
      pathFileScope: "none",
      readiness: "approval_required",
      testStatus: "not_tested_by_design",
    },
    launch_app: {
      description: "Launch an installed application after verifying its AUMID resolves to a registered executable SHA-256.",
      oauthScopes: ["mcp:tools", "mcp:tools:write"],
      projectCapability: "execute",
      hostFilePolicy: "certified_write",
      nativeApproval: "operator_approval",
      dependencies: [],
      runtimeService: null,
      targetSessionRequirement: "none",
      pathFileScope: "none",
      readiness: "approval_required",
      testStatus: "not_tested_by_design",
      remediation: "Requires an approved permanent desktop input rule in Tray Active Rules matching the resolved .exe binary.",
    },
    plan_package_change: {
      description: "Create a digest-bound package change plan.",
      oauthScopes: ["mcp:tools", "mcp:tools:write"],
      projectCapability: "execute",
      hostFilePolicy: "certified_read",
      nativeApproval: "operator_approval",
      dependencies: [],
      runtimeService: null,
      targetSessionRequirement: "none",
      pathFileScope: "none",
      readiness: "approval_required",
      testStatus: "smoke_tested",
    },
    apply_package_change: {
      description: "Apply a host-approved digest-bound package change.",
      oauthScopes: ["mcp:tools", "mcp:tools:write"],
      projectCapability: "execute",
      hostFilePolicy: "certified_write",
      nativeApproval: "operator_approval",
      dependencies: [],
      runtimeService: null,
      targetSessionRequirement: "none",
      pathFileScope: "none",
      readiness: "approval_required",
      testStatus: "not_tested_by_design",
    },
    screenshot: {
      description: "Capture screenshot of full screen or window.",
      oauthScopes: ["mcp:tools", "mcp:tools:write"],
      projectCapability: "execute",
      hostFilePolicy: "uncertified",
      nativeApproval: "operator_approval",
      dependencies: [],
      runtimeService: null,
      targetSessionRequirement: "none",
      pathFileScope: "none",
      readiness: "approval_required",
      testStatus: "not_tested_by_design",
      remediation: "Desktop UI screenshots require explicit native attended consent.",
    },
    mouse_click: {
      description: "Send synthetic mouse click to desktop coordinate.",
      oauthScopes: ["mcp:tools", "mcp:tools:write"],
      projectCapability: "execute",
      hostFilePolicy: "uncertified",
      nativeApproval: "operator_approval",
      dependencies: [],
      runtimeService: null,
      targetSessionRequirement: "none",
      pathFileScope: "none",
      readiness: "approval_required",
      testStatus: "not_tested_by_design",
    },
  },
  superagent_services_status: {
    status: {
      description: "Inspect runtime health of SuperAgent services.",
      oauthScopes: ["mcp:tools"],
      projectCapability: null,
      hostFilePolicy: "not_applicable",
      nativeApproval: "not_required",
      dependencies: [],
      runtimeService: null,
      targetSessionRequirement: "none",
      pathFileScope: "none",
      readiness: "ready",
      testStatus: "smoke_tested",
    },
  },
  superagent_manage_services: {
    status: {
      description: "Read service manager status.",
      oauthScopes: ["mcp:tools"],
      projectCapability: null,
      hostFilePolicy: "not_applicable",
      nativeApproval: "not_required",
      dependencies: [],
      runtimeService: null,
      targetSessionRequirement: "none",
      pathFileScope: "none",
      readiness: "ready",
      testStatus: "smoke_tested",
    },
    plan: {
      description: "Generate non-destructive service mutation plan.",
      oauthScopes: ["mcp:tools", "mcp:tools:write"],
      projectCapability: null,
      hostFilePolicy: "not_applicable",
      nativeApproval: "not_required",
      dependencies: [],
      runtimeService: null,
      targetSessionRequirement: "none",
      pathFileScope: "none",
      readiness: "ready",
      testStatus: "smoke_tested",
    },
    reload: {
      description: "Execute planned service reload.",
      oauthScopes: ["mcp:tools", "mcp:tools:write"],
      projectCapability: null,
      hostFilePolicy: "not_applicable",
      nativeApproval: "operator_approval",
      dependencies: [],
      runtimeService: null,
      targetSessionRequirement: "none",
      pathFileScope: "none",
      readiness: "approval_required",
      testStatus: "not_tested_by_design",
    },
  },
  superagent_media_transform: {
    resize: {
      description: "Resize image within bounds.",
      oauthScopes: ["mcp:tools", "mcp:tools:write"],
      projectCapability: "write",
      hostFilePolicy: "requires_explicit_files",
      nativeApproval: "not_required",
      dependencies: ["sharp"],
      runtimeService: null,
      targetSessionRequirement: "none",
      pathFileScope: "explicit_files",
      readiness: "ready",
      testStatus: "end_to_end_verified",
    },
    remove_background: {
      description: "Remove image background using local rembg AI model.",
      oauthScopes: ["mcp:tools", "mcp:tools:write"],
      projectCapability: "write",
      hostFilePolicy: "requires_explicit_files",
      nativeApproval: "not_required",
      dependencies: ["python", "rembg"],
      runtimeService: null,
      targetSessionRequirement: "none",
      pathFileScope: "explicit_files",
      readiness: "ready",
      testStatus: "not_tested_by_design",
      remediation: "Requires local Python with rembg package installed.",
    },
  },
};

/**
 * Extracts action from tool arguments.
 * Checks "command", "action", "cmd", "mode", "operation".
 */
export function extractToolAction(toolName: string, args?: Record<string, unknown>): string {
  if (!args || typeof args !== "object") return "default";
  const candidate = args.command ?? args.action ?? args.cmd ?? args.mode ?? args.operation;
  if (typeof candidate === "string" && candidate.trim()) {
    return candidate.trim();
  }
  return "default";
}

/**
 * Derives default capability descriptor for any tool in the 251 catalog.
 */
export function getBaseToolCapability(toolName: string, action = "default"): ActionCapabilityDescriptor {
  const customActions = MULTI_ACTION_CAPABILITY_REGISTRY[toolName];
  if (customActions && customActions[action]) {
    const custom = customActions[action];
    return {
      toolName,
      action,
      description: custom.description || `${toolName} action ${action}`,
      oauthScopes: custom.oauthScopes || ["mcp:tools"],
      projectCapability: custom.projectCapability ?? null,
      hostFilePolicy: custom.hostFilePolicy || "not_applicable",
      nativeApproval: custom.nativeApproval || "not_required",
      dependencies: custom.dependencies || [],
      runtimeService: custom.runtimeService ?? null,
      targetSessionRequirement: custom.targetSessionRequirement || "none",
      pathFileScope: custom.pathFileScope || "none",
      readiness: custom.readiness || "ready",
      testStatus: custom.testStatus || "discovered",
      runtimeEvidence: custom.runtimeEvidence,
      remediation: custom.remediation,
    };
  }

  // Derive from existing static classification
  const risk = MCP_TOOL_CLASSIFICATION[toolName] || "dangerous";
  const isPrivileged = PRIVILEGED_MCP_TOOLS.has(toolName);
  const isWorkspace = WORKSPACE_SCOPED_MCP_TOOLS.has(toolName);
  const isRegistry = PROJECT_REGISTRY_TOOL_NAMES.has(toolName);
  const isGateway = toolName === MCP_GATEWAY_TOOL_NAMES.execute;

  const scopes = risk === "dangerous" ? ["mcp:tools", "mcp:tools:write"] : ["mcp:tools"];
  if (isPrivileged) scopes.push("mcp:tools:admin");

  const projectCap = isGateway
    ? null
    : isWorkspace
      ? getProjectCapabilityForTool(toolName)
      : isPrivileged
        ? null
        : risk === "dangerous" && !isRegistry
          ? "execute"
          : null;

  const hostReadiness = getPermanentFileToolReadiness(toolName);
  let hostPolicy: HostFilePolicyRequirement = "not_applicable";
  if (hostReadiness === "requires_explicit_files") hostPolicy = "requires_explicit_files";
  else if (hostReadiness === "certified_metadata") hostPolicy = "certified_read";
  else if (hostReadiness === "uncertified") hostPolicy = "uncertified";

  let testStatus: ToolActionTestStatus = "policy_classified";
  if (risk === "safe") {
    testStatus = "smoke_tested";
  } else {
    testStatus = "not_tested_by_design";
  }

  return {
    toolName,
    action,
    description: `${toolName} capability`,
    oauthScopes: scopes,
    projectCapability: projectCap,
    hostFilePolicy: hostPolicy,
    nativeApproval: isPrivileged ? "operator_approval" : "not_required",
    dependencies: [],
    runtimeService: null,
    targetSessionRequirement: "none",
    pathFileScope: isWorkspace ? "workspace_only" : "none",
    readiness: "ready",
    testStatus,
  };
}

/**
 * Returns all action descriptors for a given tool.
 */
export function getToolActionCapabilities(toolName: string): ActionCapabilityDescriptor[] {
  const multi = MULTI_ACTION_CAPABILITY_REGISTRY[toolName];
  if (multi) {
    return Object.keys(multi).map((action) => getBaseToolCapability(toolName, action));
  }
  return [getBaseToolCapability(toolName, "default")];
}

/**
 * Dynamically evaluates action capability against the active runtime context.
 */
export function evaluateActionCapability(
  descriptor: ActionCapabilityDescriptor,
  context: CapabilityEvaluationContext = {}
): EvaluatedActionCapability {
  const blockers: string[] = [];
  let effectiveReadiness: ToolActionReadiness = "ready";
  let reasonCode = "ready";
  let remediationMessage: string | undefined;

  // 1. OAuth Scopes check
  if (context.identity?.scopes) {
    const grantedScopes = new Set(context.identity.scopes);
    const missingScopes = descriptor.oauthScopes.filter((s) => !grantedScopes.has(s));
    if (missingScopes.length > 0) {
      blockers.push(`Missing OAuth scopes: ${missingScopes.join(", ")}`);
      effectiveReadiness = "approval_required";
      reasonCode = "oauth_scope_missing";
      remediationMessage = `Authorize client with required OAuth scopes: ${missingScopes.join(", ")}.`;
    }
  }

  // 2. Project Capability check
  if (descriptor.projectCapability && context.hasProjectAccess) {
    const hasCap = context.hasProjectAccess(descriptor.projectCapability);
    if (!hasCap) {
      blockers.push(`Missing project access capability: ${descriptor.projectCapability}`);
      effectiveReadiness = "approval_required";
      reasonCode = "project_grant_missing";
      remediationMessage = `Grant project access capability '${descriptor.projectCapability}' in Akses Proyek.`;
    }
  }

  // 3. Host File-Policy check
  const hostPolicyActive = context.hostPolicyActive ?? fileRulesRegistered();
  if (hostPolicyActive) {
    if (descriptor.hostFilePolicy === "uncertified") {
      blockers.push(`Host file-policy blocked: action '${descriptor.action}' in tool '${descriptor.toolName}' is uncertified.`);
      effectiveReadiness = "policy_blocked";
      reasonCode = "host_policy_blocked";
      remediationMessage = descriptor.remediation || "This action is restricted by permanent host file-policy.";
    } else if (descriptor.hostFilePolicy === "certified_upload_ingress") {
      // Check if arguments contain a validated ingress receipt
      const args = context.args || {};
      const hasReceipt = Boolean(args.ingressReceiptId || (args.__ingressReceipt && typeof args.__ingressReceipt === "object"));
      if (!hasReceipt && descriptor.action === "upload_file") {
        blockers.push("CDP upload_file requires certified secure ingress staging under active host file policy.");
        effectiveReadiness = "approval_required";
        reasonCode = "host_policy_blocked";
        remediationMessage = "Stage file via secure browser upload ingress before uploading.";
      }
    }
  }

  // 4. Dependencies check
  if (descriptor.dependencies.length > 0 && context.dependencyCheck) {
    const missingDeps = descriptor.dependencies.filter((d) => !context.dependencyCheck!(d));
    if (missingDeps.length > 0) {
      blockers.push(`Missing required runtime dependencies: ${missingDeps.join(", ")}`);
      effectiveReadiness = "dependency_missing";
      reasonCode = "dependency_missing";
      remediationMessage = `Install or configure missing dependencies: ${missingDeps.join(", ")}.`;
    }
  }

  // 5. Runtime Service check
  if (descriptor.runtimeService && context.serviceCheck) {
    const ok = context.serviceCheck(descriptor.runtimeService);
    if (!ok) {
      blockers.push(`Runtime service '${descriptor.runtimeService}' is unavailable.`);
      effectiveReadiness = "service_unavailable";
      reasonCode = "service_unavailable";
      remediationMessage = `Ensure service '${descriptor.runtimeService}' is running.`;
    }
  }

  // 6. Target Session Lease check
  if (descriptor.targetSessionRequirement === "target_lease" && context.sessionLeased === false) {
    blockers.push("Target browser session lease token missing or expired.");
    effectiveReadiness = "approval_required";
    reasonCode = "target_not_claimed";
    remediationMessage = "Claim browser target first via 'claim_target' to obtain an active session lease.";
  }

  return {
    ...descriptor,
    effectiveReadiness,
    reasonCode,
    remediationMessage: remediationMessage || descriptor.remediation,
    blockers,
  };
}
