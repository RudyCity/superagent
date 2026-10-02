import fs from "fs";
import path from "path";
import os from "os";
import { execa } from "execa";
import { getPackageRootDir } from "../config/paths.js";
import { addTrustedDirectory } from "../config/trustedDirs.js";

export function getDefaultProjectDir(projectName: string): string {
  const home = os.homedir();
  const docsDir = path.join(home, "Documents");
  const lowercaseDocsDir = path.join(home, "documents");
  const baseDocs = fs.existsSync(docsDir)
    ? docsDir
    : fs.existsSync(lowercaseDocsDir)
    ? lowercaseDocsDir
    : docsDir;

  return path.join(baseDocs, "superagent", projectName.trim());
}

export type ProjectTemplate = "empty" | "minimal" | "superagent";

export interface InstantProjectOptions {
  projectName: string;
  targetDir?: string;
  templateSourceDir?: string;
  force?: boolean;
  initGit?: boolean;
  description?: string;
  template?: ProjectTemplate;
}

export interface InstantProjectResult {
  success: boolean;
  targetDir: string;
  projectName: string;
  template: ProjectTemplate;
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

  const template = options.template || "empty";
  const targetDir = path.resolve(
    options.targetDir || getDefaultProjectDir(trimmedName)
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

  if (template === "superagent") {
    const sourceDir = path.resolve(options.templateSourceDir || getPackageRootDir());
    if (!fs.existsSync(sourceDir)) {
      throw new Error(`Base template source directory not found: ${sourceDir}`);
    }

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
  } else if (template === "minimal") {
    // Minimal TypeScript project template
    const srcDir = path.join(targetDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });

    const indexTs = `export function main(): void {\n  console.log("Welcome to ${trimmedName}!");\n}\n\nmain();\n`;
    fs.writeFileSync(path.join(srcDir, "index.ts"), indexTs, "utf-8");

    const tsconfig = {
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        esModuleInterop: true,
        strict: true,
        skipLibCheck: true,
        outDir: "dist",
        rootDir: "src",
      },
      include: ["src/**/*"],
    };
    fs.writeFileSync(
      path.join(targetDir, "tsconfig.json"),
      JSON.stringify(tsconfig, null, 2),
      "utf-8"
    );

    const pkg = {
      name: trimmedName,
      version: "1.0.0",
      description: options.description || `Instant TypeScript project ${trimmedName}`,
      type: "module",
      main: "dist/index.js",
      scripts: {
        build: "tsc",
        start: "node dist/index.js",
        test: 'echo "No test specified" && exit 0',
      },
    };
    fs.writeFileSync(
      path.join(targetDir, "package.json"),
      JSON.stringify(pkg, null, 2),
      "utf-8"
    );

    const readme = `# ${trimmedName}\n\n${options.description || "Minimal TypeScript project workspace created with Superagent."}\n\n## Getting Started\n\n\`\`\`bash\nnpm install\nnpm run build\nnpm start\n\`\`\`\n`;
    fs.writeFileSync(path.join(targetDir, "README.md"), readme, "utf-8");

    const gitignore = `node_modules/\ndist/\n.env\n.DS_Store\n*.log\n`;
    fs.writeFileSync(path.join(targetDir, ".gitignore"), gitignore, "utf-8");

    const agentsMd = `# Project Specifications (${trimmedName})\n\n## Project Overview\n- **Name**: ${trimmedName}\n- **Description**: ${options.description || "Minimal TypeScript project workspace created with Superagent."}\n`;
    fs.writeFileSync(path.join(targetDir, "AGENTS.md"), agentsMd, "utf-8");
  } else {
    // Clean Empty Project (default): no superagent internals copied
    const srcDir = path.join(targetDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });

    const indexJs = `// ${trimmedName}\nconsole.log("Welcome to ${trimmedName}!");\n`;
    fs.writeFileSync(path.join(srcDir, "index.js"), indexJs, "utf-8");

    const pkg = {
      name: trimmedName,
      version: "1.0.0",
      description: options.description || `Instant project ${trimmedName}`,
      type: "module",
      main: "src/index.js",
      scripts: {
        start: "node src/index.js",
        test: 'echo "Error: no test specified" && exit 1',
      },
    };
    fs.writeFileSync(
      path.join(targetDir, "package.json"),
      JSON.stringify(pkg, null, 2),
      "utf-8"
    );

    const readme = `# ${trimmedName}\n\n${options.description || "Instant empty project workspace created with Superagent."}\n`;
    fs.writeFileSync(path.join(targetDir, "README.md"), readme, "utf-8");

    const gitignore = `node_modules/\ndist/\n.env\n.DS_Store\n*.log\n`;
    fs.writeFileSync(path.join(targetDir, ".gitignore"), gitignore, "utf-8");

    const agentsMd = `# Project Specifications (${trimmedName})\n\n## Project Overview\n- **Name**: ${trimmedName}\n- **Description**: ${options.description || "Instant empty project workspace created with Superagent."}\n`;
    fs.writeFileSync(path.join(targetDir, "AGENTS.md"), agentsMd, "utf-8");
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

  const templateLabel =
    template === "empty"
      ? "empty project"
      : template === "minimal"
      ? "minimal TypeScript project"
      : "Superagent base project";

  return {
    success: true,
    targetDir,
    projectName: trimmedName,
    template,
    message: `Instant project '${trimmedName}' (${templateLabel}) successfully created at ${targetDir}`,
  };
}
