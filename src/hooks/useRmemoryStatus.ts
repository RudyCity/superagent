

export type RmemoryStatus = "online" | "offline" | "checking" | "disabled";

export function useRmemoryStatus(): RmemoryStatus {
  return "disabled";
}
