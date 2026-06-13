import fs from "fs/promises";

export interface ChecklistTask {
  status: string;
  text: string;
}

export interface ReadChecklistResult {
  tasks: ChecklistTask[];
  missing: boolean;
}

export function parseChecklistTasks(content: string): ChecklistTask[] {
  const lines = content.split(/\r?\n/);
  const items: ChecklistTask[] = [];

  for (const line of lines) {
    const match =
      line.match(/^\s*-\s*`\[([xX/ ])\]`?\s*(.*)$/) ||
      line.match(/^\s*-\s*\[([xX/ ])\]\s*(.*)$/);
    if (match) {
      items.push({
        status: match[1].toLowerCase(),
        text: match[2].trim(),
      });
    }
  }

  return items;
}

export async function readChecklistTasks(taskPath: string): Promise<ReadChecklistResult> {
  try {
    const content = await fs.readFile(taskPath, "utf-8");
    return { tasks: parseChecklistTasks(content), missing: false };
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return { tasks: [], missing: true };
    }
    throw err;
  }
}
