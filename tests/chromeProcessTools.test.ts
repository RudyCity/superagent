import { describe, test, expect } from "vitest";
import {
  extractProfileDir,
  isChromeBrowserMain,
  isExactProfileMatch,
  parseWindowsScanResult,
  decodeTabTitles,
  applyProfileDisplayNames,
  formatBrowserBlock,
  listRunningChromeTool,
  closeChromeProfileTool,
  findWindowByHwnd,
  findWindowsByTitle,
  closeChromeWindowTool,
} from "../src/core/tools/chromeProcessTools.js";

const BROWSER = (dir: string) =>
  `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --profile-directory="${dir}"`;
const RENDERER = (dir: string) =>
  `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --type=renderer --profile-directory="${dir}"`;

describe("chromeProcessTools helpers", () => {
  test("extractProfileDir parses the quoted form", () => {
    expect(extractProfileDir(BROWSER("Profile 1"))).toBe("Profile 1");
  });

  test("extractProfileDir parses the bare form", () => {
    expect(
      extractProfileDir("/opt/google/chrome/chrome --profile-directory=Default")
    ).toBe("Default");
  });

  test("extractProfileDir returns null when the flag is absent", () => {
    expect(extractProfileDir(`"C:\\x\\chrome.exe" --no-first-run`)).toBeNull();
  });

  test("isChromeBrowserMain is true for a main browser process", () => {
    expect(isChromeBrowserMain(BROWSER("Profile 1"))).toBe(true);
  });

  test("isChromeBrowserMain is false for renderer/child processes", () => {
    expect(isChromeBrowserMain(RENDERER("Profile 1"))).toBe(false);
  });

  test("isChromeBrowserMain is false without the profile flag", () => {
    expect(isChromeBrowserMain(`"C:\\x\\chrome.exe" --no-first-run`)).toBe(false);
  });

  test('isExactProfileMatch: "Profile 1" never matches "Profile 10".."Profile 19"', () => {
    expect(isExactProfileMatch(BROWSER("Profile 1"), "Profile 1")).toBe(true);
    for (const d of ["Profile 10", "Profile 11", "Profile 19", "Profile 100"]) {
      expect(isExactProfileMatch(BROWSER(d), "Profile 1")).toBe(false);
    }
  });

  test("isExactProfileMatch is exact for bare directory names too", () => {
    expect(
      isExactProfileMatch("chrome --profile-directory=Default", "Default")
    ).toBe(true);
    expect(
      isExactProfileMatch("chrome --profile-directory=Default", "Defaul")
    ).toBe(false);
  });
});


const SCAN_FIXTURE = [
  {
    pid: 24204,
    commandLine: BROWSER("Profile 5"),
    startTime: "2026-10-04 08:26:26",
    windows: [
      {
        hwnd: 111111,
        title: "Chat - Muse - Google Chrome",
        tabs: ["Chat - Muse", "Gmail"],
        tabsAvailable: true,
      },
      {
        hwnd: 222222,
        title: "New Tab - Google Chrome",
        tabs: [],
        tabsAvailable: false,
      },
    ],
  },
  {
    pid: 4242,
    commandLine: BROWSER("Profile 1"),
    startTime: "2026-10-06 09:00:00",
    windows: [],
  },
  {
    pid: 777,
    commandLine: RENDERER("Profile 5"),
    startTime: "2026-10-04 08:26:30",
    windows: [],
  },
];

describe("parseWindowsScanResult", () => {
  test("lists every window per browser and skips renderers", () => {
    const out = parseWindowsScanResult(SCAN_FIXTURE);
    expect(out).toHaveLength(2);
    expect(out[0].pid).toBe(24204);
    expect(out[0].profileDir).toBe("Profile 5");
    expect(out[0].windows).toHaveLength(2);
    expect(out[0].windows[0].title).toBe("Chat - Muse - Google Chrome");
    expect(out[0].windows[0].tabs).toEqual(["Chat - Muse", "Gmail"]);
    expect(out[0].windows[0].tabsAvailable).toBe(true);
    expect(out[0].windows[1].tabsAvailable).toBe(false);
    expect(out[1].windows).toHaveLength(0);
  });

  test("wraps a single non-array object into an array", () => {
    const out = parseWindowsScanResult(SCAN_FIXTURE[0]);
    expect(out).toHaveLength(1);
    expect(out[0].pid).toBe(24204);
  });

  test("returns [] for empty, null, and garbage input", () => {
    expect(parseWindowsScanResult([])).toEqual([]);
    expect(parseWindowsScanResult(null)).toEqual([]);
    expect(parseWindowsScanResult("garbage")).toEqual([]);
    expect(parseWindowsScanResult([null, "x", {}])).toEqual([]);
  });
});

describe("applyProfileDisplayNames", () => {
  test("fills display names and falls back to directory on miss", () => {
    const browsers = parseWindowsScanResult(SCAN_FIXTURE);
    applyProfileDisplayNames(browsers, new Map([["Profile 5", "Work"]]));
    expect(browsers[0].profileName).toBe("Work");
    expect(browsers[1].profileName).toBe("Profile 1");
  });
});


describe("formatBrowserBlock", () => {
  test("shows display name, all windows, tabs, and unavailable marker", () => {
    const browsers = parseWindowsScanResult(SCAN_FIXTURE);
    applyProfileDisplayNames(browsers, new Map([["Profile 5", "Work"]]));
    const text = formatBrowserBlock(browsers[0]);
    expect(text).toContain('Profile 5 ("Work")');
    expect(text).toContain('Window: "Chat - Muse - Google Chrome"');
    expect(text).toContain('Window: "New Tab - Google Chrome"');
    expect(text).toContain('Tabs (2): "Chat - Muse" | "Gmail"');
    expect(text).toContain("Tabs: unavailable");
  });

  test("falls back to directory name when display name is missing", () => {
    const browsers = parseWindowsScanResult(SCAN_FIXTURE);
    const text = formatBrowserBlock(browsers[1]);
    expect(text).toContain("Profile: Profile 1 |");
    expect(text).toContain("(no visible windows enumerated)");
  });
});


describe("decodeTabTitles", () => {
  test("decodes base64 UTF-8 titles with quotes, emoji, and unicode intact", () => {
    const out = decodeTabTitles([
      "RWRpdCBMYW1hbiAiUXVvdGVkIiA8IFRpdGxlPg==",
      "RW1vamkg8J+agCB0YWI=",
      "UGxhaW4gdGl0bGU=",
    ]);
    expect(out).toEqual([
      'Edit Laman "Quoted" < Title>',
      "Emoji \uD83D\uDE80 tab",
      "Plain title",
    ]);
  });

  test("skips empty entries", () => {
    expect(decodeTabTitles(["", "UGxhaW4gdGl0bGU=", null])).toEqual(["Plain title"]);
  });
});

describe("closeChromeProfileTool safety", () => {
  test("rejects an empty profileName without touching any process", async () => {
    const res = await closeChromeProfileTool.execute(
      { profileName: "   " },
      process.cwd()
    );
    expect(res).toContain("must not be empty");
  });

  test("reports a clean no-match for a profile that cannot exist", async () => {
    const res = await closeChromeProfileTool.execute(
      { profileName: "No-Such-Profile-XYZ-123" },
      process.cwd()
    );
    expect(res).toContain("No running Chrome browser found");
    expect(res).toContain("Nothing was closed");
  });

  test("listRunningChromeTool returns a readable string", async () => {
    const res = await listRunningChromeTool.execute({}, process.cwd());
    expect(typeof res).toBe("string");
    expect(res.length).toBeGreaterThan(0);
  });
});

describe("close_chrome_window validation", () => {
  const mkWindow = (hwnd: number, title: string) => ({
    hwnd,
    title,
    tabs: [] as string[],
    tabsAvailable: false,
  });
  const browsers = [
    {
      pid: 1111,
      profileDir: "Default",
      profileName: "Default",
      startTime: "2026-10-06 10:00:00",
      windows: [
        mkWindow(1001, "Inbox - Google Chrome"),
        mkWindow(1002, "Calendar - Google Chrome"),
      ],
    },
    {
      pid: 2222,
      profileDir: "Profile 1",
      profileName: "Profile 1",
      startTime: "2026-10-06 10:05:00",
      windows: [mkWindow(2001, "Docs - Google Chrome")],
    },
  ];

  test("findWindowByHwnd returns the exact window", () => {
    const hit = findWindowByHwnd(browsers, 1002);
    expect(hit?.window.title).toBe("Calendar - Google Chrome");
    expect(hit?.browser.pid).toBe(1111);
  });

  test("findWindowByHwnd returns null for an unknown handle", () => {
    expect(findWindowByHwnd(browsers, 999999)).toBeNull();
  });

  test("findWindowsByTitle matches case-insensitively", () => {
    const hits = findWindowsByTitle(browsers, "inbox");
    expect(hits).toHaveLength(1);
    expect(hits[0].window.hwnd).toBe(1001);
  });

  test("findWindowsByTitle returns every ambiguous match", () => {
    const hits = findWindowsByTitle(browsers, "google chrome");
    expect(hits).toHaveLength(3);
  });

  test("findWindowsByTitle returns empty when nothing matches", () => {
    expect(findWindowsByTitle(browsers, "no-such-window-xyz")).toHaveLength(0);
  });

  test("closeChromeWindowTool rejects an invalid hwnd without scanning", async () => {
    const res = await closeChromeWindowTool.execute({ hwnd: 0 }, process.cwd());
    expect(res).toContain("Invalid hwnd");
  });

  test("closeChromeWindowTool rejects a non-integer hwnd without scanning", async () => {
    const res = await closeChromeWindowTool.execute({ hwnd: 1.5 }, process.cwd());
    expect(res).toContain("Invalid hwnd");
  });

  test("closeChromeWindowTool requires hwnd or titleSubstring", async () => {
    const res = await closeChromeWindowTool.execute({}, process.cwd());
    expect(res).toContain("Provide hwnd");
  });

  test("closeChromeWindowTool refuses an unknown hwnd without closing anything", async () => {
    const res = await closeChromeWindowTool.execute(
      { hwnd: 999999999 },
      process.cwd()
    );
    expect(res).toContain("No scanned Chrome window has HWND");
    expect(res).toContain("Nothing was closed");
  });

  test("closeChromeWindowTool refuses an ambiguous title without closing anything", async () => {
    const res = await closeChromeWindowTool.execute(
      { titleSubstring: "Google Chrome" },
      process.cwd()
    );
    expect(res).toMatch(
      /matched \d+ windows -- refusing to guess|No Chrome window title matches/
    );
    expect(res).toContain("Nothing was closed");
  });
});


