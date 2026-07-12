function formatMarkdown(text) {
  if (!text) return "";
  
  const lines = text.split("\n");
  const formattedLines = lines.map(line => {
    const trimmed = line.trim();
    
    // Pattern A: Edited [type] [file] +[added] -[removed]
    // e.g. "Edited ts `otherTools.ts` +8 -8" or "Edited ts otherTools.ts +8 -8"
    const editMatch = trimmed.match(/^Edited\s+([^\s]+)\s+`?([a-zA-Z0-9_\-\.\/]+)`?\s+\+(\d+)\s+-(\d+)/i);
    if (editMatch) {
      const type = editMatch[1];
      const file = editMatch[2];
      const added = editMatch[3];
      const removed = editMatch[4];
      return `<div class="log-row log-edit">
        <span class="log-prefix">Edited</span>
        <span class="badge badge-filetype badge-${type.toLowerCase().replace(/[^a-z0-9]/g, '')}">${type}</span>
        <span class="log-filename">${file}</span>
        <span class="log-stat log-stat-added">+${added}</span>
        <span class="log-stat log-stat-removed">-${removed}</span>
      </div>`;
    }
    
    // Pattern B: Explored [count] file[s] >
    const exploreMatch = trimmed.match(/^Explored\s+(\d+)\s+files?\s*>?/i);
    if (exploreMatch) {
      const count = exploreMatch[1];
      return `<div class="log-row log-explore">
        <span class="log-explore-text">Explored ${count} file${count > 1 ? 's' : ''}</span>
        <span class="log-chevron">&gt;</span>
      </div>`;
    }
    
    // Pattern C: Ran [command] >
    const runMatch = trimmed.match(/^Ran\s+([^>]+)\s*>?/i);
    if (runMatch) {
      const command = runMatch[1].trim();
      return `<div class="log-row log-run">
        <span class="log-prefix">Ran</span>
        <code class="log-command">${command}</code>
        <span class="log-chevron">&gt;</span>
      </div>`;
    }
    
    // Pattern D: [count] files changed +[added]-[removed] >
    const summaryMatch = trimmed.match(/^(\d+)\s+files?\s+changed\s+\+(\d+)\s*-(\d+)\s*>?/i);
    if (summaryMatch) {
      const count = summaryMatch[1];
      const added = summaryMatch[2];
      const removed = summaryMatch[3];
      return `<div class="log-row log-summary">
        <span class="log-summary-text">${count} file${count > 1 ? 's' : ''} changed</span>
        <span class="log-stat log-stat-added">+${added}</span>
        <span class="log-stat log-stat-removed">-${removed}</span>
        <span class="log-chevron">&gt;</span>
      </div>`;
    }
    
    // Pattern E: Worked for [duration] v
    const workedMatch = trimmed.match(/^Worked\s+for\s+([^\s]+)\s*(?:v|▼)?/i);
    if (workedMatch) {
      const duration = workedMatch[1];
      return `<div class="log-row log-worked">
        <span class="log-worked-text">Worked for ${duration}</span>
        <span class="log-chevron">▼</span>
      </div>`;
    }
    
    // Pattern F: Run build and tests finished
    const finishedMatch = trimmed.match(/^Run\s+build\s+and\s+tests?\s+finished/i);
    if (finishedMatch) {
      return `<div class="log-row log-finished">
        <span class="log-finished-text">Run build and tests finished</span>
      </div>`;
    }
    
    // Regular markdown formatting for lines that don't match special patterns
    let escaped = line
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    
    escaped = escaped.replace(/`([^`]+)`/g, (match, code) => {
      const isShell = /\b(bash|run_command|execute|shell|terminal|npm|git|build|test)\b/i.test(code);
      const extraClass = isShell ? " md-code-shell" : "";
      return `<code class="md-code${extraClass}">${code}</code>`;
    });
    
    escaped = escaped.replace(/\*\*([^*]+)\*\*/g, (match, content) => {
      const isShellText = /\b(shell|build|terminal|run|execution)\b/i.test(content);
      const extraClass = isShellText ? " md-bold-shell" : "";
      return `<strong class="md-bold${extraClass}">${content}</strong>`;
    });

    // Convert raw file paths to clickable links
    escaped = escaped.replace(/(?<![("'/=\/\\\[])\b([a-zA-Z0-9_\-\.\/\\\\]+\.(?:ts|js|tsx|jsx|html|css|json|md|py|go|rs|sh|bat|yml|yaml|txt|log|cpp|c|h))\b/g, '<a href="file:///$1" class="text-vscode-bright hover:underline">$1</a>');

    // Support links
    escaped = escaped.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" class="text-vscode-bright hover:underline">$1</a>');

    // Support list items
    const listMatch = escaped.match(/^\s*-\s+(.+)$/);
    if (listMatch) {
      escaped = `<li>${listMatch[1]}</li>`;
    }
    
    return escaped;
  });
  
  return formattedLines.join("\n");
}
