/**
 * Read-only Cloudflare Named Tunnel reboot/recovery artifacts.
 *
 * No file, service, process, DNS, token, OAuth, or Quick Tunnel mutation occurs.
 * Cross-OS previews are deliberately not equivalent to native attestation.
 */
import fs from "node:fs";
import path from "node:path";
import {
  readRemoteManagedNamedProfile,
  verifyRemoteManagedNamedProfile,
  type RemoteManagedNamedProfile,
} from "./mcpNamedRemoteProfile.js";
import {validateMcpNamedHostname} from "./mcpNamedTunnelConfig.js";
import {getRootConfigDir} from "../config/paths.js";

export type NamedRecoveryPlatform = "win32" | "darwin" | "linux";
export interface NamedRecoveryPreviewInput {
  platform:NamedRecoveryPlatform;
  tunnelId:string;
  hostname:string;
  anchorPort:number;
  ownerPort:number;
  cloudflaredPath:string;
  tokenFilePath:string;
}
export interface NamedRecoveryPlan {
  schemaVersion:1;
  mode:"dry-run";
  platform:NamedRecoveryPlatform;
  tunnelId:string;
  hostname:string;
  publicUrl:string;
  anchorPort:number;
  ownerPort:number;
  artifactType:"windows-task-xml"|"macos-launch-agent-plist"|"linux-systemd-user-unit";
  artifactName:string;
  artifact:string;
  /** Discrete argv for native process APIs; NEVER join and pass to a shell. */
  executable:string;
  argv:readonly ["tunnel","run","--token-file",string];
  bootOrder:readonly ["mcp-owner","mcp-anchor","named-connector"];
  rollbackOrder:readonly ["quarantine-named-connector","retain-current-quick-tunnel","reconcile-owner-and-anchor"];
  verifiedLocalProfile:boolean;
  nativeDependencyVerified:false;
  nativeCredentialAclVerified:false;
  automaticActivation:false;
  productionAuthorized:false;
  requiresOperatorReview:true;
  quickTunnelUnchanged:true;
  blockers:readonly string[];
  operatorActions:readonly string[];
}

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BLOCKED_PORTS=new Set([6759,6789,7888,9227,9877]);
const BLOCKERS=[
  "NAMED_RECOVERY_NATIVE_DEPENDENCY_IDENTITY_NOT_CERTIFIED",
  "NAMED_RECOVERY_NATIVE_TOKEN_ACL_NOT_CERTIFIED",
  "NAMED_RECOVERY_R0_R7_OPERATOR_APPROVAL_REQUIRED",
  "NAMED_RECOVERY_DRY_RUN_NOT_INSTALLED",
] as const;
function invalid(code:string):never{throw Error(code);}
function assertPort(port:number):void{
  if(!Number.isSafeInteger(port)||port<1024||port>65535||BLOCKED_PORTS.has(port))
    invalid("NAMED_RECOVERY_PROTECTED_PORT");
}
function xml(raw:string):string{
  return raw.replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");
}
/**
 * No shell expansion, path placeholders, UNC/device paths, traversal or
 * control characters. All generated paths remain data in argv/XML/plist.
 */
function validatePath(platform:NamedRecoveryPlatform,value:string):void{
  if(typeof value!=="string"||!value||value.length>1024||
     /[\x00-\x1f\x7f`$;|<>*!?%"'{}\[\]]/.test(value)||
     value.includes("..")||value.includes("//")||value.includes("\\\\")||
     /(^|[/\\])(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|[/\\]|$)/i.test(value))
    invalid("NAMED_RECOVERY_PATH_UNSAFE");
  if(platform==="win32"){
    if(!/^[A-Z]:\\(?:[A-Za-z0-9._ ()&+\-]+\\)*[A-Za-z0-9._ ()&+\-]+$/.test(value)||
       value.split("\\").some(part=>part.endsWith(".")||part.endsWith(" "))||
       path.win32.normalize(value)!==value)
      invalid("NAMED_RECOVERY_WINDOWS_PATH_UNSAFE");
  }else{
    // Linux systemd ExecStart parser is intentionally limited to no-space paths.
    const allowed=platform==="linux"
      ? /^\/(?:[A-Za-z0-9._+\/-]+)$/
      : /^\/(?:[A-Za-z0-9._ ()&+\/-]+)$/;
    if(!allowed.test(value)||path.posix.normalize(value)!==value||
       value.startsWith("/dev/")||value.startsWith("/proc/"))
      invalid("NAMED_RECOVERY_UNIX_PATH_UNSAFE");
  }
}
function validateInput(p:NamedRecoveryPreviewInput):void{
  if(!p||!["win32","darwin","linux"].includes(p.platform))
    invalid("NAMED_RECOVERY_OS_UNSUPPORTED");
  if(!UUID.test(p.tunnelId))invalid("NAMED_RECOVERY_UUID_INVALID");
  validateMcpNamedHostname(p.hostname);
  assertPort(p.anchorPort);assertPort(p.ownerPort);
  if(p.anchorPort===p.ownerPort)invalid("NAMED_RECOVERY_PORT_COLLISION");
  validatePath(p.platform,p.cloudflaredPath);
  validatePath(p.platform,p.tokenFilePath);
  const mod=p.platform==="win32"?path.win32:path.posix;
  if(mod.basename(p.cloudflaredPath)!==(p.platform==="win32"?"cloudflared.exe":"cloudflared"))
    invalid("NAMED_RECOVERY_EXECUTABLE_UNSAFE");
  if(mod.basename(p.tokenFilePath)!==p.tunnelId+".token"||
     mod.basename(mod.dirname(p.tokenFilePath))!=="cloudflare-named"||
     mod.basename(mod.dirname(mod.dirname(p.tokenFilePath)))!=="private")
    invalid("NAMED_RECOVERY_TOKEN_OUTSIDE_PRIVATE_PROFILE");
  if(/(?:^|[/\\])(?:Downloads|Desktop|Public|Temp|tmp)(?:[/\\])/i.test(p.tokenFilePath))
    invalid("NAMED_RECOVERY_TOKEN_SHARED_LOCATION");
}
function windowsArg(p:string):string{
  // Quoted literal argument, not cmd.exe / powershell; path contains no quotes.
  return '"'+p+'"';
}
function windowsTask(p:NamedRecoveryPreviewInput):string{
  const args="tunnel run --token-file "+windowsArg(p.tokenFilePath);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Review-only SuperAgent named MCP connector; no task activation permitted</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>false</Enabled></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><Enabled>false</Enabled><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries></Settings>
  <Actions Context="Author"><Exec><Command>${xml(p.cloudflaredPath)}</Command><Arguments>${xml(args)}</Arguments></Exec></Actions>
</Task>
`;
}
function macLaunchAgent(p:NamedRecoveryPreviewInput):string{
  const args=[p.cloudflaredPath,"tunnel","run","--token-file",p.tokenFilePath];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.superagent.mcp-named-recovery</string>
  <key>ProgramArguments</key><array>
${args.map(x=>`    <string>${xml(x)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key><false/>
  <key>KeepAlive</key><false/>
  <key>Disabled</key><true/>
  <key>ProcessType</key><string>Background</string>
</dict></plist>
`;
}
function linuxUserUnit(p:NamedRecoveryPreviewInput):string{
  // Unit references are proposed ordering, NOT a claim the native units exist.
  return `# REVIEW ONLY — disabled user unit; no automatic enablement
[Unit]
Description=SuperAgent Cloudflare Named MCP connector (requires separately verified owner and anchor)
Wants=network-online.target
After=network-online.target superagent-mcp-owner.service superagent-mcp-anchor.service
Requires=superagent-mcp-owner.service superagent-mcp-anchor.service
StartLimitIntervalSec=3600
StartLimitBurst=3

[Service]
Type=simple
ExecStart=${p.cloudflaredPath} tunnel run --token-file ${p.tokenFilePath}
Restart=on-failure
RestartSec=30s
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
UnsetEnvironment=TUNNEL_TOKEN TUNNEL_CRED_CONTENTS TUNNEL_TOKEN_FILE
`;
}
/**
 * Static multi-platform template only. Never treat lexical verification as
 * proof of credentials, ACLs, service identity or connector readiness.
 */
export function renderMcpNamedRecoveryPreview(p:NamedRecoveryPreviewInput):NamedRecoveryPlan{
  validateInput(p);
  const artifactType=p.platform==="win32"?"windows-task-xml"
    :p.platform==="darwin"?"macos-launch-agent-plist":"linux-systemd-user-unit";
  const artifactName=p.platform==="win32"?"SuperAgent-McpNamed-Recovery.xml"
    :p.platform==="darwin"?"com.superagent.mcp-named-recovery.plist"
      :"superagent-mcp-named-recovery.service";
  const artifact=p.platform==="win32"?windowsTask(p)
    :p.platform==="darwin"?macLaunchAgent(p):linuxUserUnit(p);
  return {
    schemaVersion:1,mode:"dry-run",platform:p.platform,
    tunnelId:p.tunnelId,hostname:p.hostname,publicUrl:"https://"+p.hostname+"/mcp",
    anchorPort:p.anchorPort,ownerPort:p.ownerPort,
    artifactType,artifactName,artifact,
    executable:p.cloudflaredPath,
    argv:["tunnel","run","--token-file",p.tokenFilePath],
    bootOrder:["mcp-owner","mcp-anchor","named-connector"],
    rollbackOrder:["quarantine-named-connector","retain-current-quick-tunnel","reconcile-owner-and-anchor"],
    verifiedLocalProfile:false,nativeDependencyVerified:false,
    nativeCredentialAclVerified:false,automaticActivation:false,
    productionAuthorized:false,requiresOperatorReview:true,
    quickTunnelUnchanged:true,blockers:[...BLOCKERS,"NAMED_RECOVERY_PROFILE_NOT_NATIVE_ATTESTED"],
    operatorActions:[
      "Read-only inspect native MCP owner birth identity and authenticated readiness",
      "Read-only inspect native Anchor identity, private route, and verified process lease",
      "Verify token-file owner-only ACL, cloudflared version and signed executable on target OS",
      "Rehearse gated native reboot and rollback in an isolated profile; obtain R0-R7 approval",
    ],
  };
}
function assertNoSymlinkComponents(file:string):void{
  const absolute=path.resolve(file);
  let current=path.parse(absolute).root;
  for(const component of absolute.slice(current.length).split(path.sep)){
    if(!component)continue;
    current=path.join(current,component);
    const stat=fs.lstatSync(current);
    if(stat.isSymbolicLink())invalid("NAMED_RECOVERY_PATH_SYMLINK");
  }
}
function assertPrivateProfile(root:string,p:RemoteManagedNamedProfile):void{
  if(!path.isAbsolute(root))invalid("NAMED_RECOVERY_ROOT_NOT_ABSOLUTE");
  assertNoSymlinkComponents(root);
  assertNoSymlinkComponents(p.tokenFilePath);
  assertNoSymlinkComponents(p.cloudflaredPath);
  const expected=path.join(root,"private","cloudflare-named",p.tunnelId+".token");
  if(path.resolve(expected)!==path.resolve(p.tokenFilePath))
    invalid("NAMED_RECOVERY_TOKEN_OUTSIDE_PRIVATE_PROFILE");
  const token=fs.lstatSync(p.tokenFilePath);
  const dir=fs.lstatSync(path.dirname(p.tokenFilePath));
  if(!token.isFile()||token.nlink!==1||!dir.isDirectory())
    invalid("NAMED_RECOVERY_TOKEN_UNSAFE");
  // Windows ACLs require a separate native SID/ACE attestation; never infer
  // them from fs.stat. POSIX may preflight modes, but is not a final OS gate.
  if(process.platform!=="win32"&&
     ((token.mode&0o077)!==0||(dir.mode&0o077)!==0||
       (typeof process.getuid==="function"&&token.uid!==process.getuid())))
    invalid("NAMED_RECOVERY_POSIX_TOKEN_PERMISSIONS_UNSAFE");
}
/** Only plans the current host; OS deployment and cross-host attestation remain out of scope. */
export function planMcpNamedRecovery(opts:{
  root?:string;expectedTunnelId:string;expectedHostname:string;
  platform?:NamedRecoveryPlatform;
}):NamedRecoveryPlan{
  const requestedPlatform=opts.platform??process.platform;
  if(requestedPlatform!=="win32"&&requestedPlatform!=="darwin"&&requestedPlatform!=="linux")
    invalid("NAMED_RECOVERY_OS_UNSUPPORTED");
  const platform:NamedRecoveryPlatform=requestedPlatform;
  if(platform!==process.platform)invalid("NAMED_RECOVERY_NATIVE_HOST_REQUIRED");
  const root=opts.root??getRootConfigDir();
  const p=readRemoteManagedNamedProfile(root);
  if(p.tunnelId!==opts.expectedTunnelId||p.hostname!==opts.expectedHostname)
    invalid("NAMED_RECOVERY_EXPECTED_IDENTITY_MISMATCH");
  validateInput({...p,platform});
  assertPrivateProfile(root,p);
  const checked=verifyRemoteManagedNamedProfile(root);
  if(checked.tunnelId!==p.tunnelId||checked.hostname!==p.hostname||
     !checked.tokenFileVerified||!checked.cloudflaredPresent)
    invalid("NAMED_RECOVERY_PROFILE_VERIFY_FAILED");
  const plan=renderMcpNamedRecoveryPreview({...p,platform});
  return {...plan,verifiedLocalProfile:true,
    blockers:BLOCKERS};
}
