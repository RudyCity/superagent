import { useState, useEffect } from "react";
import { getSettings } from "../core/config/jsonConfig.js";
import { MemoryClient } from "@tencentdb-agent-memory/memory-sdk-ts";

export type TencentdbStatus = "online" | "offline" | "checking" | "disabled";

export function useTencentdbStatus(): TencentdbStatus {
  return "disabled";
}
