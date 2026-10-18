import { getRMemoryProjectId } from "../rmemoryUtil.js";
import { detectScopedMemoryConflicts, previewMemoryRetention } from "../memoryLifecycle.js";

interface MemoryCommandContextLike {
  agent?: { workingDirectory?: string; tier?: string; onQuestion?: (message: string, choices: string[]) => Promise<unknown> };
  addLine: (line: { type: string; content: string; timestamp: number }) => void;
}
function say(ctx: MemoryCommandContextLike, content: string, type = "system"): void {
  ctx.addLine({ type, content, timestamp: Date.now() });
}
function scopeOf(parts: string[], index = parts.length - 1): "project" | "global" {
  return parts.slice(index).some(part => part.toLowerCase() === "global") ? "global" : "project";
}
async function confirm(ctx: MemoryCommandContextLike, text: string): Promise<boolean> {
  if (typeof ctx.agent?.onQuestion !== "function") { say(ctx, "This memory operation requires interactive owner confirmation; no record was changed.", "error"); return false; }
  try {
    const answer = await ctx.agent.onQuestion(text, ["Yes", "No"]);
    if (answer === "Yes") return true;
  } catch {}
  say(ctx, "Operation cancelled; no memory record was changed.");
  return false;
}

export async function executeMemoryQualityCommand(
  subcommand: string,
  parts: string[],
  ctx: MemoryCommandContextLike,
  client: any,
): Promise<boolean> {
  const projectId = getRMemoryProjectId(ctx.agent?.workingDirectory || process.cwd());
  if (subcommand === "revise") {
    const action = (parts[1] || "help").toLowerCase();
    const id = parts[2] || "";
    const scope = scopeOf(parts);
    try {
      if (action === "preview") {
        const contentParts = parts.slice(3);
        if (contentParts.at(-1)?.toLowerCase() === "global") contentParts.pop();
        const content = contentParts.join(" ");
        if (!id || !content) throw new Error("Usage: /memory revise preview <id> <new content...> [global]");
        const preview = await client.previewAtomicRevision({ id, content, scope, projectId });
        say(ctx, JSON.stringify({ mode: "preview_only", ...preview }, null, 2));
        return true;
      }
      if (action === "apply") {
        const expectedUpdatedAt = parts[3] || "";
        const contentParts = parts.slice(4);
        if (contentParts.at(-1)?.toLowerCase() === "global") contentParts.pop();
        const content = contentParts.join(" ");
        if (!id || !expectedUpdatedAt || !content) throw new Error("Usage: /memory revise apply <id> <expectedUpdatedAt> <new content...> [global]");
        const preview = await client.previewAtomicRevision({ id, content, scope, projectId });
        if (!preview) throw new Error("Memory not found in requested scope.");
        let matches = false; try { matches = new Date(expectedUpdatedAt).toISOString() === preview.expectedUpdatedAt; } catch {}
        if (!matches) throw new Error("Memory changed since preview. Run preview again before applying.");
        if (!await confirm(ctx, `Revise ${scope} memory ${id}?\nBefore: ${preview.currentContent.slice(0, 600)}\nAfter: ${preview.proposedContent.slice(0, 600)}`)) return true;
        const result = await client.reviseAtomic({ id, content, scope, projectId, expectedUpdatedAt, reason: "memory_command_owner_revision" });
        say(ctx, JSON.stringify(result, null, 2)); return true;
      }
      if (action === "history") {
        if (!id) throw new Error("Usage: /memory revise history <id> [global]");
        const revisions = await client.listAtomicRevisions({ id, scope, projectId, limit: 50 });
        say(ctx, JSON.stringify({ id, scope, revisions }, null, 2)); return true;
      }
      if (action === "restore") {
        const revisionId = parts[3] || ""; const expectedUpdatedAt = parts[4] || "";
        if (!id || !revisionId || !expectedUpdatedAt) throw new Error("Usage: /memory revise restore <id> <revisionId> <expectedUpdatedAt> [global]");
        if (!await confirm(ctx, `Restore ${scope} memory ${id} from revision ${revisionId}?`)) return true;
        const result = await client.restoreAtomicRevision({ id, revisionId, scope, projectId, expectedUpdatedAt });
        say(ctx, JSON.stringify(result, null, 2)); return true;
      }
      throw new Error("Usage: /memory revise preview|apply|history|restore ...");
    } catch (err) { say(ctx, `Memory revision failed: ${(err as Error).message || String(err)}`, "error"); return true; }
  }

  if (subcommand === "review") {
    const action = (parts[1] || "conflicts").toLowerCase();
    const scope = scopeOf(parts);
    try {
      if (action === "conflicts") {
        const exported = await client.exportAtomic({ projectId, includeGlobal: true, limit: 500 });
        const conflicts = detectScopedMemoryConflicts(exported.items.map((item: any) => ({ id: item.id, content: item.content, scope: item.scope, metadata: item.metadata || {} })));
        say(ctx, JSON.stringify({ mode: "review_preview_only", scanned: exported.items.length, truncated: exported.truncated, conflicts }, null, 2)); return true;
      }
      if (action === "legacy-preview" || action === "legacy-map") {
        const sourceId = parts[2] || ""; const targetId = parts[3] || sourceId;
        const selectedScope = parts[4];
        if (!sourceId || !targetId || (selectedScope !== "project" && selectedScope !== "global")) {
          throw new Error("Usage: /memory review legacy-preview <sourceId> <targetId> <project|global> [content...] or legacy-map <sourceId> <targetId> <project|global> <fingerprint> [content...]");
        }
        const fingerprint = action === "legacy-map" ? (parts[5] || "") : undefined;
        const content = parts.slice(action === "legacy-map" ? 6 : 5).join(" ");
        const mapping = await client.previewLegacyAtomicMapping({ sourceId, targetId, scope: selectedScope, projectId, ...(content ? { content } : {}) });
        if (!mapping) throw new Error("Legacy source not found.");
        if (action === "legacy-preview") { say(ctx, JSON.stringify({ mode: "preview_only", ...mapping }, null, 2)); return true; }
        if (!fingerprint || fingerprint !== mapping.expectedSourceFingerprint) throw new Error("Source fingerprint is missing or has changed; preview again and use the exact fingerprint.");
        if (mapping.targetExists) throw new Error("Target exists; nothing was overwritten.");
        if (!await confirm(ctx, `Map legacy memory ${sourceId} to ${targetId} in ${selectedScope} scope? Original source remains preserved.`)) return true;
        const result = await client.mapLegacyAtomicMemory({ sourceId, targetId, scope: selectedScope, projectId, expectedSourceFingerprint: fingerprint,
          ...(content ? { content } : {}), reason: "memory_command_owner_mapping", agentTier: String(ctx.agent?.tier || "owner") });
        say(ctx, JSON.stringify(result, null, 2)); return true;
      }
      if (action === "mark-conflicted" || action === "resolve-conflict") {
        const id = parts[2] || ""; const peerId = parts[3] || ""; const expectedUpdatedAt = parts[4] || "";
        if (!id || !peerId || !expectedUpdatedAt || id === peerId) throw new Error(`Usage: /memory review ${action} <id> <peerId> <expectedUpdatedAt> [global]`);
        const current = await client.inspectAtomic({ id, scope, projectId });
        const peer = await client.inspectAtomic({ id: peerId, scope, projectId });
        if (!current || !peer) throw new Error("Both memories must exist in the same requested scope.");
        let matches = false; try { matches = new Date(expectedUpdatedAt).toISOString() === new Date(String(current.metadata.updatedAt || "")).toISOString(); } catch {}
        if (!matches) throw new Error("First memory changed since inspect; inspect both records again.");
        if (action === "mark-conflicted") {
          const candidates = detectScopedMemoryConflicts([
            { id: current.id, content: current.content, scope: current.scope, metadata: current.metadata },
            { id: peer.id, content: peer.content, scope: peer.scope, metadata: peer.metadata },
          ]);
          if (!candidates.length) throw new Error("Pair lacks a shared explicit assertionKey, exact scope, or different assertions.");
        } else if (current.metadata.lifecycleState !== "conflicted" || peer.metadata.lifecycleState !== "conflicted") {
          throw new Error("Both memories must be marked conflicted before the pair can be resolved.");
        }
        if (!await confirm(ctx, `${action} conflict pair ${id} + ${peerId}? Neither record will be selected as verified truth.`)) return true;
        const result = action === "mark-conflicted"
          ? await client.reviewAtomicConflictPair({ first: { id, expectedUpdatedAt }, second: { id: peerId, expectedUpdatedAt: String(peer.metadata.updatedAt || "") }, scope, projectId, reviewedBy: String(ctx.agent?.tier || "owner"), reason: "Owner confirmed conflicting assertions via /memory" })
          : await client.resolveAtomicConflictPair({ first: { id, expectedUpdatedAt }, second: { id: peerId, expectedUpdatedAt: String(peer.metadata.updatedAt || "") }, scope, projectId, reviewedBy: String(ctx.agent?.tier || "owner") });
        say(ctx, JSON.stringify(result, null, 2)); return true;
      }
      const id = parts[2] || ""; const expectedUpdatedAt = parts[3] || "";
      const reason = parts.slice(4).filter(part => part.toLowerCase() !== "global").join(" ") || "Owner review via /memory";
      if (!id || !expectedUpdatedAt || !["verify", "quarantine", "unquarantine"].includes(action)) {
        throw new Error("Usage: /memory review conflicts | legacy-preview ... | legacy-map ... | verify|quarantine|unquarantine <id> <expectedUpdatedAt> [reason...] [global]");
      }
      const current = await client.inspectAtomic({ id, scope, projectId });
      if (!current) throw new Error("Memory not found in requested scope.");
      let matches = false; try { matches = new Date(expectedUpdatedAt).toISOString() === new Date(String(current.metadata.updatedAt || "")).toISOString(); } catch {}
      if (!matches) throw new Error("Memory changed since inspect; inspect it again before review.");
      if (!await confirm(ctx, `${action} ${scope} memory ${id}? Reason: ${reason}`)) return true;
      const result = await client.reviewAtomic({ id, scope, projectId, expectedUpdatedAt, action, reason, reviewedBy: String(ctx.agent?.tier || "owner") });
      say(ctx, JSON.stringify(result, null, 2)); return true;
    } catch (err) { say(ctx, `Memory review failed: ${(err as Error).message || String(err)}`, "error"); return true; }
  }

  if (subcommand === "retention-review") {
    const action = (parts[1] || "preview").toLowerCase();
    try {
      if (action === "preview") {
        const exported = await client.exportAtomic({ projectId, includeGlobal: true, limit: 500 });
        const preview = previewMemoryRetention(exported.items, { limit: 200 });
        say(ctx, JSON.stringify({ mode: "preview_only", ...preview, exportTruncated: exported.truncated }, null, 2)); return true;
      }
      if (action !== "mark-stale") throw new Error("Usage: /memory retention-review preview | mark-stale <id> <expectedUpdatedAt> <project|global> [reason...]");
      const id = parts[2] || ""; const expectedUpdatedAt = parts[3] || "";
      const selectedScope = parts[4] === "global" ? "global" : "project";
      if (!id || !expectedUpdatedAt || !["project", "global"].includes(parts[4])) throw new Error("Explicit id, expectedUpdatedAt and project/global scope are required.");
      const current = await client.inspectAtomic({ id, scope: selectedScope, projectId });
      if (!current) throw new Error("Memory not found in requested scope.");
      const preview = previewMemoryRetention([{ id: current.id, content: current.content, scope: current.scope, metadata: current.metadata }], { limit: 1 });
      if (!preview.items.some(item => item.id === id && item.scope === selectedScope)) throw new Error("Memory is not eligible for retention marking.");
      const reason = parts.slice(5).join(" ") || "retention_review";
      if (!await confirm(ctx, `Mark ${selectedScope} memory ${id} stale? Content will remain stored; only default recall is affected.`)) return true;
      const result = await client.markAtomicStale({ id, scope: selectedScope, projectId, expectedUpdatedAt, reason });
      say(ctx, JSON.stringify(result, null, 2)); return true;
    } catch (err) { say(ctx, `Retention review failed: ${(err as Error).message || String(err)}`, "error"); return true; }
  }

  return false;
}
