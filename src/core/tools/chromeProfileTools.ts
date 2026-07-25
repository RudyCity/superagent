import fs from "fs/promises";
import path from "path";
import os from "os";
import { Tool } from "./types.js";

export interface ChromeProfileInfo {
  id: string;
  name: string;
  directoryName: string;
  path: string;
  email?: string;
  isGSuite?: boolean;
  avatarIcon?: string;
}

export function getChromeUserDataPath(): string {
  const home = os.homedir();
  const platform = os.platform();

  if (platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    return path.join(localAppData, "Google", "Chrome", "User Data");
  } else if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Google", "Chrome");
  } else {
    return path.join(home, ".config", "google-chrome");
  }
}

export async function detectChromeProfiles(customUserDataPath?: string): Promise<ChromeProfileInfo[]> {
  const userDataPath = customUserDataPath || getChromeUserDataPath();
  const profiles: ChromeProfileInfo[] = [];

  const localStatePath = path.join(userDataPath, "Local State");

  try {
    const content = await fs.readFile(localStatePath, "utf-8");
    const localState = JSON.parse(content);
    const infoCache = localState?.profile?.info_cache;

    if (infoCache && typeof infoCache === "object") {
      for (const [dirName, profileData] of Object.entries<any>(infoCache)) {
        profiles.push({
          id: dirName,
          name: profileData.name || dirName,
          directoryName: dirName,
          path: path.join(userDataPath, dirName),
          email: profileData.user_name || profileData.user_email || undefined,
          isGSuite: Boolean(profileData.is_using_default_name === false && profileData.hosted_domain),
          avatarIcon: profileData.avatar_icon || undefined,
        });
      }
    }
  } catch {
    // Fallback to directory scanning if Local State is unavailable or corrupted
    try {
      const entries = await fs.readdir(userDataPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && (entry.name === "Default" || entry.name.startsWith("Profile "))) {
          profiles.push({
            id: entry.name,
            name: entry.name,
            directoryName: entry.name,
            path: path.join(userDataPath, entry.name),
          });
        }
      }
    } catch {
      // User data directory non-existent or inaccessible
    }
  }

  return profiles;
}

export const listChromeProfilesTool: Tool = {
  name: "list_chrome_profiles",
  description: "Detect and list all local Google Chrome profiles installed on the system (Windows, macOS, Linux) with directory paths and user accounts.",
  parameters: {
    type: "object",
    properties: {
      customUserDataPath: {
        type: "string",
        description: "Optional custom Chrome User Data directory path to inspect.",
      },
    },
  },
  execute: async ({ customUserDataPath }: { customUserDataPath?: string }) => {
    const userDataPath = customUserDataPath || getChromeUserDataPath();
    const profiles = await detectChromeProfiles(userDataPath);

    if (profiles.length === 0) {
      return `No Chrome profiles detected in User Data directory: \`${userDataPath}\`. Ensure Google Chrome is installed on this system.`;
    }

    const lines: string[] = [
      `### Chrome Profiles Found (${profiles.length})`,
      `**User Data Path**: \`${userDataPath}\`\n`,
      `| Directory | Profile Name | User / Email | Full Path |`,
      `| --- | --- | --- | --- |`,
    ];

    for (const p of profiles) {
      const email = p.email ? `\`${p.email}\`` : "—";
      lines.push(`| \`${p.directoryName}\` | **${p.name}** | ${email} | \`${p.path}\` |`);
    }

    lines.push("\n*To launch Chrome with a specific profile on Windows:*");
    lines.push(`\`\`\`cmd\nstart chrome --profile-directory="${profiles[0]?.directoryName || "Default"}"\n\`\`\``);

    return lines.join("\n");
  },
};
