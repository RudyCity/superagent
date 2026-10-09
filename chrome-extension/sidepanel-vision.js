// Vision Panel — Integrates UI-DETR-1 detection results into sidebar
// Relies on global BASE_URL and apiToken from sidepanel.js

function initVisionPanel() {
  const detectBtn = document.getElementById("btn-vision-detect");
  const clearBtn = document.getElementById("btn-vision-clear");
  const thresholdSlider = document.getElementById("vision-threshold");
  const thresholdVal = document.getElementById("vision-threshold-val");
  const canvas = document.getElementById("vision-canvas");
  const emptyScreenshot = document.getElementById("vision-screenshot-empty");
  const canvasHint = document.getElementById("vision-canvas-hint");
  const elementsList = document.getElementById("vision-elements-list");
  const elementsEmpty = document.getElementById("vision-elements-empty");
  const navBadge = document.getElementById("vision-nav-badge");
  const filterBtns = document.querySelectorAll(".vision-filter-btn");

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
  let currentScreenshotBase64 = "";
  let activeFilter = "all";

  // Filter buttons handler
  filterBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      filterBtns.forEach((b) => {
        b.classList.remove("bg-vscode-blue", "text-white");
        b.classList.add("bg-vscode-inner", "text-vscode-muted");
      });
      btn.classList.remove("bg-vscode-inner", "text-vscode-muted");
      btn.classList.add("bg-vscode-blue", "text-white");

      activeFilter = btn.getAttribute("data-filter") || "all";
      applyFilterAndRender();
    });
  });

  function getFilteredElements() {
    if (activeFilter === "all") return lastElements;
    return lastElements.filter((el) => el.label === activeFilter || (activeFilter === "button" && el.label === "select"));
  }

  function applyFilterAndRender() {
    const filtered = getFilteredElements();
    renderDetections(currentScreenshotBase64, filtered);
  }

  // Interactive Direct Canvas Click Handler
  canvas.addEventListener("click", (e) => {
    if (!canvas.width || !canvas.height) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    const clickX = Math.round((e.clientX - rect.left) * scaleX);
    const clickY = Math.round((e.clientY - rect.top) * scaleY);

    if (typeof executeBrowserControl === "function") {
      executeBrowserControl("vision-manual", "click", `${clickX},${clickY}`, "");
    }
  });

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
      currentScreenshotBase64 = data.screenshotBase64 || "";
      applyFilterAndRender();
      if (canvasHint) canvasHint.classList.remove("hidden");
    } catch (err) {
      elementsList.innerHTML = `<div class="p-2.5 text-[11px] text-red-error-light bg-red-error/10 border border-red-error/20 rounded-sm">Error: ${err.message}</div>`;
    } finally {
      detectBtn.disabled = false;
      detectBtn.textContent = "Detect";
    }
  });

  clearBtn.addEventListener("click", () => {
    lastElements = [];
    currentScreenshotBase64 = "";
    canvas.classList.add("hidden");
    emptyScreenshot.classList.remove("hidden");
    if (canvasHint) canvasHint.classList.add("hidden");
    if (elementsEmpty) {
      elementsEmpty.classList.remove("hidden");
      elementsList.innerHTML = "";
      elementsList.appendChild(elementsEmpty);
    } else {
      elementsList.innerHTML = `<div class="p-3 text-center text-vscode-muted text-[11px]">Run detection to see elements</div>`;
    }
    if (navBadge) navBadge.classList.add("hidden");

    if (typeof executeBrowserControl === "function") {
      executeBrowserControl("vision-manual", "hide_detections", "overlay", "");
    }
  });

  function renderDetections(screenshotBase64, elements) {
    let currentImg = null;

    function drawCanvas(hoveredElement = null) {
      if (!currentImg) return;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(currentImg, 0, 0);

      elements.forEach((el, index) => {
        const [x1, y1, x2, y2] = el.box;
        const isHovered = hoveredElement === el;
        const color = LABEL_COLORS[el.label] || LABEL_COLORS.default;

        if (isHovered) {
          ctx.strokeStyle = "#FFBC05";
          ctx.lineWidth = 6;
          ctx.shadowColor = "#FFBC05";
          ctx.shadowBlur = 10;
        } else {
          ctx.strokeStyle = color;
          ctx.lineWidth = 3;
          ctx.shadowBlur = 0;
        }
        ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
        ctx.shadowBlur = 0;

        // Set-of-Mark numbered badge tag
        const tagText = `[${el.id || index + 1}] ${el.label} ${Math.round(el.score * 100)}%`;
        ctx.font = "bold 13px monospace";
        const textWidth = ctx.measureText(tagText).width;

        ctx.fillStyle = isHovered ? "#FFBC05" : color;
        ctx.fillRect(x1, Math.max(0, y1 - 20), textWidth + 8, 20);

        ctx.fillStyle = isHovered ? "black" : "white";
        ctx.fillText(tagText, x1 + 4, Math.max(14, y1 - 5));
      });
    }

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

        currentImg = img;
        drawCanvas(null);
      };
      img.src = "data:image/png;base64," + screenshotBase64;
    }

    elementsList.innerHTML = "";
    if (elements.length === 0) {
      if (elementsEmpty) {
        elementsList.appendChild(elementsEmpty);
        elementsEmpty.classList.remove("hidden");
      } else {
        elementsList.innerHTML = `<div class="p-3 text-center text-vscode-muted text-[11px]">No elements match current filter</div>`;
      }
      return;
    }

    elements.forEach((el, index) => {
      const eid = el.id || index + 1;
      const [cx, cy] = el.center;
      const color = LABEL_COLORS[el.label] || LABEL_COLORS.default;
      const item = document.createElement("div");
      item.className = "vision-element-item p-1.5 flex items-center justify-between gap-2 border border-vscode-dim rounded-sm bg-vscode-inner hover:border-vscode-bright transition-colors cursor-pointer";

      const labelContainer = document.createElement("div");
      labelContainer.className = "flex items-center gap-1.5 overflow-hidden";
      labelContainer.innerHTML = `
        <span class="px-1 py-0.2 bg-vscode-sidebar text-[9px] font-mono font-bold rounded-xs shrink-0 text-vscode-muted">[${eid}]</span>
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

      item.addEventListener("mouseenter", () => {
        drawCanvas(el);
        if (typeof executeBrowserControl === "function") {
          executeBrowserControl("vision-manual", "highlight_element", `${cx},${cy}`, "");
        }
      });

      item.addEventListener("mouseleave", () => {
        drawCanvas(null);
        if (typeof executeBrowserControl === "function") {
          executeBrowserControl("vision-manual", "highlight_element", "clear", "");
        }
      });

      item.appendChild(labelContainer);
      item.appendChild(actionsContainer);
      elementsList.appendChild(item);
    });
  }
}
