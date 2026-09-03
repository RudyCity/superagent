import {
  getConfiguredProviders,
  removeProvider,
  addProvider,
  switchActiveProvider,
} from "../../core/config.js";
import type { ChatLine } from "../../core/slash-commands.js";

export interface LoginWizardCrudContext {
  setActiveWizard: React.Dispatch<React.SetStateAction<any>>;
  setWizardOptions: React.Dispatch<React.SetStateAction<string[]>>;
  setWizardSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  addLine: (line: ChatLine) => void;
  setInput: React.Dispatch<React.SetStateAction<string>>;
}

export function handleDeleteProviderStep14(
  value: string,
  ctx: LoginWizardCrudContext,
  now: number
): void {
  const providers = getConfiguredProviders();
  const idx = parseInt(value, 10) - 1;
  const selectedProvider = providers[idx];
  if (!selectedProvider) {
    ctx.addLine({ type: "error", content: "Invalid provider selection.", timestamp: now });
    ctx.setActiveWizard(null);
    ctx.setWizardOptions([]);
    ctx.setWizardSelectedIndex(0);
    return;
  }
  ctx.setActiveWizard({
    type: "login",
    step: 15,
    data: {
      providerId: selectedProvider.id,
      providerName: selectedProvider.name,
    },
  });
  ctx.setWizardOptions(["1. Yes, Delete Provider", "2. No (Cancel)"]);
  ctx.setWizardSelectedIndex(0);
}

export function handleDeleteProviderStep15(
  value: string,
  data: Record<string, string>,
  ctx: LoginWizardCrudContext,
  now: number
): void {
  const choice = value.toLowerCase();
  const confirmDelete = choice.includes("yes") || choice.includes("delete") || choice === "1" || choice.startsWith("1.");

  const pId = data.providerId || "";
  const pName = data.providerName || "";

  if (!confirmDelete) {
    // No (Cancel) → back to step 14 delete list
    const list = getConfiguredProviders();
    ctx.setActiveWizard({ type: "login", step: 14, data: {} });
    ctx.setWizardOptions(list.map(
      (p, i) => `${i + 1}. ${p.name} [${p.type || "unknown"}]${p.baseUrl ? ` (${p.baseUrl})` : ""}`
    ));
    ctx.setWizardSelectedIndex(0);
    return;
  }

  try {
    removeProvider(pId);
    ctx.addLine({
      type: "system",
      content: `✅ Provider removed: ${pName}`,
      timestamp: now,
    });
  } catch (err: any) {
    ctx.addLine({
      type: "error",
      content: `Failed to remove provider: ${err.message}`,
      timestamp: now,
    });
  }

  // After deletion: reload list and go back to step 14
  const remaining = getConfiguredProviders();
  if (remaining.length > 0) {
    ctx.setActiveWizard({ type: "login", step: 14, data: {} });
    ctx.setWizardOptions(remaining.map(
      (p, i) => `${i + 1}. ${p.name} [${p.type || "unknown"}]${p.baseUrl ? ` (${p.baseUrl})` : ""}`
    ));
    ctx.setWizardSelectedIndex(0);
  } else {
    ctx.addLine({ type: "system", content: "No more providers to delete.", timestamp: now });
    ctx.setActiveWizard(null);
    ctx.setWizardOptions([]);
    ctx.setWizardSelectedIndex(0);
  }
}

export function handleEditProviderStep17(
  value: string,
  ctx: LoginWizardCrudContext,
  now: number
): void {
  const providers = getConfiguredProviders();
  const idx = parseInt(value, 10) - 1;
  const selectedProvider = providers[idx];
  if (!selectedProvider) {
    ctx.addLine({ type: "error", content: "Invalid provider selection.", timestamp: now });
    ctx.setActiveWizard(null);
    ctx.setWizardOptions([]);
    ctx.setWizardSelectedIndex(0);
    return;
  }

  const masked = selectedProvider.apiKey
    ? (selectedProvider.apiKey.length <= 8 ? "*".repeat(selectedProvider.apiKey.length) : `${selectedProvider.apiKey.slice(0, 4)}...${selectedProvider.apiKey.slice(-4)}`)
    : "None";

  ctx.addLine({
    type: "system",
    content: `Editing provider: ${selectedProvider.name} [${selectedProvider.type}]\nCurrent API Key: ${masked}\nCurrent Base URL: ${selectedProvider.baseUrl || "None"}\n\nEnter new API Key (or press Enter to keep current):`,
    timestamp: now,
  });

  ctx.setActiveWizard({
    type: "login",
    step: 18,
    data: {
      providerId: selectedProvider.id,
      providerName: selectedProvider.name,
      providerType: selectedProvider.type,
      providerApiKey: selectedProvider.apiKey,
      providerBaseUrl: selectedProvider.baseUrl || "",
      isEdit: "true",
    },
  });
  ctx.setWizardOptions([]);
  ctx.setWizardSelectedIndex(0);
  ctx.setInput("");
}

export function handleEditProviderStep18(
  value: string,
  data: Record<string, string>,
  ctx: LoginWizardCrudContext,
  now: number
): void {
  const newApiKey = value;
  if (newApiKey.trim() !== "") {
    data.providerApiKey = newApiKey.trim();
    ctx.addLine({
      type: "system",
      content: "Updated API Key input.",
      timestamp: now,
    });
  } else {
    ctx.addLine({
      type: "system",
      content: "Kept current API Key.",
      timestamp: now,
    });
  }

  ctx.addLine({
    type: "system",
    content: `Enter new Base URL (or press Enter to keep current: ${data.providerBaseUrl || "None"}):`,
    timestamp: now,
  });

  ctx.setActiveWizard({
    type: "login",
    step: 19,
    data: {
      ...data,
    },
  });
  ctx.setWizardOptions([]);
  ctx.setWizardSelectedIndex(0);
  ctx.setInput("");
}

export async function handleEditProviderStep19(
  value: string,
  data: Record<string, string>,
  ctx: LoginWizardCrudContext,
  now: number
): Promise<void> {
  const newBaseUrl = value.trim();
  if (newBaseUrl !== "") {
    data.providerBaseUrl = newBaseUrl;
    ctx.addLine({
      type: "system",
      content: `Updated Base URL: ${newBaseUrl}`,
      timestamp: now,
    });
  } else {
    ctx.addLine({
      type: "system",
      content: "Kept current Base URL.",
      timestamp: now,
    });
  }

  const pId = data.providerId || "";
  const pName = data.providerName || "";
  const pType = data.providerType || "";
  const pApiKey = data.providerApiKey || "";
  const pBaseUrl = data.providerBaseUrl || "";

  try {
    addProvider({
      id: pId,
      name: pName,
      provider: pType,
      apiKey: pApiKey,
      baseUrl: pBaseUrl || undefined,
    });

    switchActiveProvider(pId);

    // Invalidate stale tool-call-support probe cache so next run re-probes the new endpoint
    try {
      const { clearToolCallSupportCache } = await import("../../utils/promptBasedToolCalling.js");
      clearToolCallSupportCache();
    } catch {}

    ctx.addLine({
      type: "system",
      content: `Successfully updated provider profile: ${pName} (${pType})\nSaved to model-config.json`,
      timestamp: now,
    });

    // Transition to connection test confirmation (step 7)
    ctx.setActiveWizard({
      type: "login",
      step: 7,
      data: {
        providerId: pId,
        providerName: pName,
        providerType: pType,
        providerApiKey: pApiKey,
        providerBaseUrl: pBaseUrl,
        fromList: "false",
        isEdit: "true",
      },
    });
    ctx.setWizardOptions(["1. Yes, Test Connection", "2. No (Cancel Setup)"]);
    ctx.setWizardSelectedIndex(0);
    ctx.setInput("");
  } catch (err: any) {
    ctx.addLine({
      type: "error",
      content: `Failed to save credentials: ${err.message}`,
      timestamp: now,
    });
    ctx.setActiveWizard(null);
    ctx.setWizardOptions([]);
    ctx.setWizardSelectedIndex(0);
  }
}
