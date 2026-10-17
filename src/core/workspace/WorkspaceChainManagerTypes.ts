import type { Client } from "ssh2";
import type SFTPClient from "ssh2-sftp-client";
import type { WorkspaceChain, WorkspaceNode } from "./WorkspaceChainTypes.js";

/** SSH/SFTP resources owned by one Workspace Chain node. */
export interface ChainSshConnection {
  nodeId: string;
  client: Client;
  sftp: SFTPClient;
  config: WorkspaceNode["sshConfig"];
}

/** Request-local active chain selection. */
export interface WorkspaceChainRequestContext {
  activeChain: WorkspaceChain | null;
  activeNodeId: string | null;
}
