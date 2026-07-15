// Vision Panel — Integrates UI-DETR-1 detection results into sidebar
// Relies on global BASE_URL and apiToken from sidepanel.js

function initVisionPanel() {
  const detectBtn = document.getElementById("btn-vision-detect");
  const clearBtn = document.getElementById("btn-vision-clear");
  const thresholdSlider = document.getElementById("vision-threshold");
  const thresholdVal = document.getElementById("vision-threshold-val");
  const canvas = document.getElementById("vision-canvas");
  const emptyScreenshot = document.getElementById("vision-screenshot-empty");
  const elementsList = document.getElementById("vision-elements-list");
  const elementsEmpty = document.getElementById("vision-elements-empty");
  const navBadge = document.getElementById("vision-nav-badge");

  const LABEL_COLORS = {
    button: "#4285F4", input: "#34A853", select: "#FBBC05",
    checkbox: "#EA4335", link: "#9C27B0", text: "#00BCD4",
    image: "#FF5722", default: "#607D8B"
  };

  if (!detectBtn || !clearBtn || !thresholdSlider || !thresholdVal || !canvas) {
    console.error("[Vision Panel] Required elements not found in HTML");
    return;
  }

  thresholdSlider.addEventListener("input", () => {
    thresholdVal.textContent = (thresholdSlider.value / 100).toFixed(2);
  });

  let lastElements = [];

  detectBtn.addEventListener("click", async () => {
    detectBtn.disabled = true;
    detectBtn.textContent = "Detecting...";
    if (navBadge) navBadge.classList.add("hidden");

    try {
      const threshold = thresholdSlider.value / 100;
      const headers = {
        "Content-Type": "application/json"
      };
      if (typeof apiToken !== "undefined" && apiToken) {
        headers["Authorization"] = `Bearer ${apiToken}`;
      }

      const res = await fetch(`${BASE_URL}/api/browser/detect-ui`, {
        method: "POST",
        headers: headers,
        body: JSON.stringify({ threshold })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      
      lastElements = data.elements || [];
      renderDetections(data.screenshotBase64, lastElements);
    } catch (err) {
      elementsList.innerHTML = `<div class="p-2.5 text-[11px] text-red-error-light bg-red-error/10 border border-red-error/20 rounded-sm">Error: ${err.message}</div>`;
    } finally {
      detectBtn.disabled = false;
      detectBtn.textContent = "Detect";
    }
  });

  clearBtn.addEventListener("click", () => {
    lastElements = [];
    canvas.classList.add("hidden");
    emptyScreenshot.classList.remove("hidden");
    if (elementsEmpty) {
      elementsEmpty.classList.remove("hidden");
      elementsList.innerHTML = "";
      elementsList.appendChild(elementsEmpty);
    } else {
      elementsList.innerHTML = `<div class="p-3 text-center text-vscode-muted text-[11px]">Run detection to see elements</div>`;
    }
    if (navBadge) navBadge.classList.add("hidden");
    
    // Hide overlay in browser too
    if (typeof executeBrowserControl === "function") {
      executeBrowserControl("vision-manual", "hide_detections", "overlay", "");
    }
  });

  function renderDetections(screenshotBase64, elements) {
    // Draw screenshot + bounding boxes on canvas
    if (screenshotBase64) {
      const img = new Image();
      img.onload = () => {
        const containerW = canvas.parentElement.clientWidth || 200;
        const scale = containerW / img.width;
        canvas.width = img.width;
        canvas.height = img.height;
        canvas.style.width = "100%";
        canvas.style.height = Math.round(img.height * scale) + "px";
        canvas.classList.remove("hidden");
        emptyScreenshot.classList.add("hidden");

        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);

        elements.forEach(el => {
          const [x1, y1, x2, y2] = el.box;
          const color = LABEL_COLORS[el.label] || LABEL_COLORS.default;
          ctx.strokeStyle = color;
          ctx.lineWidth = 3;
          ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
          
          // Draw label background
          ctx.fillStyle = color;
          ctx.font = "bold 14px monospace";
          const labelText = `${el.label} ${Math.round(el.score * 100)}%`;
          const textWidth = ctx.measureText(labelText).width;
          ctx.fillRect(x1, y1 - 20, textWidth + 8, 20);
          
          // Draw label text
          ctx.fillStyle = "white";
          ctx.fillText(labelText, x1 + 4, y1 - 5);
        });
      };
      img.src = "data:image/png;base64," + screenshotBase64;
    }

    // Render element list
    elementsList.innerHTML = "";
    if (elements.length === 0) {
      if (elementsEmpty) {
        elementsList.appendChild(elementsEmpty);
        elementsEmpty.classList.remove("hidden");
      } else {
        elementsList.innerHTML = `<div class="p-3 text-center text-vscode-muted text-[11px]">Run detection to see elements</div>`;
      }
      return;
    }

    elements.forEach((el) => {
      const [cx, cy] = el.center;
      const color = LABEL_COLORS[el.label] || LABEL_COLORS.default;
      const item = document.createElement("div");
      item.className = "vision-element-item p-1.5 flex items-center justify-between gap-2 border border-vscode-dim rounded-sm bg-vscode-inner hover:border-vscode-bright transition-colors cursor-pointer";
      
      const labelContainer = document.createElement("div");
      labelContainer.className = "flex items-center gap-1.5 overflow-hidden";
      labelContainer.innerHTML = `
        <span class="w-2 h-2 rounded-full shrink-0" style="background:${color};"></span>
        <span class="text-[11px] font-semibold text-vscode-light capitalize truncate">${el.label}</span>
      `;
      
      const actionsContainer = document.createElement("div");
      actionsContainer.className = "flex items-center gap-1.5 shrink-0";
      actionsContainer.innerHTML = `
        <span class="text-[10px] font-mono text-vscode-muted">${cx},${cy}</span>
        <button class="btn btn-secondary text-[9px] px-1.5 py-0.5 cursor-pointer h-4.5 font-medium bg-vscode-sidebar border border-vscode-dim rounded-sm hover:bg-vscode-hover hover:text-white" title="Click coordinate">Click</button>
      `;

      actionsContainer.querySelector("button").addEventListener("click", async (e) => {
        e.stopPropagation();
        if (typeof executeBrowserControl === "function") {
          executeBrowserControl("vision-manual", "click", `${cx},${cy}`, "");
        }
      });

      item.appendChild(labelContainer);
      item.appendChild(actionsContainer);
      elementsList.appendChild(item);
    });
  }
}
