import React from "react";
import { Box, Text } from "ink";
import { WizardDialog } from "./wizard-dialog.js";
import { filterSuggestions } from "../utils/text.js";
import { getInstalledSkills } from "../core/config.js";
import type { Checkpoint } from "../core/checkpoints.js";
import type { ToolCall } from "../core/conversation.js";

export interface WizardPanelsProps {
  activeWizard: {
    type: "login" | "model" | "plan_approve" | "permission" | "question" | "resume" | "goal" | "checkpoint" | "skills";
    step: number;
    data: Record<string, string>;
    isMultiSelect?: boolean;
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
    resolve: (value: string) => void;
  } | null;
  planState: string;
  planUrl: string;
  input: string;
  wizardIsLoadingModels: boolean;
  checkpointsList: Checkpoint[];
  goalMode: { goal: string; startedAt: number } | null;
  suggestions: string[];
}

export function WizardPanels(props: WizardPanelsProps) {
  const {
    activeWizard,
    wizardOptions,
    wizardSelectedIndex,
    wizardSelectedSet,
    pendingPermission,
    pendingQuestion,
    planState,
    planUrl,
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

      <Box flexDirection="column" paddingX={1} marginTop={1}>
        {planState === "PLANNING_PENDING" && activeWizard?.type !== "plan_approve" && (
          <Box marginBottom={1} flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
            <Text bold color="yellow">⚠️ PENDING_PLAN: RENCANA IMPLEMENTASI MEMBUTUHKAN PERSETUJUAN</Text>
            <Text color="yellow">Model AI telah merancang rencana di file: <Text bold color="cyan">{planUrl}</Text></Text>
            <Text color="yellow">Silakan kirim pesan/masukan apa saja untuk menampilkan kembali dialog persetujuan wizard.</Text>
          </Box>
        )}

        {activeWizard && activeWizard.type === "plan_approve" && wizardOptions.length > 0 && (
          <WizardDialog
            title="⚠️ PLAN APPROVAL REQUIRED (Use Arrow Keys Up/Down & Enter):"
            description={`Model AI telah merancang rencana di file: ${planUrl}`}
            borderColor="yellow"
            options={wizardOptions}
            selectedIndex={wizardSelectedIndex}
          />
        )}

        {activeWizard && activeWizard.type === "question" && pendingQuestion && (
          <WizardDialog
            title={activeWizard.step === 2 ? "❓ ENTER CUSTOM ANSWER (Type and press Enter):" : (activeWizard.isMultiSelect ? "❓ QUESTION FROM AGENT (Arrows: navigate, Space: select, Enter: submit):" : "❓ QUESTION FROM AGENT (Use Arrow Keys Up/Down & Enter):")}
            description={pendingQuestion.question}
            borderColor="cyan"
            options={wizardOptions}
            selectedIndex={wizardSelectedIndex}
            isMultiSelect={activeWizard.isMultiSelect}
            selectedSet={wizardSelectedSet}
          />
        )}

        {activeWizard && activeWizard.type === "login" && activeWizard.step === 1 && wizardOptions.length > 0 && (
          <WizardDialog
            title="🔑 PROVIDER MANAGER (Use Arrow Keys Up/Down & Enter):"
            borderColor="cyan"
            options={wizardOptions}
            selectedIndex={wizardSelectedIndex}
          />
        )}

        {activeWizard && activeWizard.type === "login" && activeWizard.step === 2 && wizardOptions.length > 0 && (
          <WizardDialog
            title="🔑 SELECT PROVIDER TEMPLATE (Use Arrow Keys Up/Down & Enter):"
            borderColor="cyan"
            options={wizardOptions}
            selectedIndex={wizardSelectedIndex}
          />
        )}

        {activeWizard && activeWizard.type === "login" && activeWizard.step === 3 && (
          <WizardDialog
            title="🔑 CONFIGURE PROVIDER — PROFILE NAME (Type & Enter):"
            description={`Enter config profile name (e.g. ${activeWizard.data.provider || "provider name"}, deepseek, or press Enter for default):`}
            borderColor="cyan"
            options={[]}
            selectedIndex={0}
          />
        )}

        {activeWizard && activeWizard.type === "login" && activeWizard.step === 4 && (
          <WizardDialog
            title="🔑 CONFIGURE PROVIDER — BASE URL (Type & Enter):"
            description="Please enter your Base URL (e.g. http://localhost:11434/v1):"
            borderColor="cyan"
            options={[]}
            selectedIndex={0}
          />
        )}

        {activeWizard && activeWizard.type === "login" && activeWizard.step === 6 && (
          <WizardDialog
            title="🔑 CONFIGURE PROVIDER — API KEY (Type & Enter):"
            description="Please enter your API Key:"
            borderColor="cyan"
            options={[]}
            selectedIndex={0}
          />
        )}


        {activeWizard && activeWizard.type === "login" && activeWizard.step === 10 && wizardOptions.length > 0 && (
          <WizardDialog
            title="🛠️ PROJECT INITIALIZATION — Select Technology Stack (Arrows & Enter):"
            description="Choose a template catalog stack or let AI dynamically design your project details:"
            borderColor="cyan"
            options={wizardOptions}
            selectedIndex={wizardSelectedIndex}
          />
        )}

        {activeWizard && activeWizard.type === "login" && activeWizard.step === 11 && (
          <WizardDialog
            title="🛠️ PROJECT INITIALIZATION — Enter Project Name (Type & Enter):"
            description="Specify the catalog name for this workspace:"
            borderColor="cyan"
            options={[]}
            selectedIndex={0}
          />
        )}

        {activeWizard && activeWizard.type === "login" && activeWizard.step === 12 && (
          <WizardDialog
            title="🛠️ PROJECT INITIALIZATION — Enter Project Description (Type & Enter):"
            description="Give a one-sentence overview description of this software:"
            borderColor="cyan"
            options={[]}
            selectedIndex={0}
          />
        )}

        {activeWizard && activeWizard.type === "login" && activeWizard.step === 13 && (
          <WizardDialog
            title="🤖 AI PROJECT INITIALIZATION — Describe Project Goal (Type & Enter):"
            description="State what you want to build (e.g. 'A command-line text editor in Rust'). AI will construct agents.md specs:"
            borderColor="magenta"
            options={[]}
            selectedIndex={0}
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

        {activeWizard && activeWizard.type === "model" && activeWizard.step === 3 && wizardOptions.length > 0 && (
          <WizardDialog
            title={`⚙️ SELECT PROFILE FOR ${activeWizard.data.tier?.toUpperCase() || "MODELS"} (Use Arrow Keys Up/Down & Enter):`}
            borderColor="cyan"
            options={wizardOptions}
            selectedIndex={wizardSelectedIndex}
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

        {activeWizard && activeWizard.type === "model" && activeWizard.step === 4 && wizardOptions.length > 0 && (
          <WizardDialog
            title="⚙️ APPLY MODEL PRESET (Use Arrow Keys Up/Down & Enter):"
            borderColor="cyan"
            options={wizardOptions}
            selectedIndex={wizardSelectedIndex}
            maxVisible={10}
          />
        )}

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

        {activeWizard && activeWizard.type === "model" && activeWizard.step === 30 && wizardOptions.length > 0 && (
          <WizardDialog
            title="📝 EDIT MODEL PRESET — Select Preset to Edit:"
            borderColor="cyan"
            options={wizardOptions}
            selectedIndex={wizardSelectedIndex}
            maxVisible={10}
          />
        )}

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

        {activeWizard && activeWizard.type === "model" && activeWizard.step === 25 && wizardOptions.length > 0 && (
          <WizardDialog
            title={`📝 CREATE MODEL PRESET — Select Profile for ${activeWizard.data.tier?.toUpperCase() || "Tiers"}:`}
            description="Choose a credential profile (or select '< Back' to return):"
            borderColor="cyan"
            options={wizardOptions}
            selectedIndex={wizardSelectedIndex}
          />
        )}

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

        {activeWizard && activeWizard.type === "model" && activeWizard.step === 35 && wizardOptions.length > 0 && (
          <WizardDialog
            title={`📝 EDIT MODEL PRESET — Select Profile for ${activeWizard.data.tier?.toUpperCase() || "Tiers"}:`}
            description="Choose a credential profile (or select '< Back' to return):"
            borderColor="cyan"
            options={wizardOptions}
            selectedIndex={wizardSelectedIndex}
          />
        )}

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

        {activeWizard && activeWizard.type === "model" && activeWizard.step === 40 && wizardOptions.length > 0 && (
          <WizardDialog
            title="❌ DELETE MODEL PRESET — Select Preset to Delete:"
            borderColor="cyan"
            options={wizardOptions}
            selectedIndex={wizardSelectedIndex}
            maxVisible={10}
          />
        )}

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
            title="📚 RESUME SESSION — Pilih sesi untuk dilanjutkan (↑/↓ Navigate, Enter: Load, Esc: Cancel):"
            description="Sesi diurutkan dari yang paling baru:"
            borderColor="magenta"
            options={wizardOptions}
            selectedIndex={wizardSelectedIndex}
            maxVisible={10}
          />
        )}

        {activeWizard && activeWizard.type === "skills" && wizardOptions.length > 0 && (() => {
          const installedSkills = getInstalledSkills();
          const chosenSkill = installedSkills[parseInt(activeWizard.data.skillIndex || "0", 10)];
          const skillTitle = activeWizard.step === 2
            ? `📂 SKILL ACTION — Pilih tindakan untuk skill: "${chosenSkill?.name || ""}" (↑/↓ Navigate, Enter: Select):`
            : "📂 INSTALLED AGENT SKILLS — Pilih skill (↑/↓ Navigate, Enter: Choose, Esc: Cancel):";
          const skillDesc = activeWizard.step === 2
            ? "Silakan pilih apakah ingin mengaktifkan skill ini untuk agen atau melihat detail lokasinya:"
            : "Daftar kemampuan khusus agen yang terpasang:";
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
        })()}

        {activeWizard && activeWizard.type === "checkpoint" && activeWizard.step === 1 && wizardOptions.length > 0 && (
          <WizardDialog
            title="📌 CHECKPOINT — Pilih checkpoint untuk dipulihkan (↑/↓ Navigate, Enter: Restore, Esc: Cancel):"
            description="Checkpoints diurutkan dari yang paling baru:"
            borderColor="green"
            options={wizardOptions}
            selectedIndex={wizardSelectedIndex}
            maxVisible={10}
          />
        )}

        {activeWizard && activeWizard.type === "checkpoint" && activeWizard.step === 2 && wizardOptions.length > 0 && (
          <WizardDialog
            title="📌 RESTORE WORKSPACE — Pulihkan kode workspace ke Git commit checkpoint? (↑/↓ Navigate, Enter: Select):"
            description={`Git commit: ${checkpointsList[parseInt(activeWizard.data.checkpointIndex || "0", 10)]?.gitSha || "unknown"}`}
            borderColor="yellow"
            options={wizardOptions}
            selectedIndex={wizardSelectedIndex}
          />
        )}

        {activeWizard && activeWizard.type === "goal" && activeWizard.step === 1 && (
          <WizardDialog
            title="🎯 GOAL MODE — Deskripsikan tujuan yang ingin dicapai (Type & Enter):"
            description="Agent akan bekerja tanpa henti sampai goal tercapai. Gunakan Ctrl+C untuk membatalkan."
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
}
