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
      {activeWizard.type === "model" && (activeWizard.step === 15 || activeWizard.step === 24 || activeWizard.step === 34) && (() => {
        const lc = query.trim();
        const filteredModels = lc
          ? filterSuggestions(wizardAllOptions, lc)
          : wizardAllOptions;
        const clampedIndex = Math.min(wizardSelectedIndex, Math.max(0, filteredModels.length - 1));
        const tierStr = activeWizard.data.tier ? ` FOR ${activeWizard.data.tier.toUpperCase()}` : "";
        const provStr = activeWizard.data.provider ? ` VIA ${activeWizard.data.provider.toUpperCase()}` : "";
        const searchTitle = wizardIsLoadingModels
          ? `⚙️ SELECT MODEL${tierStr}${provStr} — ⏳ loading...`
          : lc
            ? `⚙️ SELECT MODEL${tierStr}${provStr} — 🔍 "${query.trim()}" (${filteredModels.length}/${wizardAllOptions.length} results):`
            : `⚙️ SELECT MODEL${tierStr}${provStr} (${wizardAllOptions.length} available — type to filter, ↑/↓ navigate, Enter select):`;
        return (
          <WizardDialog
            title={searchTitle}
            borderColor={wizardBorderColor}
            options={filteredModels.length > 0 ? filteredModels : ["(no results — try different search)"]}
            selectedIndex={clampedIndex}
            maxVisible={8}
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

      {/* All other wizard types (not model search, not plan_approve) */}
      {(activeWizard.type !== "model" || (activeWizard.step !== 15 && activeWizard.step !== 24 && activeWizard.step !== 34)) && activeWizard.type !== "plan_approve" && (
        <WizardDialog
          title={
            activeWizard.type === "model" && activeWizard.step === 1 ? `⚙️ SELECT AGENT TIER TO CONFIGURE:` :
            activeWizard.type === "model" && activeWizard.step === 2 ? `⚙️ SELECT MODEL PROVIDER FOR ${activeWizard.data.tier?.toUpperCase() || "MODELS"}:` :
            activeWizard.type === "model" && activeWizard.step === 3 ? `⚙️ SELECT PROFILE FOR ${activeWizard.data.tier?.toUpperCase() || "MODELS"}:` :
            activeWizard.type === "model" && activeWizard.step === 4 ? `⚙️ LOAD/APPLY MODEL PRESET:` :
            activeWizard.type === "model" && activeWizard.step === 20 ? `⚙️ CREATE MODEL PRESET — ENTER PRESET NAME:` :
            activeWizard.type === "model" && activeWizard.step === 21 ? `⚙️ CREATE MODEL PRESET — ENTER DESCRIPTION:` :
            activeWizard.type === "model" && activeWizard.step === 22 ? `⚙️ CREATE MODEL PRESET — SELECT AGENT TIER TO CONFIGURE:` :
            activeWizard.type === "model" && activeWizard.step === 23 ? `⚙️ CREATE MODEL PRESET — SELECT MODEL PROVIDER FOR ${activeWizard.data.tier?.toUpperCase()}:` :
            activeWizard.type === "model" && activeWizard.step === 25 ? `⚙️ CREATE MODEL PRESET — SELECT PROFILE FOR ${activeWizard.data.tier?.toUpperCase()}:` :
            activeWizard.type === "model" && activeWizard.step === 30 ? `⚙️ EDIT MODEL PRESET — SELECT PRESET TO EDIT:` :
            activeWizard.type === "model" && activeWizard.step === 31 ? `⚙️ EDIT MODEL PRESET — ENTER NEW DESCRIPTION:` :
            activeWizard.type === "model" && activeWizard.step === 32 ? `⚙️ EDIT MODEL PRESET — SELECT AGENT TIER TO CONFIGURE:` :
            activeWizard.type === "model" && activeWizard.step === 33 ? `⚙️ EDIT MODEL PRESET — SELECT MODEL PROVIDER FOR ${activeWizard.data.tier?.toUpperCase()}:` :
            activeWizard.type === "model" && activeWizard.step === 35 ? `⚙️ EDIT MODEL PRESET — SELECT PROFILE FOR ${activeWizard.data.tier?.toUpperCase()}:` :
            activeWizard.type === "model" && activeWizard.step === 40 ? `⚙️ DELETE MODEL PRESET — SELECT PRESET TO DELETE:` :
            activeWizard.type === "model" && activeWizard.step === 41 ? `⚙️ DELETE MODEL PRESET — CONFIRM DELETION:` :
            activeWizard.type === "model" && activeWizard.step === 50 ? `⚙️ CONFIGURE AGENT TIERS — SELECT TIER TO CONFIGURE:` :
            activeWizard.type === "model" && activeWizard.step === 16 ? `⚙️ CONFIGURE PROVIDER — PROFILE NAME (Type & Enter):` :
            activeWizard.type === "model" && activeWizard.step === 17 ? `⚙️ CONFIGURE PROVIDER — BASE URL (Type & Enter):` :
            activeWizard.type === "model" && activeWizard.step === 18 ? `⚙️ CONFIGURE PROVIDER — API KEY (Type & Enter):` :
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
            `🔑 PROVIDER CREDENTIALS (Step ${activeWizard.step}):`
          }
          description={
            activeWizard.type === "plan_approve" ? `AI model has designed a plan in file: file:///${path.resolve(agent.getPlanFilePath()).replace(/\\/g, "/")}` :
            activeWizard.type === "question" ? (pendingQuestion?.question || "") :
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
        />
      )}
      <Box flexDirection="row" marginTop={0}>
        <Text color={wizardBorderColor}>│</Text>
      </Box>
    </Box>
  );
}
