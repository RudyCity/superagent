/** Host-local native Tray operator project registry routes.
 * Project registration never grants MCP capabilities. Mutations require a
 * one-use proof of an attended native dialog, not just the Core bearer.
 */
import type http from "node:http";
import { getProject, listProjects, registerProject, removeProject, updateProject } from "./projectRegistry.js";
import { projectOperatorProof } from "./projectOperatorProof.js";

type Respond = (res: http.ServerResponse, status: number, body: unknown) => void;
const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_BODY = 10_000;
function view(project: ReturnType<typeof getProject>) {
  if (!project) return null;
  return {
    projectId: project.id, name: project.name, type: project.type,
    target: project.root || project.target || "", description: project.description || "",
    enabled: project.enabled, updatedAt: project.updatedAt,
  };
}
function failure(message: string): string {
  if (message.startsWith("Project ID already exists:")) return "PROJECT_DUPLICATE_ID";
  if (message.startsWith("Project root already registered:")) return "PROJECT_DUPLICATE_ROOT";
  if (message.includes("Workspace Chain does not exist")) return "PROJECT_CHAIN_NOT_FOUND";
  if (message.includes("SSH")) return "PROJECT_INVALID_SSH";
  if (message.includes("directory") || message.includes("root")) return "PROJECT_INVALID_ROOT";
  return "PROJECT_MUTATION_INVALID_FIELDS";
}
function checkKeys(body: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(body).some(key => !allowed.includes(key))) throw Error("PROJECT_MUTATION_INVALID_FIELDS");
}
export async function handleProjectOperatorRoute(
  req: http.IncomingMessage, res: http.ServerResponse,
  pathname: string, readBody: (req: http.IncomingMessage) => Promise<string>,
  sendJSON: Respond,
): Promise<boolean> {
  if (!pathname.startsWith("/api/desktop/access/projects/")) return false;
  res.setHeader("Cache-Control", "no-store");
  if (pathname === "/api/desktop/access/projects/inventory" && req.method === "GET") {
    try { sendJSON(res, 200, { success: true, projects: listProjects().map(view) }); }
    catch { sendJSON(res, 500, { success: false, code: "PROJECT_INVENTORY_UNAVAILABLE" }); }
    return true;
  }
  if (pathname === "/api/desktop/access/projects/challenge" && req.method === "GET") {
    try { sendJSON(res, 200, { success: true, ...projectOperatorProof.issue() }); }
    catch { sendJSON(res, 409, { success: false, code: "PROJECT_OPERATOR_CHALLENGE_UNAVAILABLE" }); }
    return true;
  }
  if (pathname === "/api/desktop/access/projects/register" && req.method === "POST") {
    // Old binaries cannot bypass attended consent after installing new Core.
    sendJSON(res, 403, { success: false, code: "PROJECT_OPERATOR_PROOF_REQUIRED" });
    return true;
  }
  if (pathname !== "/api/desktop/access/projects/mutate" || req.method !== "POST") return false;
  let body: Record<string, unknown>;
  try {
    const raw = await readBody(req);
    if (Buffer.byteLength(raw, "utf8") > MAX_BODY) {
      sendJSON(res, 413, { success: false, code: "PROJECT_MUTATION_TOO_LARGE" }); return true;
    }
    body = projectOperatorProof.consume(JSON.parse(raw));
  } catch {
    sendJSON(res, 403, { success: false, code: "PROJECT_OPERATOR_PROOF_REQUIRED" }); return true;
  }
  const action = body.action;
  const allowed = action === "register"
    ? ["action", "id", "name", "type", "root", "target", "description"]
    : action === "update"
    ? ["action", "projectId", "expectedUpdatedAt", "name", "description", "root", "target", "enabled"]
    : action === "remove"
    ? ["action", "projectId", "expectedUpdatedAt"] : [];
  try {
    if (!allowed.length) throw Error("PROJECT_MUTATION_INVALID_FIELDS");
    checkKeys(body, allowed);
    if (action === "register") {
      if (!["local", "ssh", "chain"].includes(String(body.type)) ||
          typeof body.name !== "string" || !body.name.trim() ||
          (body.id !== undefined && (typeof body.id !== "string" || !ID.test(body.id))) ||
          (body.description !== undefined && typeof body.description !== "string") ||
          (body.type === "local" && (typeof body.root !== "string" || body.target !== undefined)) ||
          (body.type !== "local" && (typeof body.target !== "string" || body.root !== undefined)))
        throw Error("PROJECT_MUTATION_INVALID_FIELDS");
      const project = registerProject({
        id: body.id as string | undefined, name: body.name,
        type: body.type as "local" | "ssh" | "chain",
        root: body.root as string | undefined, target: body.target as string | undefined,
        description: body.description as string | undefined,
      });
      sendJSON(res, 201, { success: true, project: view(project), capabilitiesGranted: false });
      return true;
    }
    if (typeof body.projectId !== "string" || !ID.test(body.projectId) ||
        !Number.isSafeInteger(body.expectedUpdatedAt) || Number(body.expectedUpdatedAt) <= 0)
      throw Error("PROJECT_MUTATION_INVALID_FIELDS");
    const existing = getProject(body.projectId);
    if (!existing) {
      sendJSON(res, 404, { success: false, code: "PROJECT_NOT_FOUND" }); return true;
    }
    if (existing.updatedAt !== body.expectedUpdatedAt) {
      sendJSON(res, 409, { success: false, code: "PROJECT_STALE_REVISION" }); return true;
    }
    if (action === "remove") {
      removeProject(existing.id);
      sendJSON(res, 200, { success: true, projectId: existing.id, capabilitiesGranted: false });
      return true;
    }
    if (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim())) throw Error("PROJECT_MUTATION_INVALID_FIELDS");
    if (body.description !== undefined && typeof body.description !== "string") throw Error("PROJECT_MUTATION_INVALID_FIELDS");
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") throw Error("PROJECT_MUTATION_INVALID_FIELDS");
    if (existing.type === "local" && body.target !== undefined) throw Error("PROJECT_MUTATION_INVALID_FIELDS");
    if (existing.type !== "local" && body.root !== undefined) throw Error("PROJECT_MUTATION_INVALID_FIELDS");
    if (body.root !== undefined && typeof body.root !== "string") throw Error("PROJECT_MUTATION_INVALID_FIELDS");
    if (body.target !== undefined && typeof body.target !== "string") throw Error("PROJECT_MUTATION_INVALID_FIELDS");
    const project = updateProject(existing.id, {
      name: body.name as string | undefined,
      description: body.description as string | undefined,
      enabled: body.enabled as boolean | undefined,
      root: body.root as string | undefined,
      target: body.target as string | undefined,
    });
    sendJSON(res, 200, { success: true, project: view(project), capabilitiesGranted: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const code = failure(message);
    sendJSON(res, code.startsWith("PROJECT_DUPLICATE") ? 409 : 400, { success: false, code });
  }
  return true;
}
