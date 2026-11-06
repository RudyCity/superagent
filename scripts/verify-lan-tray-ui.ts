#!/usr/bin/env bun
/** Browser-only layout smoke for the static Tray view (not native Tauri E2E). */
import { chromium } from "playwright-core";
import { pathToFileURL } from "node:url";
import path from "node:path";
const browser = await chromium.launch({
  headless: true,
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  args: ["--no-first-run", "--disable-extensions", "--disable-background-networking"],
});
try {
  const url = pathToFileURL(path.resolve("apps/superagent-tray/ui/index.html")).href + "#lan-devices";
  for (const width of [1280, 850, 760]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto(url);
    await page.waitForTimeout(150);
    const info = await page.evaluate(() => {
      const shown = document.getElementById("page-lan-devices");
      const nav = document.getElementById("nav-lan-devices");
      const rect = shown?.getBoundingClientRect();
      return {
        pageVisible: Boolean(shown && !shown.hidden && rect && rect.height > 50),
        navSelected: nav?.classList.contains("active") === true,
        title: document.getElementById("top-title")?.textContent,
        pairingVisible: Boolean(document.getElementById("lan-pair-form")?.getBoundingClientRect().height),
        commandDisabled: (document.getElementById("lan-command") as HTMLInputElement)?.disabled === true,
        bodyOverflows: document.documentElement.scrollWidth > window.innerWidth + 1,
      };
    });
    if (!info.pageVisible || !info.navSelected || info.title !== "LAN Devices" ||
        !info.pairingVisible || !info.commandDisabled || info.bodyOverflows) {
      throw Error("Tray LAN page smoke failed at viewport " + width + ": " + JSON.stringify(info));
    }
    console.log("TRAY_LAN_UI_PASS", width, JSON.stringify(info));
    await page.close();
  }
} finally { await browser.close(); }
