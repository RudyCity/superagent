import React from "react";
import { Box, Text } from "ink";
import path from "path";
import { filterSuggestions } from "../../utils/text.js";
import { WizardDialog } from "../wizard-dialog.js";
import { PlanApprovalDialog } from "../plan-approval-dialog.js";

interface DashboardWizardProps {
  activeWizard: any;
  query: string;
  wizardAllOptions: string[];
  wizardSelectedIndex: number;
  wizardIsLoadingModels: boolean;
  wizardOptions: string[];
  wizardSelectedSet: Set<number>;
  pendingQuestion: any;
  agent: any;
  terminalWidth: number;
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

export function DashboardWizard({
  activeWizard,
  query,
  wizardAllOptions,
  wizardSelectedIndex,
  wizardIsLoadingModels,
  wizardOptions,
  wizardSelectedSet,
  pendingQuestion,
  agent,
  terminalWidth,
  focus,
  scrollOffset,
  onScrollChange,
}: DashboardWizardProps) {
  if (!activeWizard) {
    return null;
  }

  const wizardBorderColor = "cyan";

  return (
    <Box flexDirection="column" paddingX={1} marginY={0} width="100%">
      <Box flexDirection="row" marginTop={0}>
        <Text color={wizardBorderColor}>│</Text>
      </Box>
      {/* Model step 3, 24, 34: split out to handle query-based filtering like single agent */}
      {activeWizard.type === "model" && (activeWizard.step === 3 || activeWizard.step === 4 || activeWizard.step === 15 || activeWizard.step === 24 || activeWizard.step === 25 || activeWizard.step === 30 || activeWizard.step === 34 || activeWizard.step === 35 || activeWizard.step === 40) && (() => {
        const lc = query.trim();
        const filtered = lc
          ? filterSuggestions(wizardAllOptions, lc)
          : wizardAllOptions;
        const clampedIndex = Math.min(wizardSelectedIndex, Math.max(0, filtered.length - 1));
        const tierStr = activeWizard.data.tier ? ` FOR ${activeWizard.data.tier.toUpperCase()}` : "";
        const provStr = activeWizard.data.provider ? ` VIA ${activeWizard.data.provider.toUpperCase()}` : "";
        
        let searchTitle = "";
        let description = undefined;
        let maxVis = 10;
        
        if (activeWizard.step === 15 || activeWizard.step === 24 || activeWizard.step === 34) {
          searchTitle = wizardIsLoadingModels
            ? `⚙️ SELECT MODEL${tierStr}${provStr} — ⏳ loading...`
            : lc
              ? `⚙️ SELECT MODEL${tierStr}${provStr} — 🔍 "${query.trim()}" (${filtered.length}/${wizardAllOptions.length} results):`
              : `⚙️ SELECT MODEL${tierStr}${provStr} (${wizardAllOptions.length} available — type to filter, ↑/↓ navigate, Enter select):`;
          maxVis = 8;
        } else if (activeWizard.step === 4 || activeWizard.step === 30 || activeWizard.step === 40) {
          const prefix = activeWizard.step === 4 ? "⚙️ APPLY MODEL PRESET" : activeWizard.step === 30 ? "📝 EDIT MODEL PRESET — Select Preset to Edit" : "❌ DELETE MODEL PRESET — Select Preset to Delete";
          searchTitle = lc
            ? `${prefix} — 🔍 "${query.trim()}" (${filtered.length}/${wizardAllOptions.length} results):`
            : `${prefix} (${wizardAllOptions.length} presets — type to filter, ↑/↓ navigate, Enter select):`;
          maxVis = 10;
        } else {
          // step 3, 25, 35 (Select Profile)
          const prefix = activeWizard.step === 3 ? "⚙️ SELECT PROFILE" : activeWizard.step === 25 ? "📝 CREATE MODEL PRESET — Select Profile" : "📝 EDIT MODEL PRESET — Select Profile";
          searchTitle = lc
            ? `${prefix} FOR ${activeWizard.data.tier?.toUpperCase() || "Tiers"} — 🔍 "${query.trim()}" (${filtered.length}/${wizardAllOptions.length} results):`
            : `${prefix} FOR ${activeWizard.data.tier?.toUpperCase() || "Tiers"} (${wizardAllOptions.length} profiles — type to filter, ↑/↓ navigate, Enter select):`;
          if (activeWizard.step === 25 || activeWizard.step === 35) {
            description = "Choose a credential profile (or select '< Back' to return):";
          }
        }
        
        return (
          <WizardDialog
            title={searchTitle}
            description={description}
            borderColor={wizardBorderColor}
            options={filtered.length > 0 ? filtered : ["(no results — try different search)"]}
            selectedIndex={clampedIndex}
            maxVisible={maxVis}
            marginY={0}
            isLoading={wizardIsLoadingModels}
            terminalWidth={terminalWidth}
          />
        );
      })()}

      {/* Plan approval — uses dedicated dialog with scrollable plan content */}
      {activeWizard.type === "plan_approve" && (
        <>
          <PlanApprovalDialog
            planFilePath={agent ? path.resolve(agent.getPlanFilePath()) : ""}
            selectedIndex={wizardSelectedIndex}
            step={activeWizard.step}
            borderColor="yellow"
            terminalWidth={terminalWidth}
            maxContentHeight={10}
            focus={focus}
            scrollOffset={scrollOffset}
            onScrollChange={onScrollChange}
          />
        </>
      )}

      {/* Workspace Manager step 1 — filtered by query */}
      {activeWizard.type === "workspace" && activeWizard.step === 1 && (() => {
        const lc = query.trim();
        const filtered = lc
          ? filterSuggestions(wizardOptions, lc)
          : wizardOptions;
        const clampedIndex = Math.min(wizardSelectedIndex, Math.max(0, filtered.length - 1));
        const searchTitle = lc
          ? `📁 SELECT WORKSPACE — 🔍 "${query.trim()}" (${filtered.length}/${wizardOptions.length} results):`
          : `📁 SELECT WORKSPACE (type to filter, ↑/↓ navigate, Enter select):`;
        
        return (
          <WizardDialog
            title={searchTitle}
            description="Select a registered workspace directory to switch to, or choose to add a new one:"
            borderColor={wizardBorderColor}
            options={filtered.length > 0 ? filtered : ["(no results)"]}
            selectedIndex={clampedIndex}
            maxVisible={10}
            terminalWidth={terminalWidth}
          />
        );
      })()}

      {/* All other wizard types (not model search, not plan_approve, not workspace step 1) */}
      {(activeWizard.type !== "model" || (activeWizard.step !== 3 && activeWizard.step !== 4 && activeWizard.step !== 15 && activeWizard.step !== 24 && activeWizard.step !== 25 && activeWizard.step !== 30 && activeWizard.step !== 34 && activeWizard.step !== 35 && activeWizard.step !== 40)) && activeWizard.type !== "plan_approve" && (activeWizard.type !== "workspace" || activeWizard.step !== 1) && (
        <Box flexDirection="column">
          {activeWizard.type === "question" && activeWizard.questions && activeWizard.currentQuestionIndex !== undefined && (
            <Box flexDirection="row" flexWrap="wrap" marginBottom={1}>
              {activeWizard.questions.map((q: any, idx: number) => {
                const num = idx + 1;
                const label = getTruncatedLabel(q.question);
                const isPassed = idx < (activeWizard.currentQuestionIndex || 0);
                const isActive = idx === activeWizard.currentQuestionIndex;
                if (isPassed) {
                  const ans = activeWizard.answers?.[idx] || "";
                  const displayAns = ans ? ` (${ans.length > 10 ? ans.slice(0, 8) + "..." : ans})` : "";
                  return (
                    <Box key={idx} marginRight={2}>
                      <Text color="gray" dimColor>
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
            title={
              activeWizard.type === "model" && activeWizard.step === 1 ? `⚙️ SELECT AGENT TIER TO CONFIGURE:` :
              activeWizard.type === "model" && activeWizard.step === 2 ? `⚙️ SELECT MODEL PROVIDER FOR ${activeWizard.data.tier?.toUpperCase() || "MODELS"}:` :
              activeWizard.type === "model" && activeWizard.step === 20 ? `⚙️ CREATE MODEL PRESET — ENTER PRESET NAME:` :
              activeWizard.type === "model" && activeWizard.step === 21 ? `⚙️ CREATE MODEL PRESET — ENTER DESCRIPTION:` :
              activeWizard.type === "model" && activeWizard.step === 22 ? `⚙️ CREATE MODEL PRESET — SELECT AGENT TIER TO CONFIGURE:` :
              activeWizard.type === "model" && activeWizard.step === 23 ? `⚙️ CREATE MODEL PRESET — SELECT MODEL PROVIDER FOR ${activeWizard.data.tier?.toUpperCase()}:` :
              activeWizard.type === "model" && activeWizard.step === 31 ? `⚙️ EDIT MODEL PRESET — ENTER NEW DESCRIPTION:` :
              activeWizard.type === "model" && activeWizard.step === 32 ? `⚙️ EDIT MODEL PRESET — SELECT AGENT TIER TO CONFIGURE:` :
               activeWizard.type === "model" && activeWizard.step === 33 ? `⚙️ EDIT MODEL PRESET — SELECT MODEL PROVIDER FOR ${activeWizard.data.tier?.toUpperCase()}:` :
              activeWizard.type === "model" && activeWizard.step === 41 ? `⚙️ DELETE MODEL PRESET — CONFIRM DELETION:` :
              activeWizard.type === "model" && activeWizard.step === 50 ? `⚙️ CONFIGURE AGENT TIERS — SELECT TIER TO CONFIGURE:` :
              activeWizard.type === "model" && [60, 61, 62].includes(activeWizard.step) ? `📷 VISION CAPABILITY SETUP:` :
              activeWizard.type === "model" && activeWizard.step === 16 ? `⚙️ CONFIGURE PROVIDER — PROFILE NAME (Type & Enter):` :
              activeWizard.type === "model" && activeWizard.step === 17 ? `⚙️ CONFIGURE PROVIDER — BASE URL (Type & Enter):` :
              activeWizard.type === "model" && activeWizard.step === 18 ? `⚙️ CONFIGURE PROVIDER — API KEY (Type & Enter):` :
              activeWizard.type === "workspace" && activeWizard.step === 1 ? "📁 SELECT WORKSPACE DIRECTORY:" :
              activeWizard.type === "workspace" && activeWizard.step === 2 ? "📁 ADD NEW WORKSPACE — ENTER DIRECTORY PATH:" :
              activeWizard.type === "resume" ? `📁 SELECT SESSION TO RESUME:` :
              activeWizard.type === "skills" ? `🛠️ SKILLS MANAGER (Step ${activeWizard.step}):` :
              activeWizard.type === "checkpoint" ? `📋 CHECKPOINT MANAGER (Step ${activeWizard.step}):` :
              activeWizard.type === "plan_approve" ? `⚠️ PLAN APPROVAL REQUIRED (Use Arrow Keys Up/Down & Enter):` :
              activeWizard.type === "question" ? (
                activeWizard.step === 2
                  ? "❓ ENTER CUSTOM ANSWER (Type and press Enter):"
                  : (activeWizard.isMultiSelect
                      ? "❓ QUESTION FROM AGENT (Arrows: navigate, Space: select, Enter: submit):"
                      : "❓ QUESTION FROM AGENT (Use Arrow Keys Up/Down & Enter):")
              ) :
              activeWizard.type === "login" && activeWizard.step === 1 ? "🔑 PROVIDER MANAGER (↑/↓ Navigate, Enter: Select, Esc: Cancel):" :
              activeWizard.type === "login" && activeWizard.step === 2 ? "🔑 SELECT PROVIDER TEMPLATE (↑/↓ Navigate, Enter: Select, Esc: Back):" :
              activeWizard.type === "login" && activeWizard.step === 3 ? "🔑 CONFIGURE PROVIDER — PROFILE NAME (Type & Enter, Esc: Back):" :
              activeWizard.type === "login" && activeWizard.step === 4 ? "🔑 CONFIGURE PROVIDER — BASE URL (Type & Enter, Esc: Back):" :
              activeWizard.type === "login" && activeWizard.step === 5 ? "🔑 CONFIGURE PROVIDER — API KEY (Type & Enter, Esc: Back):" :
              activeWizard.type === "login" && activeWizard.step === 6 ? "🔌 LIST PROVIDERS — Select Provider (↑/↓ Navigate, Enter: Select, Esc: Cancel):" :
              activeWizard.type === "login" && activeWizard.step === 7 ? "🔌 CONNECTION TEST — Confirm (↑/↓ Navigate, Enter: Select):" :
              activeWizard.type === "login" && activeWizard.step === 8 ? "🔌 SELECT MODEL (↑/↓ Navigate, type to filter, Enter: Select):" :
              activeWizard.type === "login" && activeWizard.step === 9 ? "🔌 SEND TEST MESSAGE (Type & Enter):" :
              activeWizard.type === "login" && activeWizard.step === 10 ? "🛠️ PROJECT INITIALIZATION — Select Technology Stack (↑/↓ Navigate, Enter: Select, Esc: Cancel):" :
              activeWizard.type === "login" && activeWizard.step === 11 ? "🛠️ PROJECT INITIALIZATION — Enter Project Name (Type & Enter, Esc: Back):" :
              activeWizard.type === "login" && activeWizard.step === 12 ? "🛠️ PROJECT INITIALIZATION — Enter Project Description (Type & Enter, Esc: Back):" :
              activeWizard.type === "login" && activeWizard.step === 13 ? "🤖 AI PROJECT INITIALIZATION — Describe Project Goal (Type & Enter, Esc: Back):" :
              activeWizard.type === "login" && activeWizard.step === 14 ? `🗑️ DELETE PROVIDER — ${wizardOptions.length} providers (type to filter, ↑/↓ Navigate, Enter: Select, Esc: Back):` :
              activeWizard.type === "login" && activeWizard.step === 15 ? `🗑️ CONFIRM DELETE — "${activeWizard.data.providerName || "provider"}" (↑/↓ Navigate, Enter: Confirm, Esc: Back):` :
              `🔑 PROVIDER CREDENTIALS (Step ${activeWizard.step}):`
            }
            description={
              activeWizard.type === "plan_approve" ? `AI model has designed a plan in file: file:///${path.resolve(agent.getPlanFilePath()).replace(/\\/g, "/")}` :
              activeWizard.type === "question" ? (pendingQuestion?.question || "") :
              activeWizard.type === "workspace" && activeWizard.step === 1 ? "Select a registered workspace directory to switch to, or choose to add a new one:" :
              activeWizard.type === "workspace" && activeWizard.step === 2 ? "Type the directory path (absolute or relative to current workspace) and press Enter:" :
              activeWizard.type === "model" && activeWizard.step === 20 ? "Give a unique name for your custom model configuration preset (type name and press Enter, or type 'back' to go back):" :
              activeWizard.type === "model" && activeWizard.step === 21 ? "Enter a helpful description for what this preset is designed for (type description and press Enter, or type 'back' to go back):" :
              activeWizard.type === "model" && activeWizard.step === 31 ? "Update the description for this custom preset (type description and press Enter, or type 'back' to go back):" :
              activeWizard.type === "model" && (activeWizard.step === 22 || activeWizard.step === 32) ? "Configure the models for each agent tier, then select Save Preset when finished:" :
              activeWizard.type === "model" && activeWizard.step === 16 ? `Enter config profile name (e.g. ${activeWizard.data.providerType || "provider name"}, deepseek, or press Enter for default):` :
              activeWizard.type === "model" && activeWizard.step === 17 ? "Please enter your Base URL (e.g. http://localhost:11434/v1):" :
              activeWizard.type === "model" && activeWizard.step === 18 ? "Please enter your API Key:" :
              activeWizard.type === "login" && activeWizard.step === 3 ? `Enter config profile name (e.g. ${activeWizard.data.provider || "provider name"}, deepseek, or press Enter for default):` :
              activeWizard.type === "login" && activeWizard.step === 4 ? "Please enter your Base URL (e.g. http://localhost:11434/v1):" :
              activeWizard.type === "login" && activeWizard.step === 5 ? "Please enter your API Key:" :
              activeWizard.type === "login" && activeWizard.step === 6 ? "Select a provider to continue with connection test and messaging:" :
              activeWizard.type === "login" && activeWizard.step === 7 ? `Do you want to test the connection to "${activeWizard.data.providerName || "provider"}" before selecting a model?` :
              activeWizard.type === "login" && activeWizard.step === 8 ? `Select a model from provider "${activeWizard.data.providerName || ""}". Type to filter:` :
              activeWizard.type === "login" && activeWizard.step === 9 ? `Type a test message to model "${activeWizard.data.selectedModel || ""}". Press Enter to send:` :
              activeWizard.type === "login" && activeWizard.step === 10 ? "Choose a template catalog stack or let AI dynamically design your project details:" :
              activeWizard.type === "login" && activeWizard.step === 11 ? "Specify the name for this workspace:" :
              activeWizard.type === "login" && activeWizard.step === 12 ? "Give a one-sentence overview description of this software:" :
              activeWizard.type === "login" && activeWizard.step === 13 ? "State what you want to build (e.g. 'A command-line text editor in Rust'). AI will construct agents.md specs:" :
              activeWizard.type === "login" && activeWizard.step === 14 ? "Select a provider to permanently remove. Type to search/filter:" :
              activeWizard.type === "login" && activeWizard.step === 15 ? `Are you sure you want to permanently remove "${activeWizard.data.providerName || ""}"? This cannot be undone.` :
              undefined
            }
            borderColor={wizardBorderColor}
            options={wizardOptions}
            selectedIndex={wizardSelectedIndex}
            maxVisible={10}
            isMultiSelect={activeWizard.isMultiSelect}
            selectedSet={wizardSelectedSet}
            marginY={0}
            terminalWidth={terminalWidth}
            isLoading={wizardIsLoadingModels}
          />
        </Box>
      )}
      <Box flexDirection="row" marginTop={0}>
        <Text color={wizardBorderColor}>│</Text>
      </Box>
    </Box>
  );
}
