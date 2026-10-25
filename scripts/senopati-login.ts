/** Per-user Windows logon launcher; no network, MCP or agent startup. */
import {startSenopatiLifecycle} from "../src/core/senopatiLifecycle.js";
const outcome=await startSenopatiLifecycle();
if(outcome==="launch-failed"){
  console.error("Senopati shared inference watchdog could not start");
  process.exitCode=1;
}
