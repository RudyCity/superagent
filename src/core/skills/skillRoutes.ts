import http from "http";
import { URL } from "url";
import { synthesizeSkill, listSynthesizedSkills } from "./skillSynthesizer.js";

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
    const workspace = resolveWorkspacePath(req) || process.cwd();
    const skills = listSynthesizedSkills(workspace);
    sendJSON(res, 200, { success: true, skills });
    return true;
  }

  // Synthesize Skill
  if (pathname === "/api/skills/synthesize" && req.method === "POST") {
    try {
      const rawBody = await readBody(req);
      const payload = JSON.parse(rawBody || "{}");
      if (!payload.taskDescription) {
        sendJSON(res, 400, { error: "Missing required field: taskDescription" });
        return true;
      }
      const workspace = payload.workspace || resolveWorkspacePath(req) || process.cwd();
      const skill = await synthesizeSkill({
        ...payload,
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
