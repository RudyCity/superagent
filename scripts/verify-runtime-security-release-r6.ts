/**
 * R6 read-only release evidence.
 * Exit 0 means the SAFETY POLICY behaved correctly, not certification.
 * Never claims Windows reboot, installed desktop, public TLS, OAuth client
 * migration or a production endpoint cutover from a developer machine.
 */
import {inspectLiveRuntimeRollout} from "../src/core/runtime/runtimeReleaseGateR7.js";
import {captureRuntimeOwnership} from "../src/core/runtime/runtimeOwnershipContract.js";
import {assessRuntimeColdRecovery} from "../src/core/runtime/runtimeColdRecoveryR5.js";
const port=process.argv.length===2?7888:Number(process.argv[2]);
if(!Number.isSafeInteger(port)||port<1024||port>65535)
  throw new Error("Provide a valid local Core port");
const ownership=await captureRuntimeOwnership(port);
const release=await inspectLiveRuntimeRollout(port);
const cold=assessRuntimeColdRecovery({
  coreCheckpoint:"stale_or_corrupt",
  coreOwner:"unverified",mcpOwner:"stale_or_unverified",
  oauthStorage:"corrupt_or_key_missing",ingressOwner:"stale_or_unverified",
  pendingExternalEffects:null,stalePidReused:true,
});
if(release.status!=="blocked"||release.decisions.automaticLiveCutoverAllowed||
   release.decisions.oauthTokenImportAllowed||
   release.decisions.canReplayUnknownToolEffects||
   release.decisions.canStopSharedCorePid||
   cold.canRestartProduction||cold.automaticToolReplayAllowed||
   ownership.canRestartCore||ownership.canStopMcp||ownership.canTransferOAuth)
  throw new Error("R6 fail-closed policy violated: automated cutover/replay possible");
const report={
  version:1,phase:"R6_read_only_release_evidence",
  localChecksPassed:true,productionCertified:false,
  publicTunnelCreated:false,oauthTokensImported:false,
  processSignalsSent:false,productionCutoverPerformed:false,
  ownershipTopology:ownership.ownershipTopology,
  releaseStatus:release.status,
  coldRecoveryDecision:cold.status,
  productionBlockers:release.blockers,
  unresolvedRequiredCertificates:[
    "INSTALLED_DESKTOP_E2E","EXTENDED_SOAK",
    "WINDOWS_REBOOT_STAGING","PRODUCTION_OS_KEYSTORE_AND_TLS",
    "CLIENT_REAUTHORIZATION_AND_DRAIN",
  ],
};
console.log(JSON.stringify(report,null,2));
