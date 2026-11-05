export {
  handleMuseTunnelStart,
  handleMuseTunnelRestart,
  REMOTE_AGENT_TUNNEL_MCP_TOOL_CLASSIFICATIONS,
  REMOTE_AGENT_TUNNEL_MCP_TOOL_DEFS,
} from "./remoteAgentTunnelMcpTools.js";
export {
  handleTelegramSendToMuse,
  REMOTE_AGENT_TELEGRAM_MCP_TOOL_CLASSIFICATIONS,
  REMOTE_AGENT_TELEGRAM_MCP_TOOL_DEFS,
} from "./remoteAgentTelegramMcpTools.js";
export {
  handleTelegramSendFile,
  handleMuseSendFile,
  handleMuseFileStatus,
  handleMuseFileCancel,
  REMOTE_AGENT_FILE_MCP_TOOL_CLASSIFICATIONS,
  REMOTE_AGENT_FILE_MCP_TOOL_DEFS,
} from "./remoteAgentFileMcpTools.js";
export {
  getMuseChatReadiness,
  handleMuseChatStatus,
  handleMuseChat,
  REMOTE_AGENT_CHAT_MCP_TOOL_CLASSIFICATIONS,
  REMOTE_AGENT_CHAT_MCP_TOOL_DEFS,
} from "./remoteAgentChatMcpTools.js";

import {
  REMOTE_AGENT_TUNNEL_MCP_TOOL_CLASSIFICATIONS,
  REMOTE_AGENT_TUNNEL_MCP_TOOL_DEFS,
  handleMuseTunnelRestart,
  handleMuseTunnelStart,
} from "./remoteAgentTunnelMcpTools.js";
import {
  REMOTE_AGENT_TELEGRAM_MCP_TOOL_CLASSIFICATIONS,
  REMOTE_AGENT_TELEGRAM_MCP_TOOL_DEFS,
  handleTelegramSendToMuse,
} from "./remoteAgentTelegramMcpTools.js";
import {
  REMOTE_AGENT_CHAT_MCP_TOOL_CLASSIFICATIONS,
  REMOTE_AGENT_CHAT_MCP_TOOL_DEFS,
  handleMuseChat,
  handleMuseChatStatus,
} from "./remoteAgentChatMcpTools.js";

import {
  handleTelegramSendFile,
  handleMuseSendFile,
  handleMuseFileStatus,
  handleMuseFileCancel,
  REMOTE_AGENT_FILE_MCP_TOOL_CLASSIFICATIONS,
  REMOTE_AGENT_FILE_MCP_TOOL_DEFS,
} from "./remoteAgentFileMcpTools.js";

export const REMOTE_AGENT_MCP_TOOL_CLASSIFICATIONS = {
  ...REMOTE_AGENT_TUNNEL_MCP_TOOL_CLASSIFICATIONS,
  ...REMOTE_AGENT_TELEGRAM_MCP_TOOL_CLASSIFICATIONS,
  ...REMOTE_AGENT_CHAT_MCP_TOOL_CLASSIFICATIONS,
  ...REMOTE_AGENT_FILE_MCP_TOOL_CLASSIFICATIONS,
};

export const REMOTE_AGENT_MCP_TOOL_DEFS = [
  ...REMOTE_AGENT_TUNNEL_MCP_TOOL_DEFS,
  ...REMOTE_AGENT_TELEGRAM_MCP_TOOL_DEFS,
  ...REMOTE_AGENT_CHAT_MCP_TOOL_DEFS,
  ...REMOTE_AGENT_FILE_MCP_TOOL_DEFS,
];

export async function dispatchRemoteAgentMcpTool(
  name: string,
  args: Record<string, unknown> = {},
  workspaceRoot?: string,
) {
  switch (name) {
    case "superagent_muse_tunnel_start":
      return handleMuseTunnelStart(args);
    case "superagent_muse_tunnel_restart":
      return handleMuseTunnelRestart(args);
    case "superagent_telegram_send_to_muse":
      return handleTelegramSendToMuse(args);
    case "superagent_telegram_send_file":
      return handleTelegramSendFile(args, workspaceRoot);
    case "superagent_muse_send_file":
      return handleMuseSendFile(args, workspaceRoot);
    case "superagent_muse_file_status":
      return handleMuseFileStatus(args);
    case "superagent_muse_file_cancel":
      return handleMuseFileCancel(args);
    case "superagent_muse_chat_status":
      return handleMuseChatStatus(args);
    case "superagent_muse_chat":
      return handleMuseChat(args);
    default:
      return null;
  }
}
