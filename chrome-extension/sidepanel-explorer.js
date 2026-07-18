// Workspace File Explorer module for Superagent Chrome Extension

document.addEventListener("DOMContentLoaded", () => {
  const rightPanel = document.getElementById("right-side-panel");
  if (!rightPanel) return;

  // Poll workspace files every 5 seconds
  setInterval(pollWorkspaceFiles, 5000);
  pollWorkspaceFiles();
});

async function pollWorkspaceFiles() {
  const rightPanel = document.getElementById("right-side-panel");
  if (!rightPanel || rightPanel.classList.contains("hidden")) return;

  await updateWorkspaceFiles();
}

function getExplorerBaseUrl() {
  return typeof BASE_URL !== "undefined" ? BASE_URL : "http://localhost:7888";
}

// Fetch and render workspace files
async function updateWorkspaceFiles() {
  const container = document.getElementById("workspace-files-container");
  if (!container) return;

  try {
    const baseUrl = getExplorerBaseUrl();
    const res = await fetch(`${baseUrl}/api/workspace/files`);
    if (!res.ok) return;
    const data = await res.json();

    if (data.success && Array.isArray(data.files)) {
      const files = data.files;
      if (files.length === 0) {
        container.innerHTML = '<div class="p-3 text-center text-vscode-muted text-[11px] italic">No files in workspace</div>';
        return;
      }

      // Limit file tree rendering to prevent lag on huge projects
      const limit = window.maxExplorerFiles || 500;
      let filesToRender = files;
      let limitReached = false;
      if (files.length > limit) {
        filesToRender = files.slice(0, limit);
        limitReached = true;
      }

      // Build nested directory tree
      const tree = {};
      filesToRender.forEach(f => {
        const parts = f.split(/[/\\]/);
        let curr = tree;
        parts.forEach((part, index) => {
          if (!curr[part]) {
            curr[part] = {
              name: part,
              path: parts.slice(0, index + 1).join("/"),
              isDir: index < parts.length - 1,
              children: {}
            };
          }
          curr = curr[part].children;
        });
      });

      container.innerHTML = "";
      renderTreeNodes(tree, container);

      if (limitReached) {
        const warning = document.createElement("div");
        warning.className = "p-2 mt-2 text-center text-vscode-muted text-[9.5px] italic border-t border-vscode-dim bg-vscode-inner/30 rounded-sm select-none";
        warning.textContent = `Showing first ${limit} files (${files.length} total). Adjust limit in settings.`;
        container.appendChild(warning);
      }
    }
  } catch (err) {
    console.error("Failed to update workspace files:", err);
  }
}

// Recursive Tree Node Renderer
function renderTreeNodes(nodes, container, depth = 0) {
  const sorted = Object.values(nodes).sort((a, b) => {
    if (a.isDir && !b.isDir) return -1;
    if (!a.isDir && b.isDir) return 1;
    return a.name.localeCompare(b.name);
  });

  sorted.forEach(node => {
    const row = document.createElement("div");
    row.style.paddingLeft = `${depth * 10 + 6}px`;
    row.className = "explorer-node flex items-center gap-1.5 py-1 px-1.5 rounded-sm hover:bg-vscode-hover text-[11px] cursor-pointer font-sans select-none";

    const label = document.createElement("span");
    label.className = "truncate flex-1 font-mono text-vscode-light";

    if (node.isDir) {
      row.classList.add("directory-node");
      const icon = document.createElement("span");
      icon.className = "dir-icon text-vscode-muted text-[10px]";
      icon.textContent = "📁";
      row.appendChild(icon);
      
      label.textContent = node.name;
      row.appendChild(label);

      // Child container for sub-directories/files
      const childContainer = document.createElement("div");
      childContainer.className = "dir-children hidden";
      
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        const isHidden = childContainer.classList.contains("hidden");
        childContainer.classList.toggle("hidden", !isHidden);
        icon.textContent = isHidden ? "📂" : "📁";
      });

      container.appendChild(row);
      renderTreeNodes(node.children, childContainer, depth + 1);
      container.appendChild(childContainer);
    } else {
      row.classList.add("file-node");
      const icon = document.createElement("span");
      icon.className = "file-icon text-vscode-muted text-[10px]";
      icon.textContent = "📄";
      row.appendChild(icon);

      label.textContent = node.name;
      row.appendChild(label);

      row.addEventListener("click", async (e) => {
        e.stopPropagation();
        await attachWorkspaceFile(node.path);
      });

      container.appendChild(row);
    }
  });
}

// Click to attach workspace file directly as document
async function attachWorkspaceFile(path) {
  try {
    const baseUrl = getExplorerBaseUrl();
    const res = await fetch(`${baseUrl}/api/workspace/file/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filepath: path })
    });
    if (!res.ok) return;
    const data = await res.json();

    if (data.success && typeof data.content === "string") {
      // Check if already attached
      const isAttached = attachedFiles.some(f => f.name === path);
      if (isAttached) {
        alert(`File ${path} is already attached.`);
        return;
      }

      attachedFiles.push({
        name: path,
        type: "document",
        content: data.content
      });
      if (typeof renderAttachmentPreviews === "function") {
        renderAttachmentPreviews();
      }
    }
  } catch (err) {
    console.error("Failed to attach file:", err);
  }
}
