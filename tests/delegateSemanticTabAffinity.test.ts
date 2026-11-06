import { describe, expect, it } from "vitest";
import { runWithAuthenticatedDelegatePrincipal } from "../src/core/browserTransport/delegatePrincipalPolicy.js";
import {
  bindDelegateSemanticAffinity,
  clearDelegateSemanticAffinity,
  resolveDelegateSemanticAffinity,
} from "../src/core/delegate/semanticTabAffinity.js";

const a = {sessionId:"session-affinity-00000001",mode:"oauth" as const,subject:"user-a"};
const b = {sessionId:"session-affinity-00000002",mode:"oauth" as const,subject:"user-b"};
const client = "client-affinity-01";

describe("semantic Delegate tab affinity", () => {
  it("keeps affinity isolated by authenticated MCP principal", () => {
    runWithAuthenticatedDelegatePrincipal(a, () => {
      bindDelegateSemanticAffinity(client, 101, "explicit", 1000);
      expect(resolveDelegateSemanticAffinity(client, {now:1001})?.tabId).toBe(101);
    });
    runWithAuthenticatedDelegatePrincipal(b, () => {
      expect(resolveDelegateSemanticAffinity(client, {now:1001})).toBeNull();
    });
  });

  it("never promotes observed read affinity into a write target", () => {
    runWithAuthenticatedDelegatePrincipal(a, () => {
      clearDelegateSemanticAffinity(client);
      bindDelegateSemanticAffinity(client, 202, "observed", 2000);
      expect(resolveDelegateSemanticAffinity(client, {now:2001})?.tabId).toBe(202);
      expect(resolveDelegateSemanticAffinity(client, {write:true,now:2001})).toBeNull();
      bindDelegateSemanticAffinity(client, 303, "created", 2002);
      expect(resolveDelegateSemanticAffinity(client, {write:true,now:2003})?.tabId).toBe(303);
    });
  });

  it("expires bounded in-memory affinity", () => {
    runWithAuthenticatedDelegatePrincipal(a, () => {
      clearDelegateSemanticAffinity(client);
      bindDelegateSemanticAffinity(client, 404, "explicit", 0);
      expect(resolveDelegateSemanticAffinity(client, {now:2*60*60_000+1})).toBeNull();
    });
  });
});
