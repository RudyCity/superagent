/**
 * SuperAgent Browser Runtime (Milestones M0 + M1 + M2)
 *
 * Dedicated Chromium/Chrome runtime management for headless and virtual-display
 * Linux automation, display environment probing, dynamic display allocation,
 * package discovery, process supervision, health checks, and lifecycle recovery.
 */

export * from "./types.js";
export * from "./browserExecutableDiscovery.js";
export * from "./browserFlags.js";
export * from "./browserProcessManager.js";
export * from "./virtualDisplayAllocation.js";
export * from "./virtualDisplayPackages.js";
export * from "./virtualDisplayWorker.js";
