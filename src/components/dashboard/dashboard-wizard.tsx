import React from "react";
import { Box, Text } from "ink";
import path from "path";
import { filterSuggestions } from "../../utils/text.js";
import { WizardDialog } from "../wizard-dialog.js";

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
      {/* Model step 3: split out to handle query-based filtering like single agent */}
      {activeWizard.type === "model" && activeWizard.step === 3 && (() => {
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
          />
        );
      })()}

      {/* All other wizard types */}
      {(activeWizard.type !== "model" || activeWizard.step !== 3) && (
        <WizardDialog
          title={
            activeWizard.type === "model" && activeWizard.step === 1 ? `⚙️ SELECT AGENT TIER TO CONFIGURE:` :
            activeWizard.type === "model" && activeWizard.step === 2 ? `⚙️ SELECT MODEL PROVIDER FOR ${activeWizard.data.tier?.toUpperCase() || "MODELS"}:` :
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
            activeWizard.type === "login" && activeWizard.step === 1 ? "🔑 PROVIDER MANAGER (Use Arrow Keys Up/Down & Enter):" :
            activeWizard.type === "login" && activeWizard.step === 2 ? "🔑 SELECT PROVIDER TEMPLATE (Use Arrow Keys Up/Down & Enter):" :
            activeWizard.type === "login" && activeWizard.step === 5 ? "🔑 SWITCH ACTIVE PROVIDER (Use Arrow Keys Up/Down & Enter):" :
            activeWizard.type === "login" && activeWizard.step === 10 ? "🛠️ PROJECT INITIALIZATION — Select Technology Stack (Arrows & Enter):" :
            activeWizard.type === "login" && activeWizard.step === 11 ? "🛠️ PROJECT INITIALIZATION — Enter Project Name (Type & Enter):" :
            activeWizard.type === "login" && activeWizard.step === 12 ? "🛠️ PROJECT INITIALIZATION — Enter Project Description (Type & Enter):" :
            activeWizard.type === "login" && activeWizard.step === 13 ? "🤖 AI PROJECT INITIALIZATION — Describe Project Goal (Type & Enter):" :
            `🔑 PROVIDER CREDENTIALS (Step ${activeWizard.step}):`
          }
          description={
            activeWizard.type === "plan_approve" ? `Model AI telah merancang rencana di file: file:///${path.resolve(agent.getPlanFilePath()).replace(/\\/g, "/")}` :
            activeWizard.type === "question" ? (pendingQuestion?.question || "") :
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
        />
      )}
      <Box flexDirection="row" marginTop={0}>
        <Text color={wizardBorderColor}>│</Text>
      </Box>
    </Box>
  );
}
