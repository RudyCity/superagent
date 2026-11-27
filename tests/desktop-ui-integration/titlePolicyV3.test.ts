import { describe, expect, it } from "vitest";
import {
  desktopAccessRequiresExactTitle,
  evaluatePersistentAccess,
  hasRegisteredDesktopInputCandidate,
  parsePersistentAccessPolicy,
  type ExecutableIdentity,
  type PersistentAccessPolicy,
} from "../../src/core/desktopUi/persistentAccessPolicy.js";

const app: ExecutableIdentity = {
  platform: "win32",
  executablePath: "C:\\Apps\\Live\\live.exe",
  sha256: "e".repeat(64),
};

function policy(rules: PersistentAccessPolicy["rules"]): PersistentAccessPolicy {
  return { version: 2, defaultEffect: "deny", rules };
}

const view = { id: "view", kind: "desktop" as const, effect: "allow" as const, app, operations: ["view" as const] };
const input = { id: "input", kind: "desktop" as const, effect: "allow" as const, app, operations: ["input" as const] };

describe("registry v3 titlePolicy", () => {
  it("parses explicit app-scoped and exact title policies", () => {
    const appScoped = parsePersistentAccessPolicy(policy([
      { ...view, titlePolicy: "app", scope: {} },
      { ...input, titlePolicy: "app", scope: {} },
    ]));
    expect(appScoped?.rules[0]).toMatchObject({ titlePolicy: "app" });

    const exact = parsePersistentAccessPolicy(policy([
      { ...view, titlePolicy: "exact", scope: { windowTitle: "Pinned Editor" } },
    ]));
    expect(exact?.rules[0]).toMatchObject({ titlePolicy: "exact" });
  });

  it("rejects invalid policies instead of silently widening access", () => {
    const invalid = [
      policy([{ ...view, titlePolicy: "exact", scope: {} }]),
      policy([{ ...view, titlePolicy: "anything" as never, scope: {} }]),
      policy([{
        id: "file", kind: "file", effect: "allow", app,
        operations: ["read"], scope: { path: "C:\\work", recursive: true },
        titlePolicy: "app",
      } as never]),
    ];
    for (const candidate of invalid) {
      expect(parsePersistentAccessPolicy(candidate)).toBeNull();
    }
  });

  it("ignores a windowTitle scope for an app-scoped title policy", () => {
    const p = policy([{ ...view, titlePolicy: "app", scope: { windowTitle: "Old Title" } }]);
    expect(evaluatePersistentAccess(p, {
      kind: "desktop", app, operation: "view", windowTitle: "Renamed Live Editor",
    }).effect).toBe("allow");
  });

  it("keeps the exact title boundary for an exact title policy", () => {
    const p = policy([{ ...view, titlePolicy: "exact", scope: { windowTitle: "Pinned Editor" } }]);
    expect(evaluatePersistentAccess(p, {
      kind: "desktop", app, operation: "view", windowTitle: "Pinned Editor",
    }).effect).toBe("allow");
    expect(evaluatePersistentAccess(p, {
      kind: "desktop", app, operation: "view", windowTitle: "Secret Payroll",
    }).effect).toBe("deny");
  });

  it("requires the exact title only for exact or legacy title-scoped rules", () => {
    expect(desktopAccessRequiresExactTitle(policy([{ ...view, titlePolicy: "exact", scope: { windowTitle: "Pinned Editor" } }]), app, "view")).toBe(true);
    expect(desktopAccessRequiresExactTitle(policy([{ ...view, titlePolicy: "app", scope: {} }]), app, "view")).toBe(false);
    expect(desktopAccessRequiresExactTitle(policy([{ ...view, scope: { windowTitle: "Legacy" } }]), app, "view")).toBe(true);
    expect(desktopAccessRequiresExactTitle(policy([{ ...view, scope: {} }]), app, "view")).toBe(false);
    expect(desktopAccessRequiresExactTitle(policy([]), app, "view")).toBe(true);
  });

  it("admits input candidates for an app-scoped title policy after a rename", () => {
    const p = policy([{ ...input, titlePolicy: "app", scope: { windowTitle: "Old Title" } }]);
    expect(hasRegisteredDesktopInputCandidate(p, app, "Renamed Live Editor")).toBe(true);
    const exact = policy([{ ...input, titlePolicy: "exact", scope: { windowTitle: "Old Title" } }]);
    expect(hasRegisteredDesktopInputCandidate(exact, app, "Renamed Live Editor")).toBe(false);
  });
});
