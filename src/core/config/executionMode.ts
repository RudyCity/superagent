/**
 * Interpret model execution mode without letting shared process flags override
 * the mode attached to a particular agent/session.
 */
export function resolveModelExecutionMode(
  explicitSingleMode: boolean | undefined,
  processMultiFlag: boolean,
  globalSingleMode: boolean,
): "single" | "multi" {
  if (explicitSingleMode === true) return "single";
  if (explicitSingleMode === false) return "multi";
  return processMultiFlag && !globalSingleMode ? "multi" : "single";
}
