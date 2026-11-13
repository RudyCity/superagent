import {
  planStaleManagedGuardianRecovery,recoverStaleManagedGuardian,
} from "../src/core/runtime/managedGuardianStaleRecovery.js";

const [action,portText,digest,supervisorText,approval]=process.argv.slice(2);
const port=Number(portText);
if(!["plan","apply"].includes(action)||!Number.isSafeInteger(port))
  throw new Error("Usage: bun scripts/recover-stale-guardian.ts plan PORT | apply PORT DIGEST SUPERVISOR_PID --reviewed");
if(action==="plan"){
  const info=await planStaleManagedGuardianRecovery(port);
  console.log(JSON.stringify({...info,recordsValidated:true,changesMade:false},null,2));
}else{
  const outcome=await recoverStaleManagedGuardian({
    port,expectedDigest:digest??"",expectedSupervisorPid:Number(supervisorText),
    reviewed:approval==="--reviewed",
  });
  console.log(JSON.stringify(outcome,null,2));
}
