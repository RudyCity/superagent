import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { 
  ensureRgInstalled, 
  ensureCurlInstalled, 
  ensureAndroidCliInstalled,
  ensureUvInstalled,
  ensurePythonInstalled,
  ensureOfficeCliInstalled,
  ensureRmemoryInstalled,
  isRgInstalledLocally,
  isRgInstalledGlobally,
  isCurlInstalledLocally,
  isCurlInstalledGlobally,
  isAndroidCliInstalledLocally,
  isAndroidCliInstalledGlobally,
  isUvInstalledLocally,
  isUvInstalledGlobally,
  isPythonInstalled,
  isOfficeCliInstalledGlobally,
  isRmemoryInstalled
} from "../core/androidSetup.js";
import { initMcpServers } from "../core/mcp/McpManager.js";
import { warmUpClassifier } from "../core/requestClassifier.js";
import { preloadLocalEmbeddingModel } from "../core/rmemoryUtil.js";
import { runRmemorySetup } from "../core/rmemorySetup.js";
import { getSettings } from "../core/config/jsonConfig.js";
import { registerProgressCallback } from "../core/tools/state.js";

interface TaskState {
  id: string;
  name: string;
  status: "pending" | "checking" | "downloading" | "extracting" | "ready" | "failed" | "skipped";
  progress?: number; // 0 to 100
  downloadedBytes?: number;
  totalBytes?: number;
}

interface StartupCheckerProps {
  onComplete: () => void;
}

export function StartupChecker({ onComplete }: StartupCheckerProps) {
  const [tasks, setTasks] = useState<Record<string, TaskState>>({});
  const [spinnerIndex, setSpinnerIndex] = useState(0);

  // Spinner animation
  useEffect(() => {
    const timer = setInterval(() => {
      setSpinnerIndex((prev) => (prev + 1) % 4);
    }, 200);
    return () => clearInterval(timer);
  }, []);

  const spinnerFrames = [".: ", ".:. ", "::. ", " .::"];
  const currentSpinner = spinnerFrames[spinnerIndex];

  useEffect(() => {
    const settings = getSettings();
    const isWin = process.platform === "win32";

    // Build the initial task list based on settings and platform
    const initialTasks: Record<string, TaskState> = {
      ripgrep: { id: "ripgrep", name: "ripgrep (rg)", status: "pending" },
    };

    if (isWin) {
      initialTasks.curl = { id: "curl", name: "curl", status: "pending" };
    }

    initialTasks.androidCli = { id: "androidCli", name: "Android CLI", status: "pending" };
    initialTasks.uv = { id: "uv", name: "uv Package Manager", status: "pending" };
    initialTasks.python = { id: "python", name: "Python Environment", status: "pending" };
    initialTasks.officeCli = { id: "officeCli", name: "Office CLI", status: "pending" };
    initialTasks.rmemory = { id: "rmemory", name: "RMemory Package", status: "pending" };
    initialTasks.mcpServers = { id: "mcpServers", name: "MCP Servers", status: "pending" };

    if (settings.classifierEnabled !== false) {
      initialTasks.classifierModel = { id: "classifierModel", name: "Classifier Model", status: "pending" };
    }

    if (settings.enableRmemory === true) {
      initialTasks.rmemoryGateway = { id: "rmemoryGateway", name: "RMemory Gateway", status: "pending" };
      if (settings.rmemoryEmbeddingProvider === "local" || !settings.rmemoryEmbeddingProvider) {
        initialTasks.embeddingModel = { id: "embeddingModel", name: "Embedding Model", status: "pending" };
      }
    }

    setTasks(initialTasks);

    // Run the checks and downloads
    async function runInitialization() {
      // Helper to update a task's state
      const updateTask = (id: string, updates: Partial<TaskState>) => {
        setTasks((prev) => {
          if (!prev[id]) return prev;
          return {
            ...prev,
            [id]: { ...prev[id], ...updates },
          };
        });
      };

      // 1. Register progress callback for transformers model downloads
      registerProgressCallback((event) => {
        if (event.type === "model_download") {
          const taskId = event.modelName === "classifier" ? "classifierModel" : "embeddingModel";
          if (event.status === "downloading") {
            updateTask(taskId, { status: "downloading", progress: 0 });
          } else if (event.status === "progress") {
            updateTask(taskId, { 
              status: "downloading", 
              progress: event.progress,
              downloadedBytes: event.loaded,
              totalBytes: event.total
            });
          } else if (event.status === "loaded") {
            updateTask(taskId, { status: "ready", progress: 100 });
          }
        }
      });

      // 2. Ripgrep (rg) check & setup
      updateTask("ripgrep", { status: "checking" });
      const hasRg = (await isRgInstalledLocally()) || (await isRgInstalledGlobally());
      if (hasRg) {
        updateTask("ripgrep", { status: "ready" });
      } else {
        updateTask("ripgrep", { status: "downloading", progress: 0 });
        await ensureRgInstalled((downloaded, total, stage) => {
          if (stage === "downloading") {
            const progress = total > 0 ? (downloaded / total) * 100 : 0;
            updateTask("ripgrep", { status: "downloading", progress, downloadedBytes: downloaded, totalBytes: total });
          } else if (stage === "extracting") {
            updateTask("ripgrep", { status: "extracting" });
          } else if (stage === "done") {
            updateTask("ripgrep", { status: "ready" });
          }
        }).catch(() => updateTask("ripgrep", { status: "failed" }));
      }

      // 3. Curl check & setup (Windows only)
      if (isWin) {
        updateTask("curl", { status: "checking" });
        const hasCurl = (await isCurlInstalledLocally()) || (await isCurlInstalledGlobally());
        if (hasCurl) {
          updateTask("curl", { status: "ready" });
        } else {
          updateTask("curl", { status: "downloading", progress: 0 });
          await ensureCurlInstalled((downloaded, total, stage) => {
            if (stage === "downloading") {
              const progress = total > 0 ? (downloaded / total) * 100 : 0;
              updateTask("curl", { status: "downloading", progress, downloadedBytes: downloaded, totalBytes: total });
            } else if (stage === "extracting") {
              updateTask("curl", { status: "extracting" });
            } else if (stage === "done") {
              updateTask("curl", { status: "ready" });
            }
          }).catch(() => updateTask("curl", { status: "failed" }));
        }
      }

      // 4. Android CLI check & setup
      updateTask("androidCli", { status: "checking" });
      const hasAndroid = (await isAndroidCliInstalledLocally()) || (await isAndroidCliInstalledGlobally());
      if (hasAndroid) {
        updateTask("androidCli", { status: "ready" });
      } else {
        updateTask("androidCli", { status: "downloading", progress: 0 });
        await ensureAndroidCliInstalled((downloaded, total, stage) => {
          if (stage === "downloading") {
            const progress = total > 0 ? (downloaded / total) * 100 : 0;
            updateTask("androidCli", { status: "downloading", progress, downloadedBytes: downloaded, totalBytes: total });
          } else if (stage === "extracting") {
            updateTask("androidCli", { status: "extracting" });
          } else if (stage === "done") {
            updateTask("androidCli", { status: "ready" });
          }
        }).catch(() => updateTask("androidCli", { status: "failed" }));
      }

      // 5. uv check & setup
      updateTask("uv", { status: "checking" });
      const hasUv = (await isUvInstalledLocally()) || (await isUvInstalledGlobally());
      if (hasUv) {
        updateTask("uv", { status: "ready" });
      } else {
        updateTask("uv", { status: "downloading", progress: 0 });
        await ensureUvInstalled((downloaded, total, stage) => {
          if (stage === "downloading") {
            const progress = total > 0 ? (downloaded / total) * 100 : 0;
            updateTask("uv", { status: "downloading", progress, downloadedBytes: downloaded, totalBytes: total });
          } else if (stage === "extracting") {
            updateTask("uv", { status: "extracting" });
          } else if (stage === "done") {
            updateTask("uv", { status: "ready" });
          }
        }).catch(() => updateTask("uv", { status: "failed" }));
      }

      // 6. Python check & setup
      updateTask("python", { status: "checking" });
      const hasPython = await isPythonInstalled();
      if (hasPython) {
        updateTask("python", { status: "ready" });
      } else {
        updateTask("python", { status: "downloading", progress: 0 });
        await ensurePythonInstalled((downloaded, total, stage) => {
          if (stage === "downloading") {
            const progress = total > 0 ? (downloaded / total) * 100 : 0;
            updateTask("python", { status: "downloading", progress, downloadedBytes: downloaded, totalBytes: total });
          } else if (stage === "extracting") {
            updateTask("python", { status: "extracting" });
          } else if (stage === "done") {
            updateTask("python", { status: "ready" });
          }
        }).catch(() => updateTask("python", { status: "failed" }));
      }

      // 7. Office CLI check & setup
      updateTask("officeCli", { status: "checking" });
      const hasOfficeCli = await isOfficeCliInstalledGlobally();
      if (hasOfficeCli) {
        updateTask("officeCli", { status: "ready" });
      } else {
        updateTask("officeCli", { status: "downloading", progress: 0 });
        await ensureOfficeCliInstalled((downloaded, total, stage) => {
          if (stage === "downloading") {
            const progress = total > 0 ? (downloaded / total) * 100 : 0;
            updateTask("officeCli", { status: "downloading", progress, downloadedBytes: downloaded, totalBytes: total });
          } else if (stage === "extracting") {
            updateTask("officeCli", { status: "extracting" });
          } else if (stage === "done") {
            updateTask("officeCli", { status: "ready" });
          }
        }).catch(() => updateTask("officeCli", { status: "failed" }));
      }

      // 8. RMemory Package check & setup
      updateTask("rmemory", { status: "checking" });
      const hasRmemory = await isRmemoryInstalled();
      if (hasRmemory) {
        updateTask("rmemory", { status: "ready" });
      } else {
        updateTask("rmemory", { status: "downloading", progress: 0 });
        await ensureRmemoryInstalled((downloaded, total, stage) => {
          if (stage === "downloading") {
            const progress = total > 0 ? (downloaded / total) * 100 : 0;
            updateTask("rmemory", { status: "downloading", progress, downloadedBytes: downloaded, totalBytes: total });
          } else if (stage === "extracting") {
            updateTask("rmemory", { status: "extracting" });
          } else if (stage === "done") {
            updateTask("rmemory", { status: "ready" });
          }
        }).catch(() => updateTask("rmemory", { status: "failed" }));
      }


      // Concurrently run MCP, Request Classifier, Embedding Model, and RMemory setup
      const parallelTasks = [];

      // MCP Servers
      parallelTasks.push((async () => {
        updateTask("mcpServers", { status: "checking" });
        try {
          await initMcpServers();
          updateTask("mcpServers", { status: "ready" });
        } catch {
          updateTask("mcpServers", { status: "failed" });
        }
      })());

      // Request Classifier Model
      if (settings.classifierEnabled !== false) {
        parallelTasks.push((async () => {
          updateTask("classifierModel", { status: "checking" });
          try {
            await warmUpClassifier();
            updateTask("classifierModel", { status: "ready" });
          } catch {
            updateTask("classifierModel", { status: "failed" });
          }
        })());
      }

      // Embedding Model and RMemory Setup
      if (settings.enableRmemory === true) {
        parallelTasks.push((async () => {
          updateTask("rmemoryGateway", { status: "checking" });
          try {
            await runRmemorySetup();
            updateTask("rmemoryGateway", { status: "ready" });
          } catch {
            updateTask("rmemoryGateway", { status: "failed" });
          }
        })());

        if (settings.rmemoryEmbeddingProvider === "local" || !settings.rmemoryEmbeddingProvider) {
          parallelTasks.push((async () => {
            updateTask("embeddingModel", { status: "checking" });
            try {
              await preloadLocalEmbeddingModel();
              updateTask("embeddingModel", { status: "ready" });
            } catch {
              updateTask("embeddingModel", { status: "failed" });
            }
          })());
        }
      }

      await Promise.all(parallelTasks);

      // Clean up global progress callback
      registerProgressCallback(() => {});

      // All finished! Wait a moment for visual confirmation, then trigger callback
      setTimeout(() => {
        onComplete();
      }, 600);
    }

    runInitialization();
  }, [onComplete]);

  // Format bytes helper
  const formatMiB = (bytes?: number) => {
    if (bytes === undefined) return "";
    return (bytes / (1024 * 1024)).toFixed(2) + " MiB";
  };

  const taskList = Object.values(tasks);
  const totalTasks = taskList.length;
  const completedTasks = taskList.filter((t) => t.status === "ready" || t.status === "skipped").length;

  return (
    <Box flexDirection="column" paddingX={2} marginY={1}>
      {/* ══ TOP STATUS LINE ══ */}
      <Box flexDirection="row" marginBottom={1}>
        <Text color="yellow" bold>{currentSpinner}</Text>
        <Text color="white" bold>Preparing system... ({completedTasks}/{totalTasks})</Text>
      </Box>

      {/* ══ TASKS ══ */}
      {taskList.map((task) => {
        const paddedName = task.name.padEnd(25, " ");
        let bar = "";
        let rightInfo = "";

        if (task.status === "downloading" && task.progress !== undefined) {
          const barWidth = 30;
          const filled = Math.round((task.progress / 100) * barWidth);
          bar = "-".repeat(filled).padEnd(barWidth, " ");
          
          if (task.downloadedBytes !== undefined && task.totalBytes !== undefined && task.totalBytes > 0) {
            rightInfo = `${formatMiB(task.downloadedBytes)}/${formatMiB(task.totalBytes)}`;
          } else {
            rightInfo = `${task.progress.toFixed(1)}%`;
          }
        } else {
          bar = " ".repeat(30);
          if (task.status === "ready") {
            rightInfo = "Installed";
          } else if (task.status === "checking") {
            rightInfo = "Checking...";
          } else if (task.status === "extracting") {
            rightInfo = "Extracting...";
          } else if (task.status === "skipped") {
            rightInfo = "Skipped";
          } else if (task.status === "failed") {
            rightInfo = "Failed";
          } else {
            rightInfo = "Pending";
          }
        }

        const getStatusColor = (status: string) => {
          if (status === "ready" || status === "skipped") return "green";
          if (status === "failed") return "red";
          if (status === "checking" || status === "extracting") return "cyan";
          if (status === "downloading") return "yellow";
          return "gray";
        };

        return (
          <Box key={task.id} flexDirection="row" marginBottom={0.5}>
            <Text color="white">{paddedName}</Text>
            {task.status === "downloading" ? (
              <Text color="green">{bar}</Text>
            ) : (
              <Text color="gray">{bar}</Text>
            )}
            <Box marginLeft={2} width={20}>
              <Text color={getStatusColor(task.status)}>{rightInfo}</Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
