import path from "path";
import os from "os";
import fs from "fs/promises";
import { Tool } from "./types.js";
import { workspaceMode } from "../ssh/workspaceMode.js";
import { getRootConfigDir } from "../config/paths.js";

export const transferSshFileTool: Tool = {
  name: "transfer_ssh_file",
  description: "Transfer/copy files between the local session history/scratch directory and the remote SSH workspace. Use this to upload helper/scratch code to the remote workspace, or download results/files from the remote workspace to the local session scratch directory.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["upload", "download"],
        description: "Whether to upload from local session scratch directory to remote, or download from remote to local session scratch directory.",
      },
      localPath: {
        type: "string",
        description: "File path relative to or absolute within the local session history/scratch directory.",
      },
      remotePath: {
        type: "string",
        description: "File path relative to or absolute within the remote SSH workspace.",
      },
    },
    required: ["action", "localPath", "remotePath"],
  },
  async execute(args, cwd, signal) {
    if (!workspaceMode.isSsh()) {
      return "Error: This tool is only available when connected to an SSH workspace.";
    }

    const action = args.action as "upload" | "download";
    const rawLocal = args.localPath as string;
    const rawRemote = args.remotePath as string;

    if (!rawLocal || !rawRemote) {
      return "Error: Missing required parameters: localPath and remotePath.";
    }

    // Resolve and validate local path (must be under getRootConfigDir() or session dir)
    let cleanLocal = rawLocal;
    if (cleanLocal.startsWith("~")) {
      cleanLocal = path.join(os.homedir(), cleanLocal.slice(1));
    }

    const sessionPath = process.env.SUPERAGENT_SESSION_PATH;
    const sessionDir = sessionPath ? path.resolve(path.dirname(sessionPath)) : undefined;
    const rootConfig = path.resolve(getRootConfigDir());

    let resolvedLocal = path.resolve(cleanLocal);
    if (!path.isAbsolute(cleanLocal)) {
      resolvedLocal = sessionDir ? path.resolve(sessionDir, cleanLocal) : path.resolve(cleanLocal);
    }

    const isUnderRoot = resolvedLocal.startsWith(rootConfig);
    const isUnderSession = sessionDir && resolvedLocal.startsWith(sessionDir);
    const isModelConfig = resolvedLocal.toLowerCase() === path.join(rootConfig, "model-config.json").toLowerCase();

    if ((!isUnderRoot && !isUnderSession) || isModelConfig) {
      return `Error: Access denied. localPath must be within the local session history or scratch directory, and cannot target model-config.json. Got: ${resolvedLocal}`;
    }

    const { sshProxy } = await import("../ssh/sshProxy.js");

    try {
      if (action === "upload") {
        try {
          await fs.access(resolvedLocal);
        } catch {
          return `Error: Local file does not exist at ${resolvedLocal}`;
        }
        await sshProxy.uploadFile(resolvedLocal, rawRemote);
        return `Successfully uploaded local file ${resolvedLocal} to remote ${rawRemote}`;
      } else {
        await sshProxy.downloadFile(rawRemote, resolvedLocal);
        return `Successfully downloaded remote file ${rawRemote} to local ${resolvedLocal}`;
      }
    } catch (err: any) {
      return `Error transferring file: ${err.message || String(err)}`;
    }
  },
};
