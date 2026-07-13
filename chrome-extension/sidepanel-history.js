// Chat History and Sessions management for Superagent Chrome Extension

// Fetch and Render Chat History
async function loadChatHistory() {
  try {
    const res = await fetch(`${BASE_URL}/api/history`);
    const data = await res.json().catch(() => null);
    if (res.ok && data && data.success && Array.isArray(data.messages)) {
      clearChatMessages();
      renderChatHistory(data.messages);
    }
  } catch (err) {
    console.error("Failed to load chat history:", err);
  }
}

function renderChatHistory(messages) {
  if (!messages || messages.length === 0) {
    appendMessage("system", `System initialized in ${currentMode} mode.`);
    return;
  }

  const renderedToolCallIds = new Set();

  messages.forEach((msg, msgIdx) => {
    if (msg.role === "system") {
      if (msg.content) {
        appendMessage("system", typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content));
      }
      return;
    }

    if (msg.role === "user") {
      const text = typeof msg.content === "string" 
        ? msg.content 
        : (Array.isArray(msg.content) ? msg.content.map(p => p.text || "").join(" ") : "");
      appendMessage("user", text);
      return;
    }

    if (msg.role === "assistant") {
      const text = typeof msg.content === "string" 
        ? msg.content 
        : (Array.isArray(msg.content) ? msg.content.map(p => p.text || "").join(" ") : "");

      const msgDiv = appendMessage("agent", "");
      const contentDiv = msgDiv.querySelector(".msg-content");
      const textSpan = msgDiv.querySelector(".msg-content-text");

      // 1. Render Reasoning if present
      if (msg.reasoning) {
        const reasoningDiv = document.createElement("div");
        reasoningDiv.className = "reasoning-block";
        
        const label = document.createElement("div");
        label.className = "msg-header";
        label.textContent = "Reasoning";
        reasoningDiv.appendChild(label);
        
        const textSpanReasoning = document.createElement("span");
        textSpanReasoning.className = "reasoning-text";
        textSpanReasoning.textContent = msg.reasoning;
        reasoningDiv.appendChild(textSpanReasoning);
        
        contentDiv.insertBefore(reasoningDiv, contentDiv.firstChild);
      }

      // 2. Render Text Content
      if (textSpan && text) {
        textSpan.innerHTML = formatMarkdown(text);
      }

      // 3. Render Tool Calls & Results
      const toolCalls = msg.toolCalls || [];
      let toolResults = msg.toolResults || [];

      // If we don't have toolResults in this assistant message, look ahead in subsequent tool messages
      if (toolResults.length === 0) {
        for (let i = msgIdx + 1; i < messages.length; i++) {
          const nextMsg = messages[i];
          if (nextMsg.role === "tool" && Array.isArray(nextMsg.toolResults)) {
            nextMsg.toolResults.forEach(tr => {
              if (tr.toolCallId && toolCalls.some(tc => tc.id === tr.toolCallId)) {
                toolResults.push(tr);
              }
            });
          }
          if (nextMsg.role === "user" || nextMsg.role === "assistant") {
            break;
          }
        }
      }

      toolCalls.forEach((tc, idx) => {
        if (tc.id) {
          renderedToolCallIds.add(tc.id);
        }
        const tr = toolResults.find(r => r.toolCallId === tc.id) || toolResults[idx];

        const toolBlock = document.createElement("div");
        toolBlock.className = "tool-block";

        let argsText = "";
        try {
          const args = tc.args || {};
          const argsStr = JSON.stringify(args, null, 2);
          argsText = argsStr.length > 300 ? argsStr.slice(0, 300) + "..." : argsStr;
        } catch (_) {}

        const isErr = tr && tr.isError;
        const label = getToolLabel(tc, tc.name);
        const detail = buildToolDetail(tc);
        const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

        let argsSummary = "";
        if (tc.args) {
          const parts = Object.entries(tc.args).map(([key, val]) => {
            let valStr = typeof val === "object" ? JSON.stringify(val) : String(val);
            if (valStr.length > 30) valStr = valStr.slice(0, 27) + "...";
            return `${key}: ${valStr}`;
          });
          argsSummary = parts.join(", ");
        }

        const statusText = tr ? (isErr ? '✗ failed' : '✓ done') : 'running...';
        const statusClass = tr ? (isErr ? 'text-red-error' : 'text-green-success') : 'text-vscode-blue';

        toolBlock.innerHTML = `
          <div class="tool-row flex items-center justify-between gap-2 cursor-pointer py-1 px-1.5 rounded bg-vscode-inner hover:bg-vscode-hover border border-vscode-dim select-none">
            <div class="tool-row-left flex items-center gap-1.5 overflow-hidden text-ellipsis whitespace-nowrap">
              <span class="tool-row-icon text-vscode-muted text-[10px]">🛠</span>
              <span class="tool-row-name font-mono font-bold text-vscode-bright ${isErr ? 'tool-row-label-error' : ''}">${esc(tc.name)}</span>
              <span class="tool-row-args font-mono text-vscode-muted text-[9px]">(${esc(argsSummary)})</span>
            </div>
            <div class="tool-row-right flex items-center gap-1.5 shrink-0">
              <span class="tool-row-status font-mono text-[9px] ${statusClass} font-bold">${statusText}</span>
              <span class="tool-row-chevron font-mono text-[9px] text-vscode-muted">⌄</span>
            </div>
          </div>
          <div class="tool-expand hidden">
            ${argsText ? `<pre class="tool-args block p-1.5 bg-vscode-sidebar border border-vscode-dim rounded text-[9.5px] font-mono text-vscode-muted max-h-[120px] overflow-y-auto mt-1">${esc(argsText)}</pre>` : ""}
            <div class="tool-result-area hidden mt-1"></div>
          </div>
        `;

        toolBlock.querySelector(".tool-row").addEventListener("click", () => {
          const exp = toolBlock.querySelector(".tool-expand");
          const chev = toolBlock.querySelector(".tool-row-chevron");
          const isHidden = exp.classList.contains("hidden");
          exp.classList.toggle("hidden", !isHidden);
          chev.textContent = isHidden ? "⌄" : "›";
        });

        if (tr) {
          const resultArea = toolBlock.querySelector(".tool-result-area");
          const resultText = tr.result || "";
          if (resultText) {
            const preview = resultText.length > 500 ? resultText.slice(0, 500) + "\n... (truncated)" : resultText;
            resultArea.textContent = preview;
            resultArea.classList.remove("hidden");
            if (isErr) resultArea.classList.add("tool-result-error");
          }
        }

        contentDiv.appendChild(toolBlock);
      });
    }

    if (msg.role === "tool" && Array.isArray(msg.toolResults)) {
      const msgDivs = chatMessages.querySelectorAll(".msg-agent");
      if (msgDivs.length > 0) {
        const lastMsgDiv = msgDivs[msgDivs.length - 1];
        const contentDiv = lastMsgDiv.querySelector(".msg-content");
        
        // Filter out results that were already rendered under assistant toolCalls
        const unrenderedResults = msg.toolResults.filter(tr => !tr.toolCallId || !renderedToolCallIds.has(tr.toolCallId));

        unrenderedResults.forEach(tr => {
          const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
          const toolBlock = document.createElement("div");
          toolBlock.className = "tool-block";
          const resultText = tr.result || "";
          const preview = resultText.length > 500 ? resultText.slice(0, 500) + "\n... (truncated)" : resultText;

          toolBlock.innerHTML = `
            <div class="tool-row">
              <span class="tool-row-label ${tr.isError ? 'tool-row-label-error' : ''}">${esc(tr.name ?? "tool")}</span>
              <span class="tool-row-chevron">›</span>
            </div>
            <div class="tool-expand hidden">
              <div class="tool-result-area ${tr.isError ? 'tool-result-error' : ''}">${esc(preview)}</div>
            </div>
          `;

          toolBlock.querySelector(".tool-row").addEventListener("click", () => {
            const exp = toolBlock.querySelector(".tool-expand");
            const chev = toolBlock.querySelector(".tool-row-chevron");
            const isHidden = exp.classList.contains("hidden");
            exp.classList.toggle("hidden", !isHidden);
            chev.textContent = isHidden ? "⌄" : "›";
          });

          contentDiv.appendChild(toolBlock);
        });
      }
    }
  });
}

async function loadChatHistorySessions() {
  chatHistoryList.innerHTML = '<div class="p-3 text-center text-vscode-muted text-[11px]">Loading sessions...</div>';
  try {
    const mode = typeof currentMode !== "undefined" ? currentMode : "single";
    const res = await fetch(`${BASE_URL}/api/history/sessions?mode=${mode}`);
    const data = await res.json().catch(() => null);
    if (res.ok && data && data.success && Array.isArray(data.sessions)) {
      renderChatHistorySessionsList(data.sessions);
    } else {
      chatHistoryList.innerHTML = '<div class="p-3 text-center text-vscode-muted text-[11px]">Failed to load sessions</div>';
    }
  } catch (err) {
    console.error("Failed to fetch chat history sessions:", err);
    chatHistoryList.innerHTML = '<div class="p-3 text-center text-vscode-muted text-[11px]">Error loading sessions</div>';
  }
}

function renderChatHistorySessionsList(sessions) {
  chatHistoryList.innerHTML = "";
  if (sessions.length === 0) {
    chatHistoryList.innerHTML = '<div class="p-3 text-center text-vscode-muted text-[11px]">No previous sessions</div>';
    return;
  }

  sessions.forEach(s => {
    const item = document.createElement("div");
    item.className = "history-item px-2.5 py-2 border-b border-vscode-dim cursor-pointer hover:bg-vscode-hover flex flex-col gap-1 transition-colors duration-150";
    
    const formattedDate = new Date(s.lastModified).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });

    item.innerHTML = `
      <div class="flex justify-between items-center text-[11px] font-medium">
        <span class="history-name text-vscode-light truncate max-w-[170px]" title="${s.displayName}">${escapeHtml(s.displayName)}</span>
        <span class="history-count text-vscode-muted text-[10px] shrink-0">${s.messageCount} msgs</span>
      </div>
      <div class="text-[10px] text-vscode-muted truncate" title="${s.preview}">${escapeHtml(s.preview)}</div>
      <div class="text-[9px] text-vscode-muted/70 text-right mt-0.5">${formattedDate}</div>
    `;

    item.addEventListener("click", async () => {
      await switchChatSession(s.id);
      switchTab("chat");
    });

    chatHistoryList.appendChild(item);
  });
}

async function switchChatSession(sessionId) {
  const activeWorkspaceText = document.getElementById("active-workspace-text");
  const workspace = activeWorkspaceText ? activeWorkspaceText.textContent : "";
  const modeRadio = document.querySelector('input[name="agent-mode"]:checked');
  const mode = modeRadio ? modeRadio.value : "single";
  const activeMode = currentMode || mode;

  if (!workspace || workspace === "Not Selected") return;

  chatMessages.innerHTML = '<div class="p-3 text-center text-vscode-muted text-[11px]">Switching chat session...</div>';

  try {
    const res = await fetch(`${BASE_URL}/api/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: activeMode,
        workspace: workspace,
        resume: sessionId
      })
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data && data.success) {
      await checkServerStatus();
      await loadChatHistory();
    } else {
      alert("Failed to switch chat session");
      await loadChatHistory();
    }
  } catch (err) {
    console.error("Error switching chat session:", err);
    alert("Error connecting to server: " + err.message);
    await loadChatHistory();
  }
}

async function startNewChatSession() {
  const activeWorkspaceText = document.getElementById("active-workspace-text");
  const workspace = activeWorkspaceText ? activeWorkspaceText.textContent : "";
  const modeRadio = document.querySelector('input[name="agent-mode"]:checked');
  const mode = modeRadio ? modeRadio.value : "single";
  const activeMode = currentMode || mode;

  if (!workspace || workspace === "Not Selected") return;

  if (!confirm("Are you sure you want to start a new chat? This will clear the current chat messages and begin a fresh session.")) return;

  try {
    const res = await fetch(`${BASE_URL}/api/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: activeMode,
        workspace: workspace,
        resume: false
      })
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data && data.success) {
      await checkServerStatus();
      clearChatMessages();
      appendMessage("system", "New chat session started.");
    } else {
      alert("Failed to start new chat");
    }
  } catch (err) {
    console.error("Error starting new chat:", err);
    alert("Error connecting to server: " + err.message);
  }
}
