import React, { useState, useEffect, useRef } from "react";
import { Box, Text, useInput } from "ink";
import { 
  ensureRgInstalled, 
  ensureCurlInstalled, 
  ensureAndroidCliInstalled,
  ensureUvInstalled,
  ensurePythonInstalled,
  ensureOfficeCliInstalled,
  ensureRmemoryInstalled,
  isPaddleOcrAvailable,
  ensurePaddleOcrInstalled,
  isRgInstalledLocally,
  isRgInstalledGlobally,
  isCurlInstalledLocally,
  isCurlInstalledGlobally,
  isAndroidCliInstalledLocally,
  isAndroidCliInstalledGlobally,
  isUvInstalledLocally,
  isUvInstalledGlobally,
  isPythonInstalled,
  isOfficeCliInstalledLocally,
  isOfficeCliInstalledGlobally,
  isRmemoryInstalled,
  isTunnelClientAvailable,
  ensureTunnelClientInstalled,
} from "../core/androidSetup.js";
import { initMcpServers } from "../core/mcp/McpManager.js";
import { warmUpClassifier } from "../core/requestClassifier.js";
import { preloadLocalEmbeddingModel, checkLocalModelDownloadStatus, DEFAULT_LOCAL_EMBEDDING_MODEL } from "../core/rmemoryUtil.js";
import { runRmemorySetup } from "../core/rmemorySetup.js";
import { getSettings } from "../core/config/jsonConfig.js";
import { registerProgressCallback } from "../core/tools/state.js";
import { checkNativeDependencies } from "../core/runtime/nativeDependencies.js";
import { logStartup } from "../core/utils/unifiedLogger.js";

interface TaskState {
  id: string;
  name: string;
  status: "pending" | "checking" | "downloading" | "extracting" | "ready" | "failed" | "skipped" | "missing";
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
  const completedRef = useRef(false);

  // Allow manual skip via Esc or 's'
  useInput((input, key) => {
    if (key.escape || input === "s" || input === "S") {
      if (!completedRef.current) {
        completedRef.current = true;
        logStartup("StartupChecker manually skipped by user", { key: input || "Escape" });
        registerProgressCallback(() => {});
        onComplete();
      }
    }
  });

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
      ffmpeg: { id: "ffmpeg", name: "FFmpeg (CDP video)", status: "pending" },
    };

    if (isWin) {
      initialTasks.curl = { id: "curl", name: "curl", status: "pending" };
    }

    initialTasks.androidCli = { id: "androidCli", name: "Android CLI", status: "pending" };
    initialTasks.uv = { id: "uv", name: "uv Package Manager", status: "pending" };
    initialTasks.python = { id: "python", name: "Python Environment", status: "pending" };
    initialTasks.paddleOcr = { id: "paddleOcr", name: "PaddleOCR Engine", status: "pending" };
    initialTasks.officeCli = { id: "officeCli", name: "Office CLI", status: "pending" };
    initialTasks.rmemory = { id: "rmemory", name: "RMemory Package", status: "pending" };
    initialTasks.mcpServers = { id: "mcpServers", name: "MCP Servers", status: "pending" };
    initialTasks.tunnelClient = { id: "tunnelClient", name: "OpenAI Tunnel Client", status: "pending" };

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
      let anyDownloadOccurred = false;
      const startTime = Date.now();
      logStartup("StartupChecker starting dependency checks", {
        taskCount: Object.keys(initialTasks).length,
        isWin,
        tasks: Object.keys(initialTasks)
      });

      const withTimeout = async <T,>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
        let timer: any;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            logStartup(`Task timed out: [${label}] after ${Math.round(timeoutMs / 1000)}s`);
            reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`));
          }, timeoutMs);
        });
        try {
          const res = await Promise.race([promise, timeoutPromise]);
          clearTimeout(timer);
          return res;
        } catch (err) {
          clearTimeout(timer);
          throw err;
        }
      };

      // Helper to update a task's state
      const updateTask = (id: string, updates: Partial<TaskState>) => {
        if (updates.status === "downloading" || updates.status === "extracting") {
          anyDownloadOccurred = true;
        }
        if (updates.status) {
          logStartup(`Startup task [${id}] status: ${updates.status}`, { id, ...updates });
        }
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
          anyDownloadOccurred = true;
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

      // Optional media tooling is checked only; package manager installs must
      // have an explicit confirmation before startup, never from this renderer.
      const checkFfmpeg = async () => {
        updateTask("ffmpeg", { status: "checking" });
        const ready = checkNativeDependencies()[0].installed;
        updateTask("ffmpeg", { status: ready ? "ready" : "missing" });
      };

      // 2. Ripgrep (rg)
      const checkRg = async () => {
        updateTask("ripgrep", { status: "checking" });
        const hasRg = (await isRgInstalledLocally()) || (await isRgInstalledGlobally());
        if (hasRg) {
          updateTask("ripgrep", { status: "ready" });
        } else {
          updateTask("ripgrep", { status: "downloading", progress: 0 });
          await withTimeout(ensureRgInstalled((downloaded, total, stage) => {
            if (stage === "downloading") {
              const progress = total > 0 ? (downloaded / total) * 100 : 0;
              updateTask("ripgrep", { status: "downloading", progress, downloadedBytes: downloaded, totalBytes: total });
            } else if (stage === "extracting") {
              updateTask("ripgrep", { status: "extracting" });
            } else if (stage === "done") {
              updateTask("ripgrep", { status: "ready" });
            }
          }), 25000, "ripgrep").catch(() => updateTask("ripgrep", { status: "failed" }));
        }
      };

      // 3. Curl (Windows only)
      const checkCurl = async () => {
        if (!isWin) return;
        updateTask("curl", { status: "checking" });
        const hasCurl = (await isCurlInstalledLocally()) || (await isCurlInstalledGlobally());
        if (hasCurl) {
          updateTask("curl", { status: "ready" });
        } else {
          updateTask("curl", { status: "downloading", progress: 0 });
          await withTimeout(ensureCurlInstalled((downloaded, total, stage) => {
            if (stage === "downloading") {
              const progress = total > 0 ? (downloaded / total) * 100 : 0;
              updateTask("curl", { status: "downloading", progress, downloadedBytes: downloaded, totalBytes: total });
            } else if (stage === "extracting") {
              updateTask("curl", { status: "extracting" });
            } else if (stage === "done") {
              updateTask("curl", { status: "ready" });
            }
          }), 25000, "curl").catch(() => updateTask("curl", { status: "failed" }));
        }
      };

      // 4. Android CLI
      const checkAndroid = async () => {
        updateTask("androidCli", { status: "checking" });
        const hasAndroid = (await isAndroidCliInstalledLocally()) || (await isAndroidCliInstalledGlobally());
        if (hasAndroid) {
          updateTask("androidCli", { status: "ready" });
        } else {
          updateTask("androidCli", { status: "downloading", progress: 0 });
          await withTimeout(ensureAndroidCliInstalled((downloaded, total, stage) => {
            if (stage === "downloading") {
              const progress = total > 0 ? (downloaded / total) * 100 : 0;
              updateTask("androidCli", { status: "downloading", progress, downloadedBytes: downloaded, totalBytes: total });
            } else if (stage === "extracting") {
              updateTask("androidCli", { status: "extracting" });
            } else if (stage === "done") {
              updateTask("androidCli", { status: "ready" });
            }
          }), 25000, "androidCli").catch(() => updateTask("androidCli", { status: "failed" }));
        }
      };

      // 5. uv
      const checkUv = async () => {
        updateTask("uv", { status: "checking" });
        const hasUv = (await isUvInstalledLocally()) || (await isUvInstalledGlobally());
        if (hasUv) {
          updateTask("uv", { status: "ready" });
        } else {
          updateTask("uv", { status: "downloading", progress: 0 });
          await withTimeout(ensureUvInstalled((downloaded, total, stage) => {
            if (stage === "downloading") {
              const progress = total > 0 ? (downloaded / total) * 100 : 0;
              updateTask("uv", { status: "downloading", progress, downloadedBytes: downloaded, totalBytes: total });
            } else if (stage === "extracting") {
              updateTask("uv", { status: "extracting" });
            } else if (stage === "done") {
              updateTask("uv", { status: "ready" });
            }
          }), 25000, "uv").catch(() => updateTask("uv", { status: "failed" }));
        }
      };

      // 6. Python
      const checkPython = async () => {
        updateTask("python", { status: "checking" });
        const hasPython = await isPythonInstalled();
        if (hasPython) {
          updateTask("python", { status: "ready" });
        } else {
          updateTask("python", { status: "downloading", progress: 0 });
          await withTimeout(ensurePythonInstalled((downloaded, total, stage) => {
            if (stage === "downloading") {
              updateTask("python", { status: "downloading" });
            } else if (stage === "extracting") {
              updateTask("python", { status: "extracting" });
            } else if (stage === "done") {
              updateTask("python", { status: "ready" });
            }
          }), 30000, "python").catch(() => updateTask("python", { status: "failed" }));
        }
      };

      // 7. PaddleOCR
      const checkPaddleOcr = async () => {
        updateTask("paddleOcr", { status: "checking" });
        const hasPaddleOcr = await isPaddleOcrAvailable();
        if (hasPaddleOcr) {
          updateTask("paddleOcr", { status: "ready" });
        } else {
          updateTask("paddleOcr", { status: "skipped" });
        }
      };

      // 8. Office CLI
      const checkOfficeCli = async () => {
        updateTask("officeCli", { status: "checking" });
        const hasOfficeCli = (await isOfficeCliInstalledLocally()) || (await isOfficeCliInstalledGlobally());
        if (hasOfficeCli) {
          updateTask("officeCli", { status: "ready" });
        } else {
          updateTask("officeCli", { status: "downloading", progress: 0 });
          await withTimeout(ensureOfficeCliInstalled((downloaded, total, stage) => {
            if (stage === "downloading") {
              const progress = total > 0 ? (downloaded / total) * 100 : 0;
              updateTask("officeCli", { status: "downloading", progress, downloadedBytes: downloaded, totalBytes: total });
            } else if (stage === "extracting") {
              updateTask("officeCli", { status: "extracting" });
            } else if (stage === "done") {
              updateTask("officeCli", { status: "ready" });
            }
          }), 25000, "officeCli").catch(() => updateTask("officeCli", { status: "failed" }));
        }
      };

      // 9. RMemory Package
      const checkRmemory = async () => {
        updateTask("rmemory", { status: "checking" });
        const hasRmemory = await isRmemoryInstalled();
        if (hasRmemory) {
          updateTask("rmemory", { status: "ready" });
        } else {
          updateTask("rmemory", { status: "downloading", progress: 0 });
          await withTimeout(ensureRmemoryInstalled((downloaded, total, stage) => {
            if (stage === "downloading") {
              const progress = total > 0 ? (downloaded / total) * 100 : 0;
              updateTask("rmemory", { status: "downloading", progress, downloadedBytes: downloaded, totalBytes: total });
            } else if (stage === "extracting") {
              updateTask("rmemory", { status: "extracting" });
            } else if (stage === "done") {
              updateTask("rmemory", { status: "ready" });
            }
          }), 25000, "rmemory").catch(() => updateTask("rmemory", { status: "failed" }));
        }
      };

      // 10. MCP Servers
      const checkMcp = async () => {
        updateTask("mcpServers", { status: "checking" });
        try {
          await Promise.race([
            initMcpServers(),
            new Promise((_, reject) => setTimeout(() => reject(new Error("MCP startup check timed out")), 10000)),
          ]);
          updateTask("mcpServers", { status: "ready" });
        } catch {
          updateTask("mcpServers", { status: "failed" });
        }
      };

      // 11. OpenAI Tunnel Client
      const checkTunnelClient = async () => {
        updateTask("tunnelClient", { status: "checking" });
        const hasClient = await isTunnelClientAvailable();
        if (hasClient) {
          updateTask("tunnelClient", { status: "ready" });
        } else {
          updateTask("tunnelClient", { status: "downloading", progress: 0 });
          await withTimeout(ensureTunnelClientInstalled((downloaded, total, stage) => {
            if (stage === "downloading") {
              updateTask("tunnelClient", { status: "downloading" });
            } else if (stage === "done") {
              updateTask("tunnelClient", { status: "ready" });
            }
          }), 25000, "tunnelClient").catch(() => {});
          const installed = await isTunnelClientAvailable();
          updateTask("tunnelClient", { status: installed ? "ready" : "skipped" });
        }
      };

      // 12. Request Classifier Model (Native Senopati System-1 ONNX)
      const checkClassifier = async () => {
        if (settings.classifierEnabled === false) return;
        updateTask("classifierModel", { status: "checking" });
        try {
          await warmUpClassifier();
          updateTask("classifierModel", { status: "ready" });
        } catch {
          updateTask("classifierModel", { status: "failed" });
        }
      };

      // 13. Embedding Model and RMemory Setup
      const checkRmemoryServices = async () => {
        if (settings.enableRmemory !== true) return;
        updateTask("rmemoryGateway", { status: "checking" });
        try {
          await runRmemorySetup();
          updateTask("rmemoryGateway", { status: "ready" });
        } catch {
          updateTask("rmemoryGateway", { status: "failed" });
        }

        if (settings.rmemoryEmbeddingProvider === "local" || !settings.rmemoryEmbeddingProvider) {
          const status = checkLocalModelDownloadStatus(DEFAULT_LOCAL_EMBEDDING_MODEL);
          if (status.includes("DOWNLOADED") || status.includes("LOADED")) {
            updateTask("embeddingModel", { status: "ready" });
            preloadLocalEmbeddingModel().catch(() => {});
          } else {
            updateTask("embeddingModel", { status: "checking" });
            try {
              await withTimeout(preloadLocalEmbeddingModel(), 30000, "embeddingModel");
              updateTask("embeddingModel", { status: "ready" });
            } catch {
              updateTask("embeddingModel", { status: "failed" });
            }
          }
        }
      };

      // Execute all checks in parallel!
      await Promise.allSettled([
        checkFfmpeg(),
        checkRg(),
        ...(isWin ? [checkCurl()] : []),
        checkAndroid(),
        checkUv(),
        checkPython(),
        checkPaddleOcr(),
        checkOfficeCli(),
        checkRmemory(),
        checkMcp(),
        checkTunnelClient(),
        checkClassifier(),
        checkRmemoryServices(),
      ]);

      // Clean up global progress callback
      registerProgressCallback(() => {});

      const durationMs = Date.now() - startTime;
      logStartup("StartupChecker finished all dependency checks", {
        durationMs,
        completedTasks,
        totalTasks,
        anyDownloadOccurred
      });

      if (completedRef.current) return;
      completedRef.current = true;

      // If downloads occurred, wait briefly for visual confirmation; otherwise complete immediately
      if (anyDownloadOccurred) {
        setTimeout(() => {
          onComplete();
        }, 400);
      } else {
        onComplete();
      }
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
  const completedTasks = taskList.filter((t) => t.status === "ready" || t.status === "skipped" || t.status === "missing" || t.status === "failed").length;

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
          } else if (task.status === "missing") {
            rightInfo = "Needs install";
          } else if (task.status === "failed") {
            rightInfo = "Failed";
          } else {
            rightInfo = "Pending";
          }
        }

        const getStatusColor = (status: string) => {
          if (status === "ready" || status === "skipped") return "green";
          if (status === "failed") return "red";
          if (status === "missing") return "yellow";
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

      {/* ══ HINT LINE ══ */}
      <Box marginTop={1} flexDirection="row">
        <Text color="gray">Press </Text>
        <Text color="yellow" bold>[Esc]</Text>
        <Text color="gray"> or </Text>
        <Text color="yellow" bold>[s]</Text>
        <Text color="gray"> to skip remaining downloads & enter terminal</Text>
      </Box>
    </Box>
  );
}
