import { AsyncLocalStorage } from "node:async_hooks";
import type { Agent } from "./agent.js";

/** Per-Agent async context shared by runtime code and tool adapters. */
export const agentLocalStorage = new AsyncLocalStorage<Agent>();
