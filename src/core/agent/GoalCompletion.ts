// Only standalone status markers outside Markdown code fences affect goal completion.
export function isGoalCompleteResponse(text: string): boolean {
  let fence = "";
  let complete = false;
  for (const line of text.split(/\r?\n/)) {
    const delimiter = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (delimiter && delimiter[1][0] === fence[0]
        && delimiter[1].length >= fence.length && !delimiter[2].trim()) {
        fence = "";
      }
      continue;
    }
    if (delimiter) {
      fence = delimiter[1];
      continue;
    }
    if (/^\s*GOAL_PARTIAL\s*:/i.test(line)) return false;
    if (/^\s*GOAL_COMPLETE\s*:/i.test(line)) complete = true;
  }
  return complete;
}
