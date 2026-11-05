/**
 * CLI handler for SuperAgent Global and Service-Scoped Lifecycle commands.
 *
 * Syntax:
 *   superagent lifecycle recycle-plan [--service <name>] [--port <port>]
 *   superagent lifecycle recycle [--service <name>] --operation-id <id> --confirm
 *   superagent lifecycle recycle-status --operation-id <id>
 *   superagent lifecycle reconcile --operation-id <id> [--service <name>] --confirm --reviewed
 */
import { manageServices } from "../runtime/serviceManager.js";
import { GlobalRecycleLedger } from "../runtime/globalLifecycleRecycle.js";
import type { ManagedServiceName } from "../runtime/serviceManagerTypes.js";

function parseArgs(args: string[]) {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        flags[key] = args[i + 1];
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { sub: positional[0]?.toLowerCase(), flags };
}

export async function handleLifecycleCliCommand(args: string[]): Promise<void> {
  const { sub, flags } = parseArgs(args);

  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    console.log(`
SuperAgent Lifecycle Management CLI

Usage:
  superagent lifecycle recycle-plan [--service <name>] [--port <port>]
  superagent lifecycle recycle [--service <name>] --operation-id <id> --confirm
  superagent lifecycle recycle-status --operation-id <id>
  superagent lifecycle reconcile --operation-id <id> [--service <name>] --confirm --reviewed

Commands:
  recycle-plan     Plan global or service-scoped lifecycle migration without mutation
  recycle          Execute a confirmed recycle migration plan
  recycle-status   Inspect status and child dispositions of a recycle transaction
  reconcile        Safely reconcile an uncertain operation after operator inspection

Services:
  all (default), core, tray, vision, transport, channel_host, muse, telegram, guardian, daemon, mcp
`);
    return;
  }

  if (sub === "recycle-plan" || sub === "plan") {
    const service = (flags.service as string) || "all";
    const port = flags.port ? Number(flags.port) : undefined;
    try {
      const plan = await manageServices({
        action: "plan",
        service: service as ManagedServiceName | "all",
        targetAction: "recycle",
        ...(port ? { port } : {}),
      });
      console.log(JSON.stringify(plan, null, 2));
    } catch (err) {
      console.error(
        "[Lifecycle Plan Error] " +
          (err instanceof Error ? err.message : String(err))
      );
      process.exit(1);
    }
    return;
  }

  if (sub === "recycle") {
    const service = (flags.service as string) || "all";
    const operationId = flags["operation-id"] as string;
    const confirm = flags.confirm === true;

    if (!confirm) {
      console.error(
        "[Lifecycle Recycle Error] Confirmation required: pass --confirm to execute migration"
      );
      process.exit(1);
    }
    if (!operationId) {
      console.error(
        "[Lifecycle Recycle Error] Planned operation ID required: pass --operation-id <id>"
      );
      process.exit(1);
    }

    try {
      const result = await manageServices({
        action: "recycle",
        service: service as ManagedServiceName | "all",
        confirm: true,
        operationId,
        noCoreShutdown: true,
        noPublicIngress: true,
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(
        "[Lifecycle Recycle Error] " +
          (err instanceof Error ? err.message : String(err))
      );
      process.exit(1);
    }
    return;
  }

  if (sub === "recycle-status" || sub === "status") {
    const operationId = flags["operation-id"] as string;
    if (!operationId) {
      console.error(
        "[Lifecycle Status Error] Operation ID required: pass --operation-id <id>"
      );
      process.exit(1);
    }
    const ledger = new GlobalRecycleLedger();
    const entry = ledger.lookup(operationId);
    if (!entry) {
      console.error(
        `[Lifecycle Status Error] Operation ${operationId} not found in global lifecycle ledger.`
      );
      process.exit(1);
    }
    console.log(JSON.stringify(entry, null, 2));
    return;
  }

  if (sub === "reconcile") {
    const service = (flags.service as string) || "all";
    const operationId = flags["operation-id"] as string;
    const confirm = flags.confirm === true;
    const reviewed = flags.reviewed === true;

    if (!confirm || !reviewed) {
      console.error(
        "[Lifecycle Reconcile Error] Explicit operator confirmation and review required: pass --confirm --reviewed"
      );
      process.exit(1);
    }
    if (!operationId) {
      console.error(
        "[Lifecycle Reconcile Error] Operation ID required: pass --operation-id <id>"
      );
      process.exit(1);
    }

    try {
      const result = await manageServices({
        action: "reconcile",
        service: service as ManagedServiceName | "all",
        confirm: true,
        reviewed: true,
        operationId,
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(
        "[Lifecycle Reconcile Error] " +
          (err instanceof Error ? err.message : String(err))
      );
      process.exit(1);
    }
    return;
  }

  console.error(`Unknown lifecycle subcommand: "${sub}". Run "superagent lifecycle help".`);
  process.exit(1);
}
