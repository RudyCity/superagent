

export type TencentdbStatus = "online" | "offline" | "checking" | "disabled";

export function useTencentdbStatus(): TencentdbStatus {
  return "disabled";
}
