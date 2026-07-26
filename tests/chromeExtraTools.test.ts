import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  manageBrowserCookiesStorageTool,
  setBrowserEmulationTool,
  setNetworkConditionsTool,
} from "../src/core/tools/chromeExtraTools.js";
import { setBrowserControlHandler } from "../src/core/tools/browserMacroTools.js";

describe("chromeExtraTools", () => {
  beforeEach(() => {
    setBrowserControlHandler(null);
  });

  afterEach(() => {
    setBrowserControlHandler(null);
  });

  test("manageBrowserCookiesStorageTool delegates get/clear to handler", async () => {
    setBrowserControlHandler(async (action: string, target: string, value?: string) => {
      if (action === "execute_chain") {
        const data = JSON.parse(target);
        return `Storage action: ${data.action} on ${data.targetType}`;
      }
      if (action === "manage_storage") {
        return `Storage action: ${target} on ${value}`;
      }
      return "";
    });

    const res = await manageBrowserCookiesStorageTool.execute({ action: "clear", targetType: "cookies" });
    expect(res).toContain("Storage action: clear on cookies");
  });

  test("setBrowserEmulationTool delegates device emulation settings", async () => {
    setBrowserControlHandler(async (action: string, target: string) => {
      if (action === "execute_chain") {
        const data = JSON.parse(target);
        return `Emulating device: ${data.device}`;
      }
      if (action === "emulate_viewport") {
        return `Emulating device: ${target}`;
      }
      return "";
    });

    const res = await setBrowserEmulationTool.execute({ device: "mobile_iphone" });
    expect(res).toContain("Emulating device: mobile_iphone");
  });

  test("setNetworkConditionsTool delegates throttling and blocking rules", async () => {
    setBrowserControlHandler(async (action: string, target: string) => {
      if (action === "execute_chain") {
        const data = JSON.parse(target);
        return `Throttling: ${data.throttling}, BlockImages: ${data.blockImages}`;
      }
      if (action === "set_network_conditions") {
        return `Throttling: ${target}, BlockImages: true`;
      }
      return "";
    });

    const res = await setNetworkConditionsTool.execute({ throttling: "slow_3g", blockImages: true });
    expect(res).toContain("Throttling: slow_3g, BlockImages: true");
  });
});
