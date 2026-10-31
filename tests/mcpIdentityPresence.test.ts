import { describe, it, expect, beforeEach } from "vitest";
import {
  recordMcpIdentityPresence,
  getMcpIdentityByHandle,
  getSanitizedMcpIdentity,
  listSanitizedMcpIdentities,
  getMostRecentMcpIdentityHandle,
  clearMcpIdentityPresence,
  deriveIdentityHandle,
  DEFAULT_IDENTITY_TTL_MS,
} from "../src/core/mcp/mcpIdentityPresence.js";
import { getProjectPrincipalKey } from "../src/core/project/projectAccessPolicy.js";

describe("mcpIdentityPresence", () => {
  beforeEach(() => {
    clearMcpIdentityPresence();
  });

  it("produces deterministic, opaque identityHandles without leaking token or hash", () => {
    const fakeToken = "super-secret-bearer-token-123456789";
    const credHash = "a".repeat(64);
    const identity = {
      mode: "static-bearer" as const,
      subject: "bearer",
      scopes: [],
      credentialHash: credHash,
    };

    const handle1 = deriveIdentityHandle(identity);
    const handle2 = deriveIdentityHandle(identity);

    expect(handle1).toBe(handle2);
    expect(handle1).toMatch(/^idh_[a-f0-9]{16}$/);

    // Ensure the handle does not contain the credential hash or raw token
    expect(handle1).not.toContain(credHash);
    expect(handle1).not.toContain(fakeToken);
  });

  it("records sanitized metadata and redacts secret/hash material in public representations", () => {
    const credHash = "b".repeat(64);
    const recorded = recordMcpIdentityPresence({
      mode: "oauth",
      subject: "tline-desktop-client-01",
      scopes: ["read", "write"],
      credentialHash: credHash,
    });

    // Sanitized record contains only the allowed fields
    expect(recorded.identityHandle).toMatch(/^idh_[a-f0-9]{16}$/);
    expect(recorded.mode).toBe("oauth");
    expect(recorded.subject).toBe("tline-desktop-client-01");
    expect(recorded.scopes).toEqual(["read", "write"]);
    expect(typeof recorded.lastSeenAt).toBe("number");

    // Must NOT contain credentialHash or token
    expect((recorded as any).credentialHash).toBeUndefined();
    expect((recorded as any).token).toBeUndefined();
    expect((recorded as any).principalKey).toBeUndefined();

    // Verify listSanitizedMcpIdentities has zero secret leakage
    const all = listSanitizedMcpIdentities();
    expect(all).toHaveLength(1);
    expect((all[0] as any).credentialHash).toBeUndefined();
    expect((all[0] as any).token).toBeUndefined();
    expect((all[0] as any).principalKey).toBeUndefined();

    // Verify getSanitizedMcpIdentity has zero secret leakage
    const sanitized = getSanitizedMcpIdentity(recorded.identityHandle);
    expect(sanitized).not.toBeNull();
    expect((sanitized as any).credentialHash).toBeUndefined();
  });

  it("retains the internal ProjectAccessIdentity needed by projectAccessPolicy", () => {
    const credHash = "c".repeat(64);
    const recorded = recordMcpIdentityPresence({
      mode: "static-bearer",
      subject: "bearer",
      scopes: [],
      credentialHash: credHash,
    });

    const internalIdentity = getMcpIdentityByHandle(recorded.identityHandle);
    expect(internalIdentity).not.toBeNull();
    expect(internalIdentity?.mode).toBe("static-bearer");
    expect(internalIdentity?.subject).toBe("bearer");
    expect(internalIdentity?.credentialHash).toBe(credHash);

    // Internal identity must be compatible with getProjectPrincipalKey
    const principalKey = getProjectPrincipalKey(internalIdentity!);
    expect(principalKey).toMatch(/^[a-f0-9]{64}$/);
  });

  it("updates lastSeenAt and unions scopes on repeat presence calls with stable handle", () => {
    const baseTime = 1000000;
    const credHash = "d".repeat(64);

    const first = recordMcpIdentityPresence(
      {
        mode: "oauth",
        subject: "client-a",
        scopes: ["read"],
        credentialHash: credHash,
      },
      { now: baseTime },
    );

    const second = recordMcpIdentityPresence(
      {
        mode: "oauth",
        subject: "client-a",
        scopes: ["write"],
        credentialHash: credHash,
      },
      { now: baseTime + 5000 },
    );

    expect(first.identityHandle).toBe(second.identityHandle);
    expect(second.lastSeenAt).toBe(baseTime + 5000);
    expect(second.scopes.sort()).toEqual(["read", "write"]);
    expect(listSanitizedMcpIdentities({ now: baseTime + 5000 })).toHaveLength(1);
  });

  it("orders identities with most recent first", () => {
    const base = 2000000;
    recordMcpIdentityPresence(
      { mode: "oauth", subject: "client-1", scopes: [], credentialHash: "1".repeat(64) },
      { now: base },
    );
    recordMcpIdentityPresence(
      { mode: "oauth", subject: "client-2", scopes: [], credentialHash: "2".repeat(64) },
      { now: base + 10000 },
    );

    const list = listSanitizedMcpIdentities({ now: base + 10000 });
    expect(list).toHaveLength(2);
    expect(list[0].subject).toBe("client-2");
    expect(list[1].subject).toBe("client-1");

    expect(getMostRecentMcpIdentityHandle({ now: base + 10000 })).toBe(list[0].identityHandle);
  });

  it("expires stale identities beyond 4 hours TTL", () => {
    const base = 3000000;
    const recorded = recordMcpIdentityPresence(
      { mode: "oauth", subject: "ephemeral-client", scopes: [], credentialHash: "3".repeat(64) },
      { now: base },
    );

    // Active after 3 hours
    const threeHoursLater = base + 3 * 60 * 60 * 1000;
    expect(getSanitizedMcpIdentity(recorded.identityHandle, { now: threeHoursLater })).not.toBeNull();
    expect(listSanitizedMcpIdentities({ now: threeHoursLater })).toHaveLength(1);

    // Expired after 4 hours + 1 second
    const expiredTime = base + DEFAULT_IDENTITY_TTL_MS + 1000;
    expect(getSanitizedMcpIdentity(recorded.identityHandle, { now: expiredTime })).toBeNull();
    expect(getMcpIdentityByHandle(recorded.identityHandle, { now: expiredTime })).toBeNull();
    expect(listSanitizedMcpIdentities({ now: expiredTime })).toHaveLength(0);
    expect(getMostRecentMcpIdentityHandle({ now: expiredTime })).toBeNull();
  });

  it("bounds registry size by evicting oldest entries when capacity is reached", () => {
    const base = 4000000;
    const maxIdentities = 3;

    const r1 = recordMcpIdentityPresence(
      { mode: "oauth", subject: "c1", scopes: [], credentialHash: "4".repeat(64) },
      { now: base, maxIdentities },
    );
    const r2 = recordMcpIdentityPresence(
      { mode: "oauth", subject: "c2", scopes: [], credentialHash: "5".repeat(64) },
      { now: base + 1000, maxIdentities },
    );
    const r3 = recordMcpIdentityPresence(
      { mode: "oauth", subject: "c3", scopes: [], credentialHash: "6".repeat(64) },
      { now: base + 2000, maxIdentities },
    );

    expect(listSanitizedMcpIdentities({ now: base + 2000 })).toHaveLength(3);

    // Add 4th item, exceeding bound of 3
    const r4 = recordMcpIdentityPresence(
      { mode: "oauth", subject: "c4", scopes: [], credentialHash: "7".repeat(64) },
      { now: base + 3000, maxIdentities },
    );

    const list = listSanitizedMcpIdentities({ now: base + 3000 });
    expect(list).toHaveLength(3);

    // Oldest (c1) must have been evicted
    expect(getSanitizedMcpIdentity(r1.identityHandle, { now: base + 3000 })).toBeNull();
    expect(getSanitizedMcpIdentity(r2.identityHandle, { now: base + 3000 })).not.toBeNull();
    expect(getSanitizedMcpIdentity(r3.identityHandle, { now: base + 3000 })).not.toBeNull();
    expect(getSanitizedMcpIdentity(r4.identityHandle, { now: base + 3000 })).not.toBeNull();
  });
});
