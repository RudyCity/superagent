import fs from "fs";
import path from "path";

export interface ContextNode {
  path: string;
  type: "file" | "directory";
  dependencies: string[];
  tasks: string[];
  status: "unchanged" | "modified" | "created" | "deleted";
}

export class ContextGraph {
  private nodes: Map<string, ContextNode> = new Map();
  private rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  /**
   * Scan files and build a local structure of components and tasks.
   */
  public async buildGraph(
    changedFiles: string[] = [],
    tasks: string[] = []
  ): Promise<void> {
    this.nodes.clear();

    // Map changed files
    for (const file of changedFiles) {
      const fullPath = path.resolve(this.rootDir, file);
      const isDir = fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory();
      
      const node: ContextNode = {
        path: file,
        type: isDir ? "directory" : "file",
        dependencies: this.detectImports(fullPath),
        tasks: tasks.filter(t => t.includes(path.basename(file))),
        status: "modified",
      };
      this.nodes.set(file, node);
    }
  }

  /**
   * Helper to identify dependencies using simple import statement parsing.
   */
  private detectImports(filePath: string): string[] {
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      return [];
    }

    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const importRegex = /import\s+.*?\s+from\s+['"](.*?)['"]/g;
      const deps: string[] = [];
      let match;
      while ((match = importRegex.exec(content)) !== null) {
        deps.push(match[1]);
      }
      return deps;
    } catch {
      return [];
    }
  }

  /**
   * Compile the graph structure into a token-efficient markdown format for prompts.
   */
  public compileSummary(): string {
    if (this.nodes.size === 0) {
      return "";
    }

    const lines: string[] = ["\n# ACTIVE WORKSPACE CONTEXT GRAPH"];
    for (const [filePath, node] of this.nodes.entries()) {
      lines.push(`- Component: [${node.path}] (${node.type}) [Status: ${node.status}]`);
      if (node.dependencies.length > 0) {
        lines.push(`  - Dependencies: ${node.dependencies.join(", ")}`);
      }
      if (node.tasks.length > 0) {
        lines.push(`  - Associated Tasks:`);
        for (const t of node.tasks) {
          lines.push(`    - ${t}`);
        }
      }
    }
    return lines.join("\n") + "\n";
  }
}
