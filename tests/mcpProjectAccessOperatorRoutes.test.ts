import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleServerRoute } from "../src/serverRoutes.js";
import { ensureServerAuthToken } from "../src/core/utils/serverSecurity.js";

describe("MCP project access operator route boundary", () => {
  const priorConfig = process.env.SUPERAGENT_CONFIG_DIR;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "sa-project-operator-"));
  beforeAll(() => { process.env.SUPERAGENT_CONFIG_DIR = sandbox; });
  afterAll(() => {
    if (priorConfig === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
    else process.env.SUPERAGENT_CONFIG_DIR = priorConfig;
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
  async function invoke(
    pathname: string,
    options: { peer?: string; host?: string; origin?: string; token?: string; method?: string; body?: string; query?: string } = {},
  ) {
    const reply: { status?: number; body?: any } = {};
    const host = options.host ?? "localhost:7888";
    const headers: Record<string, string> = {
      host,
      authorization: "Bearer " + (options.token ?? ensureServerAuthToken()),
    };
    if (options.origin) headers.origin = options.origin;
    const req = {
      method: options.method ?? "POST",
      headers,
      socket: { remoteAddress: options.peer ?? "127.0.0.1" },
    } as any;
    const response = { setHeader() {} } as any;
    const ctx = {
      activeSessions: new Map(),
      readBody: async () => options.body || "{}",
      sendJSON(_res: unknown, status: number, body: any) {
        reply.status = status;
        reply.body = body;
      },
    } as any;
    const handled = await handleServerRoute(req, response, pathname,
      new URL("http://" + host + pathname + (options.query || "")), ctx);
    return { handled, ...reply };
  }

  it("denies approval over public/tunnel ingress even with a valid Core token", async () => {
    const result = await invoke("/api/desktop/access/requests/approve", {
      peer: "203.0.113.10", host: "superagent.example.com",
    });
    expect(result.handled).toBe(true);
    expect(result.status).toBe(403);
    expect(result.body?.code).toBe("LOCAL_OPERATOR_AUTH_REQUIRED");
  });

  it("denies legacy direct grant from remote hosts", async () => {
    const result = await invoke("/api/projects/browser/grant", {
      peer: "203.0.113.10", host: "superagent.example.com",
    });
    expect(result.handled).toBe(true);
    expect(result.status).toBe(403);
    expect(result.body?.code).toBe("LOCAL_OPERATOR_AUTH_REQUIRED");
  });

  it("denies a mismatched browser Origin even on loopback", async () => {
    const result = await invoke("/api/desktop/access/direct-grant", {
      origin: "https://untrusted.example.com",
    });
    expect(result.handled).toBe(true);
    expect(result.status).toBe(403);
    expect(result.body?.code).toBe("LOCAL_OPERATOR_AUTH_REQUIRED");
  });

  it("serves the complete read-only tool inventory only to the authenticated local operator", async () => {
    const local=await invoke("/api/desktop/access/tools",{method:"GET"});
    expect(local.status).toBe(200);
    expect(local.body?.scope).toBe("local_operator_advisory_catalog");
    expect(local.body?.active).toBeGreaterThanOrEqual(238);
    expect(local.body?.tools).toHaveLength(local.body.active);
    expect(local.body?.tools.find((t:any)=>t.name==="superagent_exec_command"))
      .toMatchObject({approvalKind:"project",capability:"execute"});
    expect(local.body?.tools.find((t:any)=>t.name==="superagent_register_project"))
      .toMatchObject({approvalKind:"operator_admin"});
    expect(JSON.stringify(local.body)).not.toMatch(/credentialHash|bearerToken|project-access\\.json/);
    const remote=await invoke("/api/desktop/access/tools",{
      method:"GET",peer:"203.0.113.10",host:"superagent.example.com",
    });
    expect(remote.status).toBe(403);
    const tokenDenied=await invoke("/api/desktop/access/tools",{
      method:"GET",token:"not-an-operator-token",
    });
    expect(tokenDenied.status).toBe(403);
  });

  it("rejects invalid tool inventory identity/project selectors without changing grants", async () => {
    for (const query of [
      "?identityHandle=not-an-identity",
      "?projectId=../other",
      "?unknown=1",
      "?identityHandle=idh_0123456789abcdef&identityHandle=idh_2222222222222222",
    ]) {
      const result=await invoke("/api/desktop/access/tools",{method:"GET",query});
      expect(result.status,query).toBe(400);
      expect(result.body?.code).toBe("INVALID_TOOL_INVENTORY_SELECTION");
    }
    const unknown=await invoke("/api/desktop/access/tools",{
      method:"GET",query:"?identityHandle=idh_0123456789abcdef&projectId=unknown",
    });
    expect(unknown.status).toBe(200);
    expect(unknown.body.selectedProjectRecognized).toBe(false);
    expect(unknown.body.grantedCapabilities).toEqual([]);
  });

  it("denies a local request without a valid operator token", async () => {
    const result = await invoke("/api/desktop/access/requests/deny", {
      token: "invalid-token",
    });
    expect(result.handled).toBe(true);
    expect(result.status).toBe(403);
  });

  it("rejects Add Project through remote/tunnel hosts or invalid local credentials", async () => {
    const pathname="/api/desktop/access/projects/register";
    const remote=await invoke(pathname,{peer:"203.0.113.10",host:"superagent.example.com"});
    expect(remote.status).toBe(403);
    expect(remote.body?.code).toBe("LOCAL_OPERATOR_AUTH_REQUIRED");
    const invalid=await invoke(pathname,{token:"not-a-real-operator-token"});
    expect(invalid.status).toBe(403);
    const mismatched=await invoke(pathname,{origin:"https://untrusted.example.com"});
    expect(mismatched.status).toBe(403);
  });

  it("requires a native one-use MAC beyond the Core bearer, and revokes on disable/remove", async () => {
    const folder=path.join(sandbox,"real-project");
    fs.mkdirSync(folder,{recursive:true});
    const registration={action:"register",id:"operator-fixture",name:"Operator Fixture",
      type:"local",root:folder};
    const challenge=await invoke("/api/desktop/access/projects/challenge",{method:"GET"});
    expect(challenge.status).toBe(200);
    expect(challenge.body.nonce).toMatch(/^[a-f0-9]{48}$/);
    const direct=await invoke("/api/desktop/access/projects/register",{body:JSON.stringify(registration)});
    expect(direct.status).toBe(403);
    const bypass=await invoke("/api/desktop/access/projects/mutate",
      {body:JSON.stringify(registration)});
    expect(bypass.status).toBe(403);
    const sign=(nonce:string,payload:any)=>{
      const key=Buffer.from(fs.readFileSync(path.join(sandbox,
        ".mcp-project-operator.key"),"utf8").trim(),"hex");
      const payloadText=JSON.stringify(payload);
      const mac=crypto.createHmac("sha256",key)
        .update("superagent-project-operator-v1:"+nonce+":"+payloadText).digest("hex");
      return JSON.stringify({payloadText,proof:{nonce,mac}});
    };
    const url="/api/desktop/access/projects/mutate";
    const registered=await invoke(url,{body:sign(challenge.body.nonce,registration)});
    expect(registered.status).toBe(201);
    expect(registered.body.capabilitiesGranted).toBe(false);
    expect(registered.body.project.projectId).toBe("operator-fixture");
    const replay=await invoke(url,{body:sign(challenge.body.nonce,registration)});
    expect(replay.status).toBe(403);
    const staleRev=registered.body.project.updatedAt;
    const disable={action:"update",projectId:"operator-fixture",
      expectedUpdatedAt:staleRev,enabled:false};
    const ch2=await invoke("/api/desktop/access/projects/challenge",{method:"GET"});
    const disabled=await invoke(url,{body:sign(ch2.body.nonce,disable)});
    expect(disabled.status).toBe(200);
    expect(disabled.body.project.enabled).toBe(false);
    const grantChoices=await invoke("/api/desktop/access/projects",{method:"GET"});
    expect(grantChoices.body.projects.some((p:any)=>p.projectId==="operator-fixture")).toBe(false);
    const inventory=await invoke("/api/desktop/access/projects/inventory",{method:"GET"});
    expect(inventory.body.projects.some((p:any)=>p.projectId==="operator-fixture")).toBe(true);
    const ch3=await invoke("/api/desktop/access/projects/challenge",{method:"GET"});
    const stale=await invoke(url,{body:sign(ch3.body.nonce,{
      action:"remove",projectId:"operator-fixture",expectedUpdatedAt:staleRev})});
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("PROJECT_STALE_REVISION");
    const ch4=await invoke("/api/desktop/access/projects/challenge",{method:"GET"});
    const removed=await invoke(url,{body:sign(ch4.body.nonce,{
      action:"remove",projectId:"operator-fixture",expectedUpdatedAt:disabled.body.project.updatedAt})});
    expect(removed.status).toBe(200);
    expect(removed.body.capabilitiesGranted).toBe(false);
  });

  it("returns only explicitly registered enabled project choices to native Tray", async () => {
    const result = await invoke("/api/desktop/access/projects", { method: "GET" });
    expect(result.handled).toBe(true);
    expect(result.status).toBe(200);
    expect(result.body?.success).toBe(true);
    expect(Array.isArray(result.body?.projects)).toBe(true);
    for (const project of result.body.projects) {
      expect(project.projectId).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/);
      expect(project.name.length).toBeGreaterThan(0);
      expect(["local", "ssh", "chain"]).toContain(project.type);
      expect(project.projectId).not.toBe("mcp-connection");
    }
  });

  it("denies remote reads of MCP grantable project choices", async () => {
    const result = await invoke("/api/desktop/access/projects", {
      method: "GET", peer: "203.0.113.10", host: "superagent.example.com",
    });
    expect(result.handled).toBe(true);
    expect(result.status).toBe(403);
    expect(result.body?.code).toBe("LOCAL_OPERATOR_AUTH_REQUIRED");
  });

  it("rejects remote connected client inventory even with a valid Core token",async()=>{
    const result=await invoke("/api/desktop/access/connected-clients",{
      method:"GET",peer:"203.0.113.10",host:"superagent.example.com",
    });
    expect(result.status).toBe(403);
    expect(result.body?.code).toBe("LOCAL_OPERATOR_AUTH_REQUIRED");
  });

  it("rejects local connected client inventory with an invalid Core token",async()=>{
    const result=await invoke("/api/desktop/access/connected-clients",{
      method:"GET",token:"invalid-token",
    });
    expect(result.status).toBe(403);
  });

  it("permits authenticated local read-only identity inventory", async () => {
    const result = await invoke("/api/desktop/access/identities", {
      method: "GET",
    });
    expect(result.handled).toBe(true);
    expect(result.status).toBe(200);
    expect(result.body?.success).toBe(true);
    expect(Array.isArray(result.body?.identities)).toBe(true);
  });
});
