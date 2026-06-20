import { describe, it, expect, vi } from "vitest";
import { isAndroidCliInstalledGlobally, isAndroidCliInstalledLocally, getLocalAndroidCliPath, isRgInstalledGlobally, isRgInstalledLocally, getLocalRgPath, isCurlInstalledGlobally, isCurlInstalledLocally, getLocalCurlPath } from "./androidSetup.js";
// Mock execa
vi.mock("execa", () => {
    return {
        execa: vi.fn().mockImplementation((cmd, args) => {
            if (cmd === "where.exe" || cmd === "which") {
                return Promise.resolve({ exitCode: 0, stdout: "path/to/cmd" });
            }
            return Promise.resolve({ exitCode: 0 });
        }),
    };
});
describe("androidSetup", () => {
    it("should check if android is installed globally", async () => {
        const installed = await isAndroidCliInstalledGlobally();
        expect(installed).toBe(true);
    });
    it("should construct local android CLI path correctly", () => {
        const localPath = getLocalAndroidCliPath();
        expect(localPath).toBeDefined();
        expect(localPath.toLowerCase()).toContain("android");
    });
    it("should check if android is installed locally", async () => {
        const installed = await isAndroidCliInstalledLocally();
        expect(typeof installed).toBe("boolean");
    });
    it("should check if rg is installed globally", async () => {
        const installed = await isRgInstalledGlobally();
        expect(installed).toBe(true);
    });
    it("should construct local rg path correctly", () => {
        const localPath = getLocalRgPath();
        expect(localPath).toBeDefined();
        expect(localPath.toLowerCase()).toContain("rg");
    });
    it("should check if rg is installed locally", async () => {
        const installed = await isRgInstalledLocally();
        expect(typeof installed).toBe("boolean");
    });
    it("should check if curl is installed globally", async () => {
        const installed = await isCurlInstalledGlobally();
        expect(installed).toBe(true);
    });
    it("should construct local curl path correctly", () => {
        const localPath = getLocalCurlPath();
        expect(localPath).toBeDefined();
        expect(localPath.toLowerCase()).toContain("curl");
    });
    it("should check if curl is installed locally", async () => {
        const installed = await isCurlInstalledLocally();
        expect(typeof installed).toBe("boolean");
    });
});
//# sourceMappingURL=androidSetup.test.js.map