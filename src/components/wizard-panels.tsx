import React, { memo } from "react";
import { Box, Text } from "ink";
import { WizardDialog } from "./wizard-dialog.js";
import { PlanApprovalDialog } from "./plan-approval-dialog.js";
import { filterSuggestions } from "../utils/text.js";
import { getInstalledSkills } from "../core/config.js";
import type { Checkpoint } from "../core/checkpoints.js";
import type { ToolCall } from "../core/conversation.js";
import type { QuestionItem } from "../core/agent.js";

export interface WizardPanelsProps {
  activeWizard: {
    type: "login" | "model" | "plan_approve" | "permission" | "question" | "resume" | "goal" | "checkpoint" | "skills" | "exit_confirm";
    step: number;
    data: Record<string, string>;
    isMultiSelect?: boolean;
    questions?: QuestionItem[];
    currentQuestionIndex?: number;
    answers?: string[];
  } | null;
  wizardOptions: string[];
  wizardSelectedIndex: number;
  wizardSelectedSet: Set<number>;
  pendingPermission: {
    toolCall: ToolCall;
    description: string;
    resolve: (value: boolean) => void;
  } | null;
  pendingQuestion: {
    question: string;
    options: string[];
    resolve: (value: any) => void;
  } | null;
  planState: string;
  planUrl: string;
  planFilePath: string;
  input: string;
  wizardIsLoadingModels: boolean;
  checkpointsList: Checkpoint[];
  goalMode: { goal: string; startedAt: number } | null;
  suggestions: string[];
  focus?: "plan" | "actions";
  scrollOffset?: number;
  onScrollChange?: (val: number) => void;
}

function getTruncatedLabel(text: string): string {
  const clean = text.replace(/^[❓\s?]+|[?\s❓]+$/g, "").trim();
  const words = clean.split(/\s+/);
  if (words.length <= 3) {
    return clean;
  }
  return words.slice(0, 3).join(" ") + "...";
}

export const WizardPanels = memo(function WizardPanels(props: WizardPanelsProps) {
  const {
    activeWizard,
    wizardOptions,
    wizardSelectedIndex,
    wizardSelectedSet,
    pendingPermission,
    pendingQuestion,
    planState,
    planUrl,
    planFilePath,
    input,
    wizardIsLoadingModels,
    checkpointsList,
    goalMode,
    suggestions,
  } = props;

  return (
    <>
      {/* Permission prompt */}
      {activeWizard && activeWizard.type === "permission" && pendingPermission && (
        <WizardDialog
          title="⚠️ PERMISSION REQUIRED (Use Arrow Keys Up/Down & Enter, or press Y/N):"
          description={pendingPermission.description}
          borderColor="yellow"
          options={wizardOptions}
          selectedIndex={wizardSelectedIndex}
        />
      )}

      <Box flexDirection="column" marginTop={1}>
        {planState === "PLANNING_PENDING" && activeWizard?.type !== "plan_approve" && (
          <Box marginBottom={1} flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
            <Box flexDirection="row">
              <Text bold color="yellow">╔══[ </Text>
              <Text bold color="yellow">⚡ PLAN</Text>
              <Text bold color="magenta"> APPROVAL</Text>
              <Text bold color="red"> REQUIRED</Text>
              <Text bold color="yellow"> ]══╗</Text>
            </Box>
            <Text color="gray">  File: <Text bold color="cyan">{planUrl}</Text></Text>
            <Text color="gray" dimColor>  Send any message to display the plan approval dialog again.</Text>
          </Box>
        )}

        {activeWizard && activeWizard.type === "plan_approve" && (
          <PlanApprovalDialog
            planFilePath={planFilePath}
            selectedIndex={wizardSelectedIndex}
            step={activeWizard.step}
            borderColor="yellow"
            focus={props.focus}
            scrollOffset={props.scrollOffset}
            onScrollChange={props.onScrollChange}
          />
        )}

        {activeWizard && activeWizard.type === "question" && pendingQuestion && (
          <Box flexDirection="column">
            {activeWizard.questions && activeWizard.currentQuestionIndex !== undefined && (
              <Box flexDirection="row" flexWrap="wrap" marginBottom={1}>
                {activeWizard.questions.map((q, idx) => {
                  const num = idx + 1;
                  const label = getTruncatedLabel(q.question);
                  const isPassed = idx < (activeWizard.currentQuestionIndex || 0);
                  const isActive = idx === activeWizard.currentQuestionIndex;
                  if (isPassed) {
                    const ans = activeWizard.answers?.[idx] || "";
                    const displayAns = ans ? ` (${ans.length > 10 ? ans.slice(0, 8) + "..." : ans})` : "";
                    return (
                      <Box key={idx} marginRight={2}>
                        <Text color="green" dimColor>
                          [✔ {num}. {label}{displayAns}]
                        </Text>
                      </Box>
                    );
                  } else if (isActive) {
                    return (
                      <Box key={idx} marginRight={2}>
                        <Text color="cyan" bold>
                          ❯ {num}. {label}
                        </Text>
                      </Box>
                    );
                  } else {
                    return (
                      <Box key={idx} marginRight={2}>
                        <Text color="gray" dimColor>
                          ({num}. {label})
                        </Text>
                      </Box>
                    );
                  }
                })}
              </Box>
            )}
            <WizardDialog
              title={activeWizard.step === 2 ? "❓ ENTER CUSTOM ANSWER (Type and press Enter):" : (activeWizard.isMultiSelect ? "❓ QUESTION FROM AGENT (Arrows: navigate, Space: select, Enter: submit):" : "❓ QUESTION FROM AGENT (Use Arrow Keys Up/Down & Enter):")}
              description={pendingQuestion.question}
              borderColor="cyan"
              options={wizardOptions}
              selectedIndex={wizardSelectedIndex}
              isMultiSelect={activeWizard.isMultiSelect}
              selectedSet={wizardSelectedSet}
            />
          </Box>
        )}

        {activeWizard && activeWizard.type === "exit_confirm" && (
          <WizardDialog
            title="⚠️ QUIT SESSION (↑/↓ Navigate, Enter: Select, Esc: Cancel):"
            description="Are you sure you want to exit? Any running tasks or agents will be aborted."
            borderColor="red"
            options={wizardOptions}
            selectedIndex={wizardSelectedIndex}
          />
        )}

        {activeWizard && activeWizard.type === "login" && activeWizard.step === 1 && wizardOptions.length > 0 && (
          <WizardDialog
            title="🔑 PROVIDER MANAGER (↑/↓ Navigate, Enter: Select, Esc: Cancel):"
            borderColor="cyan"
            options={wizardOptions}
            selectedIndex={wizardSelectedIndex}
          />
        )}

        {activeWizard && activeWizard.type === "login" && activeWizard.step === 2 && wizardOptions.length > 0 && (
          <WizardDialog
            title="🔑 SELECT PROVIDER TEMPLATE (↑/↓ Navigate, Enter: Select, Esc: Back):"
            borderColor="cyan"
            options={wizardOptions}
            selectedIndex={wizardSelectedIndex}
          />
        )}

        {activeWizard && activeWizard.type === "login" && activeWizard.step === 3 && (
          <WizardDialog
            title="🔑 CONFIGURE PROVIDER — PROFILE NAME (Type & Enter, Esc: Back):"
            description={`Enter config profile name (e.g. ${activeWizard.data.provider || "provider name"}, deepseek, or press Enter for default):`}
            borderColor="cyan"
            options={[]}
            selectedIndex={0}
          />
        )}

        {activeWizard && activeWizard.type === "login" && activeWizard.step === 4 && (
          <WizardDialog
            title="🔑 CONFIGURE PROVIDER — BASE URL (Type & Enter, Esc: Back):"
            description="Please enter your Base URL (e.g. http://localhost:11434/v1):"
            borderColor="cyan"
            options={[]}
            selectedIndex={0}
          />
        )}

        {activeWizard && activeWizard.type === "login" && activeWizard.step === 5 && (
          <WizardDialog
            title="🔑 CONFIGURE PROVIDER — API KEY (Type & Enter, Esc: Back):"
            description="Please enter your API Key:"
            borderColor="cyan"
            options={[]}
            selectedIndex={0}
          />
        )}


        {activeWizard && activeWizard.type === "login" && activeWizard.step === 10 && wizardOptions.length > 0 && (
          <WizardDialog
            title="🛠️ PROJECT INITIALIZATION — Select Technology Stack (↑/↓ Navigate, Enter: Select, Esc: Cancel):"
            description="Choose a template catalog stack or let AI dynamically design your project details:"
            borderColor="cyan"
            options={wizardOptions}
            selectedIndex={wizardSelectedIndex}
          />
        )}

        {activeWizard && activeWizard.type === "login" && activeWizard.step === 11 && (
          <WizardDialog
            title="🛠️ PROJECT INITIALIZATION — Enter Project Name (Type & Enter, Esc: Back):"
            description="Specify the catalog name for this workspace:"
            borderColor="cyan"
            options={[]}
            selectedIndex={0}
          />
        )}

        {activeWizard && activeWizard.type === "login" && activeWizard.step === 12 && (
          <WizardDialog
            title="🛠️ PROJECT INITIALIZATION — Enter Project Description (Type & Enter, Esc: Back):"
            description="Give a one-sentence overview description of this software:"
            borderColor="cyan"
            options={[]}
            selectedIndex={0}
          />
        )}

        {activeWizard && activeWizard.type === "login" && activeWizard.step === 13 && (
          <WizardDialog
            title="🤖 AI PROJECT INITIALIZATION — Describe Project Goal (Type & Enter, Esc: Back)"
            description="State what you want to build (e.g. 'A command-line text editor in Rust'). AI will construct agents.md specs:"
            borderColor="blue"
            options={[]}
            selectedIndex={0}
          />
        )}

        {activeWizard && activeWizard.type === "login" && activeWizard.step === 6 && wizardOptions.length > 0 && (
          <WizardDialog
            title="🔌 LIST PROVIDERS — Select provider (↑/↓ Navigate, Enter: Select, Esc: Cancel):"
            description="Select a provider to continue with connection test and messaging:"
            borderColor="cyan"
            options={wizardOptions}
            selectedIndex={wizardSelectedIndex}
            maxVisible={10}
          />
        )}

        {activeWizard && activeWizard.type === "login" && activeWizard.step === 7 && wizardOptions.length > 0 && (
          <WizardDialog
            title={`🔌 CONNECTION TEST — ${activeWizard.data.providerName || "Provider"} (↑/↓ Navigate, Enter: Select):`}
            description={`Do you want to test the connection to provider "${activeWizard.data.providerName || ""}" before selecting a model?`}
            borderColor="cyan"
            options={wizardOptions}
            selectedIndex={wizardSelectedIndex}
            isLoading={wizardIsLoadingModels}
          />
        )}

        {activeWizard && activeWizard.type === "login" && activeWizard.step === 8 && wizardOptions.length > 0 && (() => {
          const modelSearchQuery = input.trim();
          const filteredModels = modelSearchQuery
            ? filterSuggestions(wizardOptions, modelSearchQuery)
            : wizardOptions;
          const clampedIndex = Math.min(wizardSelectedIndex, Math.max(0, filteredModels.length - 1));
          const provName = activeWizard.data.providerName ? ` [${activeWizard.data.providerName}]` : "";
          const searchTitle = modelSearchQuery
            ? `🔌 SELECT MODEL${provName} — 🔍 "${input.trim()}" (${filteredModels.length}/${wizardOptions.length} results):`
            : `🔌 SELECT MODEL${provName} (${wizardOptions.length} available — type to filter, ↑/↓ navigate, Enter select):`;
          return (
            <WizardDialog
              title={searchTitle}
              borderColor="cyan"
              options={filteredModels.length > 0 ? filteredModels : ["(no results)"]}
              selectedIndex={clampedIndex}
              maxVisible={10}
              isLoading={wizardIsLoadingModels}
            />
          );
        })()}

        {activeWizard && activeWizard.type === "login" && activeWizard.step === 9 && (
          <WizardDialog
            title={`🔌 SEND TEST MESSAGE — Model: ${activeWizard.data.selectedModel || ""} (Type & Enter):`}
            description={`Type a message to send to model "${activeWizard.data.selectedModel || ""}" via provider "${activeWizard.data.providerName || ""}". Press Enter to send.`}
            borderColor="cyan"
            options={[]}
            selectedIndex={0}
          />
        )}

        {activeWizard && activeWizard.type === "login" && activeWizard.step === 14 && wizardOptions.length > 0 && (() => {
          const searchQuery = input.trim();
          const filteredProviders = searchQuery
            ? filterSuggestions(wizardOptions, searchQuery)
            : wizardOptions;
          const clampedIndex = Math.min(wizardSelectedIndex, Math.max(0, filteredProviders.length - 1));
          const searchTitle = searchQuery
            ? `🗑️ DELETE PROVIDER — 🔍 "${searchQuery}" (${filteredProviders.length}/${wizardOptions.length} results, ↑/↓ Navigate, Enter: Select, Esc: Back):`
            : `🗑️ DELETE PROVIDER — ${wizardOptions.length} providers (type to filter, ↑/↓ Navigate, Enter: Select, Esc: Back):`;
          return (
            <WizardDialog
              title={searchTitle}
              description="Select a provider to permanently remove:"
              borderColor="red"
              options={filteredProviders.length > 0 ? filteredProviders : ["(no results)"]}
              selectedIndex={clampedIndex}
              maxVisible={10}
            />
          );
        })()}

        {activeWizard && activeWizard.type === "login" && activeWizard.step === 15 && wizardOptions.length > 0 && (
          <WizardDialog
            title={`🗑️ CONFIRM DELETE — "${activeWizard.data.providerName || "provider"}" (↑/↓ Navigate, Enter: Confirm):`}
            description={`Are you sure you want to permanently remove provider "${activeWizard.data.providerName || ""}"? This cannot be undone.`}
            borderColor="red"
            options={wizardOptions}
            selectedIndex={wizardSelectedIndex}
          />
        )}

        {activeWizard && activeWizard.type === "model" && activeWizard.step === 1 && wizardOptions.length > 0 && (
          <WizardDialog
            title="⚙️ SELECT AGENT TIER TO CONFIGURE (Use Arrow Keys Up/Down & Enter):"
            borderColor="cyan"
            options={wizardOptions}
            selectedIndex={wizardSelectedIndex}
          />
        )}

        {activeWizard && activeWizard.type === "model" && activeWizard.step === 2 && wizardOptions.length > 0 && (
          <WizardDialog
            title={`⚙️ SELECT PROVIDER FOR ${activeWizard.data.tier?.toUpperCase() || "MODELS"} (Use Arrow Keys Up/Down & Enter):`}
            borderColor="cyan"
            options={wizardOptions}
            selectedIndex={wizardSelectedIndex}
          />
        )}

        {activeWizard && activeWizard.type === "model" && activeWizard.step === 3 && wizardOptions.length > 0 && (() => {
          const searchQuery = input.trim();
          const filteredOptions = searchQuery
            ? filterSuggestions(wizardOptions, searchQuery)
            : wizardOptions;
          const clampedIndex = Math.min(wizardSelectedIndex, Math.max(0, filteredOptions.length - 1));
          const searchTitle = searchQuery
            ? `⚙️ SELECT PROFILE FOR ${activeWizard.data.tier?.toUpperCase() || "MODELS"} — 🔍 "${input.trim()}" (${filteredOptions.length}/${wizardOptions.length} results):`
            : `⚙️ SELECT PROFILE FOR ${activeWizard.data.tier?.toUpperCase() || "MODELS"} (${wizardOptions.length} profiles — type to filter, ↑/↓ navigate, Enter select):`;
          return (
            <WizardDialog
              title={searchTitle}
              borderColor="cyan"
              options={filteredOptions.length > 0 ? filteredOptions : ["(no results)"]}
              selectedIndex={clampedIndex}
              maxVisible={10}
            />
          );
        })()}

        {activeWizard && activeWizard.type === "model" && activeWizard.step === 6 && (
          <WizardDialog
            title="⚙️ CONFIGURE PROVIDER — PROFILE NAME (Type & Enter):"
            description={`Enter config profile name (e.g. ${activeWizard.data.providerType || "provider name"}, deepseek, or press Enter for default):`}
            borderColor="cyan"
            options={[]}
            selectedIndex={0}
          />
        )}

        {activeWizard && activeWizard.type === "model" && activeWizard.step === 7 && (
          <WizardDialog
            title="⚙️ CONFIGURE PROVIDER — BASE URL (Type & Enter):"
            description="Please enter your Base URL (e.g. http://localhost:11434/v1):"
            borderColor="cyan"
            options={[]}
            selectedIndex={0}
          />
        )}

        {activeWizard && activeWizard.type === "model" && activeWizard.step === 8 && (
          <WizardDialog
            title="⚙️ CONFIGURE PROVIDER — API KEY (Type & Enter):"
            description="Please enter your API Key:"
            borderColor="cyan"
            options={[]}
            selectedIndex={0}
          />
        )}

        {activeWizard && activeWizard.type === "model" && activeWizard.step === 16 && (
          <WizardDialog
            title="⚙️ CONFIGURE PROVIDER — PROFILE NAME (Type & Enter):"
            description={`Enter config profile name (e.g. ${activeWizard.data.providerType || "provider name"}, deepseek, or press Enter for default):`}
            borderColor="cyan"
            options={[]}
            selectedIndex={0}
          />
        )}

        {activeWizard && activeWizard.type === "model" && activeWizard.step === 17 && (
          <WizardDialog
            title="⚙️ CONFIGURE PROVIDER — BASE URL (Type & Enter):"
            description="Please enter your Base URL (e.g. http://localhost:11434/v1):"
            borderColor="cyan"
            options={[]}
            selectedIndex={0}
          />
        )}

        {activeWizard && activeWizard.type === "model" && activeWizard.step === 18 && (
          <WizardDialog
            title="⚙️ CONFIGURE PROVIDER — API KEY (Type & Enter):"
            description="Please enter your API Key:"
            borderColor="cyan"
            options={[]}
            selectedIndex={0}
          />
        )}

        {activeWizard && activeWizard.type === "model" && activeWizard.step === 15 && wizardOptions.length > 0 && (() => {
          const modelSearchQuery = input.trim();
          const filteredModels = modelSearchQuery
            ? filterSuggestions(wizardOptions, modelSearchQuery)
            : wizardOptions;
          const clampedIndex = Math.min(wizardSelectedIndex, Math.max(0, filteredModels.length - 1));
          const tierStr = activeWizard.data.tier ? ` FOR ${activeWizard.data.tier.toUpperCase()}` : "";
          const provStr = activeWizard.data.provider ? ` VIA ${activeWizard.data.provider.toUpperCase()}` : "";
          const searchTitle = modelSearchQuery
            ? `⚙️ SELECT MODEL${tierStr}${provStr} — 🔍 "${input.trim()}" (${filteredModels.length}/${wizardOptions.length} results):`
            : `⚙️ SELECT MODEL${tierStr}${provStr} (${wizardOptions.length} available — type to filter, ↑/↓ navigate, Enter select):`;
          return (
            <WizardDialog
              title={searchTitle}
              borderColor="cyan"
              options={filteredModels.length > 0 ? filteredModels : ["(no results)"]}
              selectedIndex={clampedIndex}
              maxVisible={10}
              isLoading={wizardIsLoadingModels}
            />
          );
        })()}

        {activeWizard && activeWizard.type === "model" && activeWizard.step === 4 && wizardOptions.length > 0 && (() => {
          const searchQuery = input.trim();
          const filteredOptions = searchQuery
            ? filterSuggestions(wizardOptions, searchQuery)
            : wizardOptions;
          const clampedIndex = Math.min(wizardSelectedIndex, Math.max(0, filteredOptions.length - 1));
          const searchTitle = searchQuery
            ? `⚙️ APPLY MODEL PRESET — 🔍 "${input.trim()}" (${filteredOptions.length}/${wizardOptions.length} results):`
            : `⚙️ APPLY MODEL PRESET (${wizardOptions.length} presets — type to filter, ↑/↓ navigate, Enter select):`;
          return (
            <WizardDialog
              title={searchTitle}
              borderColor="cyan"
              options={filteredOptions.length > 0 ? filteredOptions : ["(no results)"]}
              selectedIndex={clampedIndex}
              maxVisible={10}
            />
          );
        })()}

        {activeWizard && activeWizard.type === "model" && activeWizard.step === 20 && (
          <WizardDialog
            title="📝 CREATE MODEL PRESET — Enter Preset Name:"
            description="Choose a unique name for this preset (built-in names cannot be overwritten)."
            borderColor="cyan"
            options={[]}
            selectedIndex={0}
          />
        )}

        {activeWizard && activeWizard.type === "model" && activeWizard.step === 21 && (
          <WizardDialog
            title="📝 CREATE MODEL PRESET — Enter Description:"
            description="Provide a short description of this model configuration preset."
            borderColor="cyan"
            options={[]}
            selectedIndex={0}
          />
        )}

        {activeWizard && activeWizard.type === "model" && activeWizard.step === 30 && wizardOptions.length > 0 && (() => {
          const searchQuery = input.trim();
          const filteredOptions = searchQuery
            ? filterSuggestions(wizardOptions, searchQuery)
            : wizardOptions;
          const clampedIndex = Math.min(wizardSelectedIndex, Math.max(0, filteredOptions.length - 1));
          const searchTitle = searchQuery
            ? `📝 EDIT MODEL PRESET — Select Preset to Edit — 🔍 "${input.trim()}" (${filteredOptions.length}/${wizardOptions.length} results):`
            : `📝 EDIT MODEL PRESET — Select Preset to Edit (${wizardOptions.length} presets — type to filter, ↑/↓ navigate, Enter select):`;
          return (
            <WizardDialog
              title={searchTitle}
              borderColor="cyan"
              options={filteredOptions.length > 0 ? filteredOptions : ["(no results)"]}
              selectedIndex={clampedIndex}
              maxVisible={10}
            />
          );
        })()}

        {activeWizard && activeWizard.type === "model" && activeWizard.step === 31 && (
          <WizardDialog
            title="📝 EDIT MODEL PRESET — Enter New Description:"
            description="Enter a new description (or press Enter to keep current):"
            borderColor="cyan"
            options={[]}
            selectedIndex={0}
          />
        )}

        {activeWizard && activeWizard.type === "model" && activeWizard.step === 22 && wizardOptions.length > 0 && (
          <WizardDialog
            title="📝 CREATE MODEL PRESET — Configure Tiers:"
            description="Select agent tiers to configure provider and model, then choose 'Save Preset & Exit' when done."
            borderColor="cyan"
            options={wizardOptions}
            selectedIndex={wizardSelectedIndex}
          />
        )}

        {activeWizard && activeWizard.type === "model" && activeWizard.step === 23 && wizardOptions.length > 0 && (
          <WizardDialog
            title={`📝 CREATE MODEL PRESET — Select Provider for ${activeWizard.data.tier?.toUpperCase() || "Tiers"}:`}
            description="Choose a provider template (or select '< Back' to return):"
            borderColor="cyan"
            options={wizardOptions}
            selectedIndex={wizardSelectedIndex}
          />
        )}

        {activeWizard && activeWizard.type === "model" && activeWizard.step === 25 && wizardOptions.length > 0 && (() => {
          const searchQuery = input.trim();
          const filteredOptions = searchQuery
            ? filterSuggestions(wizardOptions, searchQuery)
            : wizardOptions;
          const clampedIndex = Math.min(wizardSelectedIndex, Math.max(0, filteredOptions.length - 1));
          const searchTitle = searchQuery
            ? `📝 CREATE MODEL PRESET — Select Profile for ${activeWizard.data.tier?.toUpperCase() || "Tiers"} — 🔍 "${input.trim()}" (${filteredOptions.length}/${wizardOptions.length} results):`
            : `📝 CREATE MODEL PRESET — Select Profile for ${activeWizard.data.tier?.toUpperCase() || "Tiers"} (${wizardOptions.length} profiles — type to filter, ↑/↓ navigate, Enter select):`;
          return (
            <WizardDialog
              title={searchTitle}
              description="Choose a credential profile (or select '< Back' to return):"
              borderColor="cyan"
              options={filteredOptions.length > 0 ? filteredOptions : ["(no results)"]}
              selectedIndex={clampedIndex}
              maxVisible={10}
            />
          );
        })()}

        {activeWizard && activeWizard.type === "model" && activeWizard.step === 24 && wizardOptions.length > 0 && (() => {
          const modelSearchQuery = input.trim();
          const filteredModels = modelSearchQuery
            ? filterSuggestions(wizardOptions, modelSearchQuery)
            : wizardOptions;
          const clampedIndex = Math.min(wizardSelectedIndex, Math.max(0, filteredModels.length - 1));
          const tierStr = activeWizard.data.tier ? ` for ${activeWizard.data.tier.toUpperCase()}` : "";
          const provStr = activeWizard.data.provider ? ` via ${activeWizard.data.provider.toUpperCase()}` : "";
          const searchTitle = modelSearchQuery
            ? `📝 CREATE MODEL PRESET — Select Model${tierStr}${provStr} — 🔍 "${input.trim()}" (${filteredModels.length}/${wizardOptions.length} results):`
            : `📝 CREATE MODEL PRESET — Select Model${tierStr}${provStr} (${wizardOptions.length} available — type to filter, ↑/↓ navigate, Enter select):`;
          return (
            <WizardDialog
              title={searchTitle}
              borderColor="cyan"
              options={filteredModels.length > 0 ? filteredModels : ["(no results)"]}
              selectedIndex={clampedIndex}
              maxVisible={10}
              isLoading={wizardIsLoadingModels}
            />
          );
        })()}

        {activeWizard && activeWizard.type === "model" && activeWizard.step === 32 && wizardOptions.length > 0 && (
          <WizardDialog
            title="📝 EDIT MODEL PRESET — Configure Tiers:"
            description="Select agent tiers to configure provider and model, then choose 'Save Preset & Exit' when done."
            borderColor="cyan"
            options={wizardOptions}
            selectedIndex={wizardSelectedIndex}
          />
        )}

        {activeWizard && activeWizard.type === "model" && activeWizard.step === 33 && wizardOptions.length > 0 && (
          <WizardDialog
            title={`📝 EDIT MODEL PRESET — Select Provider for ${activeWizard.data.tier?.toUpperCase() || "Tiers"}:`}
            description="Choose a provider template (or select '< Back' to return):"
            borderColor="cyan"
            options={wizardOptions}
            selectedIndex={wizardSelectedIndex}
          />
        )}

        {activeWizard && activeWizard.type === "model" && activeWizard.step === 35 && wizardOptions.length > 0 && (() => {
          const searchQuery = input.trim();
          const filteredOptions = searchQuery
            ? filterSuggestions(wizardOptions, searchQuery)
            : wizardOptions;
          const clampedIndex = Math.min(wizardSelectedIndex, Math.max(0, filteredOptions.length - 1));
          const searchTitle = searchQuery
            ? `📝 EDIT MODEL PRESET — Select Profile for ${activeWizard.data.tier?.toUpperCase() || "Tiers"} — 🔍 "${input.trim()}" (${filteredOptions.length}/${wizardOptions.length} results):`
            : `📝 EDIT MODEL PRESET — Select Profile for ${activeWizard.data.tier?.toUpperCase() || "Tiers"} (${wizardOptions.length} profiles — type to filter, ↑/↓ navigate, Enter select):`;
          return (
            <WizardDialog
              title={searchTitle}
              description="Choose a credential profile (or select '< Back' to return):"
              borderColor="cyan"
              options={filteredOptions.length > 0 ? filteredOptions : ["(no results)"]}
              selectedIndex={clampedIndex}
              maxVisible={10}
            />
          );
        })()}

        {activeWizard && activeWizard.type === "model" && activeWizard.step === 34 && wizardOptions.length > 0 && (() => {
          const modelSearchQuery = input.trim();
          const filteredModels = modelSearchQuery
            ? filterSuggestions(wizardOptions, modelSearchQuery)
            : wizardOptions;
          const clampedIndex = Math.min(wizardSelectedIndex, Math.max(0, filteredModels.length - 1));
          const tierStr = activeWizard.data.tier ? ` for ${activeWizard.data.tier.toUpperCase()}` : "";
          const provStr = activeWizard.data.provider ? ` via ${activeWizard.data.provider.toUpperCase()}` : "";
          const searchTitle = modelSearchQuery
            ? `📝 EDIT MODEL PRESET — Select Model${tierStr}${provStr} — 🔍 "${input.trim()}" (${filteredModels.length}/${wizardOptions.length} results):`
            : `📝 EDIT MODEL PRESET — Select Model${tierStr}${provStr} (${wizardOptions.length} available — type to filter, ↑/↓ navigate, Enter select):`;
          return (
            <WizardDialog
              title={searchTitle}
              borderColor="cyan"
              options={filteredModels.length > 0 ? filteredModels : ["(no results)"]}
              selectedIndex={clampedIndex}
              maxVisible={10}
              isLoading={wizardIsLoadingModels}
            />
          );
        })()}

        {activeWizard && activeWizard.type === "model" && activeWizard.step === 40 && wizardOptions.length > 0 && (() => {
          const searchQuery = input.trim();
          const filteredOptions = searchQuery
            ? filterSuggestions(wizardOptions, searchQuery)
            : wizardOptions;
          const clampedIndex = Math.min(wizardSelectedIndex, Math.max(0, filteredOptions.length - 1));
          const searchTitle = searchQuery
            ? `❌ DELETE MODEL PRESET — Select Preset to Delete — 🔍 "${input.trim()}" (${filteredOptions.length}/${wizardOptions.length} results):`
            : `❌ DELETE MODEL PRESET — Select Preset to Delete (${wizardOptions.length} presets — type to filter, ↑/↓ navigate, Enter select):`;
          return (
            <WizardDialog
              title={searchTitle}
              borderColor="cyan"
              options={filteredOptions.length > 0 ? filteredOptions : ["(no results)"]}
              selectedIndex={clampedIndex}
              maxVisible={10}
            />
          );
        })()}

        {activeWizard && activeWizard.type === "model" && activeWizard.step === 41 && wizardOptions.length > 0 && (
          <WizardDialog
            title="❌ DELETE MODEL PRESET — Are you sure?"
            description={`This will permanently delete custom preset "${activeWizard.data.presetName || ""}". This action cannot be undone.`}
            borderColor="red"
            options={wizardOptions}
            selectedIndex={wizardSelectedIndex}
          />
        )}

        {activeWizard && activeWizard.type === "model" && activeWizard.step === 50 && wizardOptions.length > 0 && (
          <WizardDialog
            title="⚙️ CONFIGURE ACTIVE AGENT TIER MODELS (Use Arrow Keys Up/Down & Enter):"
            borderColor="cyan"
            options={wizardOptions}
            selectedIndex={wizardSelectedIndex}
          />
        )}

        {activeWizard && activeWizard.type === "resume" && wizardOptions.length > 0 && (
          <WizardDialog
            title="📚 RESUME SESSION — Select session to resume (↑/↓ Navigate, Enter: Load, Esc: Cancel):"
            description="Sessions sorted by most recent:"
            borderColor="blue"
            options={wizardOptions}
            selectedIndex={wizardSelectedIndex}
            maxVisible={10}
          />
        )}

        {activeWizard && activeWizard.type === "skills" && wizardOptions.length > 0 && (() => {
          const installedSkills = getInstalledSkills();
          
          if (activeWizard.step === 2) {
            const chosenSkill = installedSkills[parseInt(activeWizard.data.skillIndex || "0", 10)];
            const skillTitle = `📂 SKILL ACTION — Select action for skill: "${chosenSkill?.name || ""}" (↑/↓ Navigate, Enter: Select):`;
            const skillDesc = "Choose whether to activate this skill for the agent or view its location details:";
            return (
              <WizardDialog
                title={skillTitle}
                description={skillDesc}
                borderColor="cyan"
                options={wizardOptions}
                selectedIndex={wizardSelectedIndex}
                maxVisible={10}
              />
            );
          } else {
            const searchQuery = input.trim();
            const filteredOptions = searchQuery
              ? filterSuggestions(wizardOptions, searchQuery)
              : wizardOptions;
            const clampedIndex = Math.min(wizardSelectedIndex, Math.max(0, filteredOptions.length - 1));
            
            const skillTitle = searchQuery
              ? `📂 INSTALLED AGENT SKILLS — 🔍 "${searchQuery}" (${filteredOptions.length}/${wizardOptions.length} results):`
              : "📂 INSTALLED AGENT SKILLS — Select skill (type to filter, ↑/↓ Navigate, Enter: Choose, Esc: Cancel):";
            const skillDesc = "List of installed agent capabilities:";
            
            return (
              <WizardDialog
                title={skillTitle}
                description={skillDesc}
                borderColor="cyan"
                options={filteredOptions.length > 0 ? filteredOptions : ["(no results)"]}
                selectedIndex={clampedIndex}
                maxVisible={10}
              />
            );
          }
        })()}

        {activeWizard && activeWizard.type === "checkpoint" && activeWizard.step === 1 && wizardOptions.length > 0 && (
          <WizardDialog
            title="📌 CHECKPOINT — Select checkpoint to restore (↑/↓ Navigate, Enter: Restore, Esc: Cancel):"
            description="Checkpoints sorted by most recent:"
            borderColor="green"
            options={wizardOptions}
            selectedIndex={wizardSelectedIndex}
            maxVisible={10}
          />
        )}

        {activeWizard && activeWizard.type === "checkpoint" && activeWizard.step === 2 && wizardOptions.length > 0 && (
          <WizardDialog
            title="📌 RESTORE WORKSPACE — Restore workspace code to Git commit checkpoint? (↑/↓ Navigate, Enter: Select):"
            description={`Git commit: ${checkpointsList[parseInt(activeWizard.data.checkpointIndex || "0", 10)]?.gitSha || "unknown"}`}
            borderColor="yellow"
            options={wizardOptions}
            selectedIndex={wizardSelectedIndex}
          />
        )}

        {activeWizard && activeWizard.type === "goal" && activeWizard.step === 1 && (
          <WizardDialog
            title="🎯 GOAL MODE — Describe the goal to achieve (Type & Enter):"
            description="Agent will work continuously until the goal is reached. Use Ctrl+C to cancel."
            borderColor="yellow"
            options={[]}
            selectedIndex={0}
          />
        )}

        {/* Goal Mode Banner */}
        {goalMode && !activeWizard && (
          <Box marginBottom={1} flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
            <Text bold color="yellow">🎯 GOAL MODE ACTIVE ─────────────────────────────────────</Text>
            <Text color="yellow">  Target: <Text bold color="white">{goalMode.goal.length > 80 ? goalMode.goal.slice(0, 77) + "..." : goalMode.goal}</Text></Text>
            <Text color="yellow" dimColor>  Running... (Ctrl+C to abort)</Text>
          </Box>
        )}

        {/* Render suggestions inline above the input line */}
        {!activeWizard && input.startsWith("/") && suggestions.length > 0 && (() => {
          const MAX_VISIBLE_SUGGESTIONS = 5;
          let visibleSuggestions: string[] = [];
          let hasMoreSuffix = false;
          let hasMorePrefix = false;
          let remainingCount = 0;

          if (suggestions.length <= MAX_VISIBLE_SUGGESTIONS) {
            visibleSuggestions = suggestions;
          } else {
            const selectedIndex = suggestions.indexOf(input);
            if (selectedIndex === -1 || selectedIndex < MAX_VISIBLE_SUGGESTIONS - 1) {
              visibleSuggestions = suggestions.slice(0, MAX_VISIBLE_SUGGESTIONS - 1);
              hasMoreSuffix = true;
              remainingCount = suggestions.length - visibleSuggestions.length;
            } else {
              visibleSuggestions = [
                suggestions[0],
                suggestions[selectedIndex - 1],
                suggestions[selectedIndex],
              ];
              if (selectedIndex + 1 < suggestions.length) {
                visibleSuggestions.push(suggestions[selectedIndex + 1]);
              }
              hasMorePrefix = true;
              hasMoreSuffix = selectedIndex + 2 < suggestions.length;
              remainingCount = suggestions.length - visibleSuggestions.length;
            }
          }

          return (
            <Box marginBottom={1} flexDirection="row">
              <Text dimColor>Suggestions: </Text>
              {hasMorePrefix && (
                <>
                  <Box marginRight={2}>
                    <Text color={input === suggestions[0] ? "cyan" : "gray"} bold={input === suggestions[0]} underline={input === suggestions[0]}>
                      {suggestions[0]}
                    </Text>
                  </Box>
                  <Box marginRight={2}>
                    <Text dimColor>...</Text>
                  </Box>
                </>
              )}
              {visibleSuggestions.map((s, idx) => {
                if (hasMorePrefix && idx === 0) return null;
                const isSelected = input === s;
                return (
                  <Box key={s} marginRight={2}>
                    <Text color={isSelected ? "cyan" : "gray"} bold={isSelected} underline={isSelected}>
                      {s}
                    </Text>
                  </Box>
                );
              })}
              {hasMoreSuffix && (
                <Box marginRight={2}>
                  <Text dimColor>... (+{remainingCount} more)</Text>
                </Box>
              )}
            </Box>
          );
        })()}
      </Box>
    </>
  );
});
