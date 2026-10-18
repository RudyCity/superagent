import http from "http";
import { URL } from "url";
import { synthesizeSkill, listSynthesizedSkills } from "./skillSynthesizer.js";
import { listSkillCandidates } from "./skillLifecycle.js";

export async function handleSkillRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  parsedUrl: URL,
  ctx: {
    sendJSON: (res: http.ServerResponse, status: number, data: any) => void;
    readBody: (req: http.IncomingMessage) => Promise<string>;
    resolveWorkspacePath: (req: http.IncomingMessage) => string | null;
  }
): Promise<boolean> {
  const { sendJSON, readBody, resolveWorkspacePath } = ctx;

  // List Synthesized Skills
  if (pathname === "/api/skills/synthesized" && req.method === "GET") {
    const explicitWs = (req.headers["x-workspace-path"] as string) || parsedUrl.searchParams.get("workspace");
    const resolved = resolveWorkspacePath(req);
    if (explicitWs && !resolved) {
      sendJSON(res, 400, { error: "Invalid or unauthorized workspace path" });
      return true;
    }
    const workspace = resolved || process.cwd();
    const skills = listSynthesizedSkills(workspace);
    sendJSON(res, 200, { success: true, skills });
    return true;
  }

  // Candidates remain outside runtime discovery; this endpoint is read-only.
  if (pathname === "/api/skills/candidates" && req.method === "GET") {
    const explicitWs = (req.headers["x-workspace-path"] as string) || parsedUrl.searchParams.get("workspace");
    const resolved = resolveWorkspacePath(req);
    if (explicitWs && !resolved) {
      sendJSON(res, 400, { error: "Invalid or unauthorized workspace path" });
      return true;
    }
    const workspace = resolved || process.cwd();
    sendJSON(res, 200, { success: true, candidates: listSkillCandidates(workspace) });
    return true;
  }

  // Create inactive skill candidate
  if (pathname === "/api/skills/synthesize" && req.method === "POST") {
    try {
      const rawBody = await readBody(req);
      const payload = JSON.parse(rawBody || "{}");
      if (!payload.taskDescription) {
        sendJSON(res, 400, { error: "Missing required field: taskDescription" });
        return true;
      }
      const explicitWs = (req.headers["x-workspace-path"] as string) || parsedUrl.searchParams.get("workspace");
      const resolved = resolveWorkspacePath(req);
      if (explicitWs && !resolved) {
        sendJSON(res, 400, { error: "Invalid or unauthorized workspace path" });
        return true;
      }
      const workspace = resolved || process.cwd();
      // Workspace is strictly resolved from trusted request context; body input cannot override it.
      const { workspace: _untrustedBodyWorkspace, ...cleanPayload } = payload;
      const skill = await synthesizeSkill({
        ...cleanPayload,
        workspace
      });
      sendJSON(res, 201, { success: true, skill });
    } catch (err: any) {
      sendJSON(res, 400, { error: err.message || String(err) });
    }
    return true;
  }

  return false;
}
