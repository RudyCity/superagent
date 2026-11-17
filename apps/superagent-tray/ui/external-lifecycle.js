/* External worker lifecycle console — no direct network, bearer, or shell access.
 * Native Tauri forwards only focused, validated operator actions to loopback Core.
 */
(() => {
  const $ = id => document.getElementById(id);
  const call = async (action, args = {}) => {
    const workspace = $("external-life-workspace").value.trim();
    if (!workspace) throw new Error("Select an authorised local workspace first.");
    const invoke = window.__TAURI__?.core?.invoke;
    if (!invoke) throw new Error("Native SuperAgent Tray is required.");
    const reply = await invoke("external_lifecycle_action", {
      action, payload: { workspace, args },
    });
    if (!reply?.success) throw new Error(reply?.error || "Core did not confirm the lifecycle action.");
    return reply.result;
  };
  const el = (tag, className, value) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = String(value);
    return node;
  };
  const time = ms => ms ? new Date(ms).toLocaleString() : "—";
  const state = { busy: false, workflows: [], runs: [], workers: [], targets: [] };
  let pendingCreateKey = null;
  const runKeys = new Map();
  const feedback = (message, error = false) => {
    const node = $("external-life-feedback");
    node.textContent = message;
    node.classList.toggle("external-life-error", error);
  };
  const button = (label, action, key, id, destructive = false) => {
    const node = el("button", "button ghost external-life-mini" + (destructive ? " external-life-danger" : ""), label);
    node.type = "button"; node.dataset.action = action; node.dataset.key = key;
    node.dataset.id = id;
    return node;
  };
  const row = (title, subtitle, status, buttons = []) => {
    const item = el("div", "external-life-item");
    const main = el("div", "external-life-item-main");
    main.append(el("strong", "", title), el("small", "", subtitle));
    const right = el("div", "external-life-item-actions");
    const chip = el("span", "external-life-state " + String(status).replace(/[^a-z_]/g, ""), status);
    right.append(chip, ...buttons);
    item.append(main, right);
    return item;
  };
  function render() {
    const workers = $("external-life-workers");
    workers.replaceChildren();
    $("external-life-worker-count").textContent = state.workers.filter(w => w.status === "online").length + " online / " + state.workers.length + " registered";
    if (!state.workers.length) workers.append(el("p", "external-life-empty",
      "No MCP workers registered. In another ChatGPT.com session call superagent_lifecycle with action worker.register, then poll worker.claim."));
    for (const worker of state.workers) {
      const actions = [button("Bind tab", "worker.bind", "workerId", worker.id)];
      if (worker.cdp) actions.push(button("Unbind", "worker.unbind", "workerId", worker.id));
      actions.push(button("Revoke", "worker.revoke", "workerId", worker.id, true));
      workers.append(row(worker.label,
        worker.id + (worker.cdp ? " · CDP " + worker.cdp.clientId + " / tab " + worker.cdp.tabId : ""),
        worker.status, actions));
    }
    const cdpSelect = $("external-life-cdp-target");
    const oldTarget = cdpSelect.value;
    cdpSelect.replaceChildren();
    const emptyTarget = el("option", "", "Select an idle paired ChatGPT tab");
    emptyTarget.value = ""; cdpSelect.append(emptyTarget);
    for (const profile of state.targets) for (const tab of profile.tabs || []) {
      const option = el("option", "", profile.label + " · " + tab.title + " (tab " + tab.tabId + ")");
      option.value = profile.clientId + ":" + tab.tabId;
      cdpSelect.append(option);
    }
    cdpSelect.value = [...cdpSelect.options].some(opt => opt.value === oldTarget) ? oldTarget : "";
    const target = $("external-life-worker");
    const selected = target.value;
    target.replaceChildren();
    const any = el("option", "", "Any approved, available worker");
    any.value = ""; target.append(any);
    for (const worker of state.workers) {
      const choice = el("option", "", worker.label + " · " + worker.status);
      choice.value = worker.id; target.append(choice);
    }
    target.value = state.workers.some(w => w.id === selected) ? selected : "";

    const runs = $("external-life-runs");
    runs.replaceChildren();
    $("external-life-run-count").textContent = state.workflows.length + " workflows · " + state.runs.length + " recent runs";
    if (!state.workflows.length) runs.append(el("p", "external-life-empty", "No outbound lifecycle workflows in this workspace."));
    for (const workflow of [...state.workflows].reverse()) {
      const card = el("article", "external-life-workflow");
      const head = row(workflow.name,
        workflow.cronExpression + " · next " + time(workflow.nextRun) +
        " · " + (workflow.runCount || 0) + " run(s)",
        workflow.enabled ? "scheduled" : "paused",
        [
          button("Run now", "run.now", "workflowId", workflow.id),
          button(workflow.enabled ? "Pause" : "Resume", workflow.enabled ? "pause" : "resume", "workflowId", workflow.id),
          button("Cancel", "cancel", "workflowId", workflow.id, true),
        ],
      );
      card.append(head);
      const history = state.runs.filter(r => r.workflowId === workflow.id).slice(-8).reverse();
      for (const run of history) {
        const stageText = (run.stages || []).map(st => st.id + ": " + st.state).join(" · ");
        const controls = [];
        if (run.state === "review_required") for (const step of run.stages) {
          if (step.state === "review_required") {
            const control = button("Review & retry " + step.id, "review.retry", "runId", run.id, true);
            control.dataset.step = step.id;
            controls.push(control);
          }
        }
        card.append(row("Run " + run.id.slice(-10), time(run.createdAt) + " · " + stageText, run.state, controls));
      }
      runs.append(card);
    }
  }
  async function refresh() {
    if (state.busy || !($("external-life-workspace")?.value || "").trim()) return;
    state.busy = true;
    try {
      const [inventory, workerList, targetList] = await Promise.all([
        call("list", { limit: 100 }), call("workers"), call("targets"),
      ]);
      state.workflows = inventory.workflows || [];
      state.runs = inventory.runs || [];
      state.workers = workerList.workers || [];
      state.targets = targetList.targets || [];
      render();
      feedback("Workspace inventory updated. Worker polling is opt-in; offline sessions are not awakened.");
    } catch (error) {
      feedback(error instanceof Error ? error.message : "Unable to load workflows.", true);
    } finally { state.busy = false; }
  }
  function schedule() {
    const frequency = $("external-life-frequency").value;
    if (frequency === "custom") {
      const cronExpression = $("external-life-cron").value.trim();
      if (!/^\S+(?:\s+\S+){4}$/.test(cronExpression)) throw Error("Cron must have exactly five fields.");
      return { cronExpression };
    }
    if (frequency === "once") {
      const date = new Date($("external-life-once-at").value);
      if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now() + 30_000) {
        throw Error("Select a future date, at least 30 seconds from now.");
      }
      return {
        cronExpression: [date.getMinutes(), date.getHours(), date.getDate(), date.getMonth()+1, "*"].join(" "),
        maxRuns: 1,
      };
    }
    const value = $("external-life-at-time").value;
    if (!/^\d{2}:\d{2}$/.test(value)) throw Error("Select a valid local time.");
    const [hour, minute] = value.split(":").map(Number);
    return { cronExpression: frequency === "daily"
      ? minute + " " + hour + " * * *"
      : minute + " " + hour + " * * " + $("external-life-weekday").value };
  }
  function toggleScheduleFields() {
    const kind = $("external-life-frequency").value;
    $("external-life-once-field").hidden = kind !== "once";
    $("external-life-time-field").hidden = kind === "once" || kind === "custom";
    $("external-life-weekday-field").hidden = kind !== "weekly";
    $("external-life-cron-field").hidden = kind !== "custom";
    $("external-life-once-at").required = kind === "once";
  }
  document.addEventListener("DOMContentLoaded", () => {
    if (!$("external-life-form")) return;
    const upcoming = new Date(Date.now()+60*60_000);
    upcoming.setSeconds(0, 0);
    const pad = n => String(n).padStart(2,"0");
    $("external-life-once-at").value = upcoming.getFullYear() + "-" +
      pad(upcoming.getMonth()+1) + "-" + pad(upcoming.getDate()) + "T" +
      pad(upcoming.getHours()) + ":" + pad(upcoming.getMinutes());
    $("external-life-frequency").addEventListener("change", toggleScheduleFields);
    toggleScheduleFields();
    $("external-life-refresh").addEventListener("click", refresh);
    $("external-life-form").addEventListener("submit", async event => {
      event.preventDefault();
      if (state.busy) return;
      const create = $("external-life-create");
      state.busy = true; create.disabled = true;
      try {
        const prompt = $("external-life-prompt").value.trim();
        if (!prompt) throw Error("Enter worker instructions.");
        const advanced = $("external-life-steps").value.trim();
        const workerId = $("external-life-worker").value;
        const steps = advanced ? JSON.parse(advanced)
          : [{ id:"task", prompt, dependsOn:[], ...(workerId ? { targetWorkerId:workerId } : {}) }];
        if (!Array.isArray(steps)) throw Error("Advanced tasks must be a JSON array.");
        pendingCreateKey ||= "tray_" + window.crypto.randomUUID();
        await call("create", { name:$("external-life-name").value.trim(),
          prompt, steps, ...schedule(), idempotencyKey: pendingCreateKey });
        pendingCreateKey = null;
        feedback("Scheduled delegation created. An approved MCP worker can claim it when due.");
        $("external-life-name").value = "";
        $("external-life-prompt").value = "";
        $("external-life-steps").value = "";
      } catch (error) { feedback(error instanceof Error ? error.message : "Schedule failed.", true); }
      finally { state.busy = false; create.disabled = false; }
      await refresh();
    });
    $("external-life-runs").addEventListener("click", async event => {
      const target = event.target.closest("button[data-action]");
      if (!target || state.busy) return;
      const action = target.dataset.action;
      if ((action === "cancel" || action === "review.retry") &&
        !window.confirm(action === "review.retry"
          ? "Only retry after checking that the previous attempt did not perform an irreversible action. Continue?"
          : "Cancel this workflow and its active or queued runs?")) return;
      const args = { [target.dataset.key]:target.dataset.id };
      if (action === "run.now") {
        if (!runKeys.has(target.dataset.id)) runKeys.set(target.dataset.id, "tray_" + window.crypto.randomUUID());
        args.idempotencyKey = runKeys.get(target.dataset.id);
      }
      if (action === "review.retry") args.stepId = target.dataset.step;
      state.busy = true; target.disabled = true;
      try {
        await call(action, args);
        if (action === "run.now") runKeys.delete(target.dataset.id);
        feedback("Lifecycle action acknowledged by Core.");
      } catch (error) {
        feedback(error instanceof Error ? error.message : "Lifecycle operation failed.", true);
      } finally { state.busy = false; target.disabled = false; }
      await refresh();
    });
    $("external-life-workers").addEventListener("click", async event => {
      const target = event.target.closest("button[data-action]");
      if (!target || state.busy) return;
      const action = target.dataset.action;
      const args = { workerId: target.dataset.id };
      if (action === "worker.bind") {
        const chosen = $("external-life-cdp-target").value;
        if (!chosen) { feedback("Select a verified idle ChatGPT tab first.", true); return; }
        const separator = chosen.lastIndexOf(":");
        args.clientId = chosen.slice(0, separator);
        args.tabId = Number(chosen.slice(separator+1));
        if (!window.confirm("Allow SuperAgent Scheduler to send one-time task notifications to this exact ChatGPT.com tab? The worker still needs separate MCP approval.")) return;
      } else if (!window.confirm(action === "worker.revoke"
        ? "Revoke this worker? Any active lease will require manual reconciliation."
        : "Unbind automatic notifications from this ChatGPT.com tab?")) return;
      state.busy = true; target.disabled = true;
      try { await call(action, args); feedback("Worker policy updated."); }
      catch (error) { feedback(error instanceof Error ? error.message : "Worker operation failed.", true); }
      finally { state.busy = false; target.disabled = false; }
      await refresh();
    });
    $("external-life-workspace").addEventListener("change", refresh);
    window.addEventListener("hashchange", () => {
      if (window.location.hash === "#jobs") refresh();
    });
  });
})();
