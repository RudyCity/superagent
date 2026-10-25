/**
 * Cross-IDE Chrome CDP gateway.
 *
 * Each MCP transport owns an ephemeral X25519 key pair and private CDP
 * capabilities. Only the requester can decrypt an owner-approved one-time
 * invitation. Pending approvals contain NO plaintext session credentials.
 * Browser actions reuse the canonical per-target CDP coordinator.
 */
import {
  createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey,
  diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, randomUUID,
} from "node:crypto";
import { appendFile, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cdpGatewayRoot, cdpCoordinatorStatus, claimCdpTarget, getCdpParticipation,
  heartbeatCdpSession, inviteCdpAgent, joinCdpTarget, leaveCdpTarget,
  listCdpSessions, releaseCdpTarget, setCdpSharing, withCdpGatewayRegistryLock,
  type CdpParticipantRole,
} from "./chromeCdpSessionManager.js";
import { classifyCdpCommand } from "./chromeCdpCommandPolicy.js";
import {
  browserFingerprintForPort, currentManagedBrowserFingerprint,
  listVerifiedManagedBrowserRegistrations,
} from "./managedBrowserRegistry.js";
import { controlChromeCdpTool, discoverCdpPages } from "./chromeCdpTools.js";

type Attachment = {
  agentId: string; token: string; role: "owner" | CdpParticipantRole;
  browserFingerprint?: string;
};
type Sealed = { key: string; iv: string; tag: string; cipher: string };
type Request = {
  id: string; port: number; targetId: string; generation: string;
  requesterId: string; clientLabel: string; role: CdpParticipantRole;
  createdAt: number; expiresAt: number;
  publicKey: string; status: "pending" | "approved" | "denied"; sealed?: Sealed; inviteId?: string;
};
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const requestDir = () => join(cdpGatewayRoot(), "requests");
const eventsPath = () => join(cdpGatewayRoot(), "..", "events.jsonl");
const requestPath = (id: string) => {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid attach request ID.");
  return join(requestDir(), id + ".json");
};
const validPort = (value: unknown) => {
  const port = value === undefined ? Number(process.env.SUPERAGENT_CDP_PORT || 9222) : Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid CDP port.");
  return port;
};
const validTarget = (value: unknown) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    throw new Error("Explicit valid targetId required.");
  return value;
};
const publicRequest = (r: Request) => ({
  requestId: r.id, targetId: r.targetId, port: r.port, requesterId: r.requesterId,
  clientLabel: r.clientLabel, role: r.role, status: r.status, expiresAt: r.expiresAt,
});
async function saveRequest(r: Request) {
  await mkdir(requestDir(), { recursive: true, mode: 0o700 });
  const file = requestPath(r.id);
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temp, JSON.stringify(r), { mode: 0o600, flag: "wx" });
    await rename(temp, file);
  } finally { await rm(temp, { force: true }).catch(() => {}); }
}
async function readRequest(id: string): Promise<Request> {
  const r = JSON.parse(await readFile(requestPath(id), "utf8")) as Request;
  if (r.id !== id || !Number.isFinite(r.expiresAt) || r.expiresAt <= Date.now())
    throw new Error("Attach request expired or invalid.");
  return r;
}
async function listRequests() {
  await mkdir(requestDir(), { recursive: true, mode: 0o700 });
  const requests: Request[] = [];
  for (const name of (await readdir(requestDir())).filter(n => /^[0-9a-f-]{36}\.json$/.test(n)).slice(0, 128)) {
    try {
      const r = await readRequest(name.slice(0, -5));
      requests.push(r);
    } catch { await rm(join(requestDir(), name), { force: true }).catch(() => {}); }
  }
  return requests;
}
function sealFor(publicKey: string, invitationToken: string, requestId: string): Sealed {
  const ephemeral = generateKeyPairSync("x25519");
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: createPublicKey({
    key: Buffer.from(publicKey, "base64"), format: "der", type: "spki",
  }) });
  const key = Buffer.from(hkdfSync("sha256", shared, Buffer.from(requestId), Buffer.from("superagent-cdp-attach-v1"), 32));
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(invitationToken, "utf8"), cipher.final()]);
  return {
    key: ephemeral.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), cipher: ciphertext.toString("base64"),
  };
}
function openFor(privateKey: ReturnType<typeof createPrivateKey>, sealed: Sealed, requestId: string) {
  const shared = diffieHellman({ privateKey, publicKey: createPublicKey({
    key: Buffer.from(sealed.key, "base64"), format: "der", type: "spki",
  }) });
  const key = Buffer.from(hkdfSync("sha256", shared, Buffer.from(requestId), Buffer.from("superagent-cdp-attach-v1"), 32));
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(sealed.cipher, "base64")), decipher.final()]).toString("utf8");
}
const ALLOWED_ACTIONS = new Set([
  "snapshot", "shared_snapshot", "read_page", "extract_links", "screenshot",
  "click", "type", "navigate", "evaluate", "wait_for", "select_option", "check_form", "verify_action",
]);
export type GatewayClientContext = {
  /** Unforgeable ephemeral instance salt, unique to this MCP transport. */
  sessionId: string;
  /** ClientInfo.name from MCP initialization, informational and untrusted. */
  clientLabel?: string;
};
export class CrossIdeCdpGateway {
  readonly agentId: string;
  label: string;
  private readonly keys = generateKeyPairSync("x25519");
  private readonly capabilities = new Map<string, Attachment>();
  constructor(context: GatewayClientContext) {
    if (!context.sessionId) throw new Error("Authenticated MCP connection required.");
    this.agentId = "ide-" + sha(context.sessionId).slice(0, 24);
    this.label = String(context.clientLabel || "unknown").slice(0, 64).replace(/[^a-zA-Z0-9 ._-]/g, "");
  }
  setClientLabel(label: string | undefined) {
    if (label && label.length < 128) this.label = label.replace(/[^a-zA-Z0-9 ._-]/g, "").slice(0, 64);
  }
  private validateLocalHost() {
    const host = process.env.SUPERAGENT_CDP_HOST || "127.0.0.1";
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host))
      throw new Error("Cross-IDE gateway requires a loopback-only CDP host.");
  }
  private lookup(port: number, targetId: string) {
    const a = this.capabilities.get(port + ":" + targetId);
    if (!a) throw new Error("Not attached to tab: claim or request access first.");
    return a;
  }
  private remember(port: number, targetId: string, token: string,
      role: Attachment["role"], browserFingerprint?: string) {
    this.capabilities.set(port + ":" + targetId, { agentId: this.agentId, token, role, browserFingerprint });
  }
  private async event(name: string, key: string) {
    const row = { time: new Date().toISOString(), event: name, actor: this.agentId, key: key.slice(0, 16) };
    await appendFile(eventsPath(), JSON.stringify(row) + "\n", { mode: 0o600 }).catch(() => {});
  }
  async invoke(input: Record<string, any>): Promise<unknown> {
    const action = String(input.action || "");
    this.validateLocalHost();
    if (action === "identity") {
      return { agentId: this.agentId, clientLabel: this.label, labelTrust: "self-reported-by-MCP-client",
        authBoundary: "unique-MCP-connection", attached: [...this.capabilities.keys()] };
    }
    if (action === "managed") {
      return { registrations: await listVerifiedManagedBrowserRegistrations(),
        registry: "local-authenticated-announcements",
        authorization: "NO_CDP_CLAIM; claim or approved attach is separately required" };
    }
    if (action === "discover" || action === "policy") {
      const sessions = await cdpCoordinatorStatus(action === "discover" ? validPort(input.port) : undefined);
      const controls = {
        gatewayOnlyForMcp: process.env.SUPERAGENT_CDP_GATEWAY_ONLY === "1",
        cdplock: "cross-process-enforced-for-gateway-and-SuperAgent-CDP-clients",
        externalDirectCdp: "NOT_BLOCKED_BY_SUPERAGENT; browser debug port needs OS/network isolation",
      };
      if (action === "policy") return controls;
      let pages: Awaited<ReturnType<typeof discoverCdpPages>> = [];
      let browserError: string | undefined;
      try { pages = await discoverCdpPages(validPort(input.port)); }
      catch { browserError = "Chrome CDP is unreachable."; }
      return {
        port: validPort(input.port),
        client: { agentId: this.agentId, label: this.label },
        pages: pages.slice(0, 100).map(p => ({
          ...p,
          session: sessions.sessions.find(s => s.targetId === p.targetId && s.port === validPort(input.port)) || null,
        })),
        claimsWithoutOpenPage: sessions.sessions.filter(s => !pages.some(p => p.targetId === s.targetId)),
        queue: sessions.queue, summary: sessions.summary, ...(browserError ? { browserError } : {}),
      };
    }
    const port = validPort(input.port);
    const targetId = validTarget(input.targetId);
    if (action === "claim") {
      const pages = await discoverCdpPages(port);
      if (!pages.some(p => p.targetId === targetId)) throw new Error("CDP target not found; choose a discovered tab.");
      const existing = this.capabilities.get(port + ":" + targetId);
      const browserFingerprint = await currentManagedBrowserFingerprint(port, targetId);
      const claim = await claimCdpTarget(port, targetId, this.agentId, existing?.token);
      this.remember(port, targetId, claim.sessionToken, "owner", browserFingerprint || undefined);
      await this.event("ide_claim", claim.key);
      return { status: "owner", session: claimWithoutToken(claim) };
    }
    if (action === "request_attach") {
      const role = input.role as CdpParticipantRole;
      if (role !== "observer" && role !== "contributor") throw new Error("Role must be observer or contributor.");
      const owner = (await listCdpSessions()).find(s => s.port === port && s.targetId === targetId);
      if (!owner || owner.mode !== "shared") throw new Error("Owner must enable Shared Tab first.");
      if (owner.agentId === this.agentId) throw new Error("Already the tab owner.");
      return withCdpGatewayRegistryLock(async () => {
        const requests = await listRequests();
        if (requests.length >= 64) throw new Error("Attach queue is full.");
        const current = requests.find(r => r.requesterId === this.agentId && r.port === port &&
          r.targetId === targetId && r.status !== "denied");
        if (current) return publicRequest(current);
        const request: Request = {
          id: randomUUID(), port, targetId, generation: owner.generation,
          requesterId: this.agentId, clientLabel: this.label, role,
          createdAt: Date.now(), expiresAt: Math.min(Date.now() + 120_000, owner.expiresAt),
          publicKey: this.keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
          status: "pending",
        };
        await saveRequest(request);
        await this.event("ide_attach_requested", owner.key);
        return publicRequest(request);
      });
    }
    if (action === "pending" || action === "approve_attach" || action === "deny_attach") {
      const attached = this.lookup(port, targetId);
      const own = await getCdpParticipation(port, targetId, this.agentId, attached.token);
      if (own.agentId !== this.agentId || attached.role !== "owner") throw new Error("Owner session required.");
      return withCdpGatewayRegistryLock(async () => {
        if (action === "pending") {
          return (await listRequests()).filter(r => r.port === port && r.targetId === targetId &&
            r.generation === own.generation && r.status === "pending").map(publicRequest);
        }
        const r = await readRequest(String(input.requestId || ""));
        if (r.status !== "pending" || r.port !== port || r.targetId !== targetId ||
          r.generation !== own.generation) throw new Error("Request not pending for this owner generation.");
        if (action === "deny_attach") {
          r.status = "denied";
          await saveRequest(r);
          await this.event("ide_attach_denied", own.key);
        } else {
          const invitation = await inviteCdpAgent(port, targetId, this.agentId, attached.token, r.requesterId, r.role);
          // The invitation is encrypted before it touches persistent storage.
          r.sealed = sealFor(r.publicKey, invitation.invitationToken, r.id);
          r.inviteId = invitation.inviteId;
          r.status = "approved";
          r.expiresAt = Math.min(r.expiresAt, invitation.expiresAt);
          await saveRequest(r);
          await this.event("ide_attach_approved", own.key);
        }
        return { ...publicRequest(r), approvalContainsPlaintextToken: false };
      });
    }
    if (action === "poll_attach") {
      return withCdpGatewayRegistryLock(async () => {
        const r = await readRequest(String(input.requestId || ""));
        if (r.requesterId !== this.agentId || r.port !== port || r.targetId !== targetId)
          throw new Error("Only the original requesting MCP session may complete attachment.");
        if (r.status !== "approved") return publicRequest(r);
        const current = (await listCdpSessions()).find(s => s.port === port && s.targetId === targetId);
        if (!current || current.generation !== r.generation || current.mode !== "shared") {
          throw new Error("Owner claim changed; submit a new attach request.");
        }
        if (!r.sealed) throw new Error("Approved request lacks a sealed invitation.");
        const invitationToken = openFor(this.keys.privateKey, r.sealed, r.id);
        const invitation = await joinCdpTarget(port, targetId, this.agentId,
          r.inviteId || "", invitationToken);
        const browserFingerprint = await currentManagedBrowserFingerprint(port, targetId);
        this.remember(port, targetId, invitation.sessionToken, r.role, browserFingerprint || undefined);
        await rm(requestPath(r.id), { force: true });
        await this.event("ide_attach_joined", current.key);
        return { status: "attached", role: r.role, session: claimWithoutToken(invitation) };
      });
    }
    const attached = this.lookup(port, targetId);
    if (action !== "release" && attached.browserFingerprint &&
        await browserFingerprintForPort(port) !== attached.browserFingerprint) {
      throw new Error("Managed browser generation changed; release stale claim and pair again.");
    }
    if (action === "share") {
      if (attached.role !== "owner") throw new Error("Owner role required.");
      return setCdpSharing(port, targetId, this.agentId, attached.token, Boolean(input.enabled));
    }
    if (action === "release") {
      if (attached.role !== "owner") throw new Error("Owner role required.");
      await releaseCdpTarget(port, targetId, this.agentId, attached.token);
      this.capabilities.delete(port + ":" + targetId);
      return { status: "released" };
    }
    if (action === "leave") {
      if (attached.role === "owner") throw new Error("Owners must release or hand over, not leave.");
      await leaveCdpTarget(port, targetId, this.agentId, attached.token);
      this.capabilities.delete(port + ":" + targetId);
      return { status: "left" };
    }
    if (action === "heartbeat") return heartbeatCdpSession(port, targetId, this.agentId, attached.token);
    if (action === "execute") {
      const command = String(input.command || "");
      if (!ALLOWED_ACTIONS.has(command)) throw new Error("Command is not exposed through the cross-IDE gateway.");
      const args = input.payload || {};
      if (!args || typeof args !== "object" || Array.isArray(args) || JSON.stringify(args).length > 32000)
        throw new Error("Invalid browser action payload.");
      if (Object.keys(args).some(k => ["agentId", "sessionToken", "targetId", "command", "debug_port", "debug_ports"].includes(k)))
        throw new Error("Browser identity and routing parameters are server-managed.");
      const session = await getCdpParticipation(port, targetId, this.agentId, attached.token);
      const mutating = classifyCdpCommand(command, args) === "write";
      if (session.mode === "shared" && mutating &&
        (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0))
        throw new Error("Shared writes require expectedRevision from the last fresh snapshot/discovery.");
      const result = await controlChromeCdpTool.execute({
        command, targetId, agentId: this.agentId, sessionToken: attached.token,
        debug_port: port, payload: args,
        ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
      }, process.cwd());
      // Avoid leaking the private owner token through CDP helper results.
      const text = typeof result === "string" ? result : JSON.stringify(result);
      if (text.includes(attached.token)) throw new Error("Unexpected sensitive CDP result.");
      const failed = text.startsWith("control_chrome_cdp failed:");
      return { ok: !failed, result: text, revisionBefore: session.revision,
        ...(mutating && !failed ? { expectedNextRevision: session.revision + 1 } : {}) };
    }
    if (action === "events") return this.events(port, targetId, input.cursor);
    if (action === "wait_events") {
      const deadline = Date.now() + Math.min(10000, Math.max(0, Number(input.waitMs ?? 5000) || 0));
      while (true) {
        const result = await this.events(port, targetId, input.cursor);
        if (result.events.length > 0 || Date.now() >= deadline) return result;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
    throw new Error("Unknown cross-IDE browser gateway action.");
  }
  private async events(port: number, targetId: string, cursorArg?: unknown) {
    const attached = this.lookup(port, targetId);
    const session = await getCdpParticipation(port, targetId, this.agentId, attached.token);
    const cursor = Number.isSafeInteger(cursorArg) && Number(cursorArg) >= 0 ? Number(cursorArg) : 0;
    let file;
    try { file = await open(eventsPath(), "r"); } catch (e: any) {
      if (e.code === "ENOENT") return { events: [], cursor: 0, revision: session.revision };
      throw e;
    }
    try {
      const size = (await file.stat()).size;
      const start = cursor > size ? Math.max(0, size - 64_000) : Math.max(cursor, size - 64_000, 0);
      const chunk = Buffer.alloc(Math.max(0, size - start));
      if (chunk.length) await file.read(chunk, 0, chunk.length, start);
      const lines = chunk.toString("utf8").split("\n").slice(start > 0 && start !== cursor ? 1 : 0);
      const events: Array<{ time: string; event: string; actor: string }> = [];
      for (const line of lines.slice(-160)) {
        try {
          const e = JSON.parse(line);
          if (e.key === session.key.slice(0, 16) &&
              typeof e.event === "string" && /^[a-z_]{2,40}$/.test(e.event) &&
              typeof e.actor === "string" && /^[\w.\-:@]{1,96}$/.test(e.actor) &&
              typeof e.time === "string") events.push({ time: e.time, event: e.event, actor: e.actor });
        } catch { /* truncated event */ }
      }
      return { events: events.slice(-40), cursor: size, revision: session.revision };
    } finally { await file.close(); }
  }
}
function claimWithoutToken<T extends { sessionToken: string }>(claim: T): Omit<T, "sessionToken"> {
  const { sessionToken: _token, ...data } = claim;
  return data;
}
