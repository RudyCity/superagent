import { MANAGED_SERVICE_NAMES, type ManagedServiceName } from "./serviceManagerTypes.js";

export const READ_ONLY_SERVICE_ACTIONS = Object.freeze([
  "status", "inventory", "owner_status", "doctor", "health", "dashboard", "logs", "profile",
] as const);
export type ReadOnlyServiceAction = typeof READ_ONLY_SERVICE_ACTIONS[number];
export type ReadOnlyServiceArgs = {
  action: ReadOnlyServiceAction;
  service?: ManagedServiceName | "all";
  port?: number;
  limit?: number;
};
const actions: ReadonlySet<string> = new Set(READ_ONLY_SERVICE_ACTIONS);
const services: ReadonlySet<string> = new Set(["all", ...MANAGED_SERVICE_NAMES]);

export function isReadOnlyServiceAction(action: unknown): action is ReadOnlyServiceAction {
  return typeof action === "string" && actions.has(action);
}

export function validateServicePort(input: unknown, fallback?: number): number {
  const value = input === undefined ? fallback : input;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1024 || value > 65535)
    throw new Error("SERVICE_INVALID_PORT");
  return value;
}

/** Pure shape validation shared by discovery, host certification and dispatch. */
export function parseReadOnlyServiceArgs(raw: unknown): ReadOnlyServiceArgs | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const args = raw as Record<string, unknown>;
  if (Object.keys(args).some(key => !["action", "service", "port", "limit"].includes(key))) return null;
  const action = args.action === undefined ? "status" : args.action;
  if (!isReadOnlyServiceAction(action)) return null;
  if (args.service !== undefined &&
      (typeof args.service !== "string" || !services.has(args.service))) return null;
  if (args.port !== undefined &&
      (!Number.isSafeInteger(args.port) || Number(args.port) < 1024 || Number(args.port) > 65535)) return null;
  if (args.limit !== undefined &&
      (!Number.isSafeInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 200)) return null;
  return { ...args, action } as ReadOnlyServiceArgs;
}
