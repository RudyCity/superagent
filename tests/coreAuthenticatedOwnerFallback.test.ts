import { describe, expect, it } from "vitest";
import { acceptsAuthenticatedCoreOwnerFallback } from "../src/core/runtime/serviceManager.js";

describe("Core authenticated owner fallback", () => {
  const safe = {
    platform: "win32",
    kernelOwner: 0,
    supervisorPid: 27392,
    serverInfoPid: 27392,
    birth: "matched" as const,
    publicProbe: true,
  };

  it("accepts only the Windows PID-0/null sentinel with matching private evidence", () => {
    expect(acceptsAuthenticatedCoreOwnerFallback(safe)).toBe(true);
    expect(acceptsAuthenticatedCoreOwnerFallback({...safe,kernelOwner:null})).toBe(true);
    expect(acceptsAuthenticatedCoreOwnerFallback({...safe,kernelOwner:99999})).toBe(false);
    expect(acceptsAuthenticatedCoreOwnerFallback({...safe,serverInfoPid:99999})).toBe(false);
    expect(acceptsAuthenticatedCoreOwnerFallback({...safe,birth:"mismatch"})).toBe(false);
    expect(acceptsAuthenticatedCoreOwnerFallback({...safe,publicProbe:false})).toBe(false);
    expect(acceptsAuthenticatedCoreOwnerFallback({...safe,platform:"linux"})).toBe(false);
  });
});
