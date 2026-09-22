import fs from "fs";
import path from "path";
import { execa } from "execa";
import { getPackageRootDir } from "../config/paths.js";
import { addTrustedDirectory } from "../config/trustedDirs.js";

export interface InstantProjectOptions {
  projectName: string;
  targetDir?: string;
  templateSourceDir?: string;
  force?: boolean;
  initGit?: boolean;
  description?: string;
}

export interface InstantProjectResult {
  success: boolean;
  targetDir: string;
  projectName: string;
  message: string;
}

const INCLUDED_DIRS = [
  "src",
  "assets",
  "scripts",
  "internal-hooks",
  ".agents",
  "chrome-extension",
  "chrome-extension-remote",
  "docs",
];

const INCLUDED_FILES = [
  "package.json",
  "tsconfig.json",
  "vitest.config.ts",
  "bunfig.toml",
  ".gitignore",
  ".env.example",
  "README.md",
  "AGENTS.md",
  "LICENSE",
];

function copyDirRecursive(source: string, destination: string): void {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(destination, { recursive: true });

  const entries = fs.readdirSync(source, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(source, entry.name);
    const destPath = path.join(destination, entry.name);

    if (entry.name.startsWith("temp-home-") || entry.name.endsWith(".log") || entry.name.endsWith(".diff")) {
      continue;
    }
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") {
      continue;
    }

    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

export async function createInstantProject(
  options: InstantProjectOptions
): Promise<InstantProjectResult> {
  const trimmedName = options.projectName.trim();
  if (!trimmedName) {
    throw new Error("Project name cannot be empty.");
  }

  const sourceDir = path.resolve(options.templateSourceDir || getPackageRootDir());
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Base template source directory not found: ${sourceDir}`);
  }

  const targetDir = path.resolve(
    options.targetDir || path.resolve(process.cwd(), "..", trimmedName)
  );

  if (fs.existsSync(targetDir)) {
    const contents = fs.readdirSync(targetDir);
    if (contents.length > 0 && !options.force) {
      throw new Error(
        `Target directory '${targetDir}' already exists and is not empty. Use force option to overwrite.`
      );
    }
  }

  fs.mkdirSync(targetDir, { recursive: true });

  // Copy curated top-level directories
  for (const dirName of INCLUDED_DIRS) {
    const srcDirPath = path.join(sourceDir, dirName);
    const destDirPath = path.join(targetDir, dirName);
    if (fs.existsSync(srcDirPath)) {
      copyDirRecursive(srcDirPath, destDirPath);
    }
  }

  // Copy tests directory with temp folder filter
  const srcTestsDir = path.join(sourceDir, "tests");
  if (fs.existsSync(srcTestsDir)) {
    copyDirRecursive(srcTestsDir, path.join(targetDir, "tests"));
  }

  // Copy curated top-level files
  for (const fileName of INCLUDED_FILES) {
    const srcFilePath = path.join(sourceDir, fileName);
    const destFilePath = path.join(targetDir, fileName);
    if (fs.existsSync(srcFilePath)) {
      fs.copyFileSync(srcFilePath, destFilePath);
    }
  }

  // Personalize package.json
  const pkgPath = path.join(targetDir, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const rawPkg = fs.readFileSync(pkgPath, "utf-8");
      const pkg = JSON.parse(rawPkg);
      pkg.name = trimmedName;
      pkg.version = "1.0.0";
      pkg.description =
        options.description ||
        `Instant AI assistant project generated from Superagent`;
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), "utf-8");
    } catch {}
  }

  // Personalize AGENTS.md if present
  const agentsPath = path.join(targetDir, "AGENTS.md");
  if (fs.existsSync(agentsPath)) {
    try {
      let agentsContent = fs.readFileSync(agentsPath, "utf-8");
      agentsContent = agentsContent.replace(
        /# Project Specifications \(.*?\)/,
        `# Project Specifications (${trimmedName})`
      );
      agentsContent = agentsContent.replace(
        /- \*\*Name\*\*: .*/,
        `- **Name**: ${trimmedName}`
      );
      fs.writeFileSync(agentsPath, agentsContent, "utf-8");
    } catch {}
  }

  // Initialize Git repository if requested
  if (options.initGit !== false) {
    try {
      await execa("git", ["init"], { cwd: targetDir, reject: false });
    } catch {}
  }

  // Register in trusted directories
  try {
    addTrustedDirectory(targetDir, trimmedName);
  } catch {}

  return {
    success: true,
    targetDir,
    projectName: trimmedName,
    message: `Instant project '${trimmedName}' successfully created at ${targetDir}`,
  };
}
