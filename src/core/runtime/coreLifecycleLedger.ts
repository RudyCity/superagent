/**
 * Durable, bounded idempotency ledger for supervised API Core mutations.
 * A pending operation is NEVER automatically replayed after a timeout/crash.
 * The record is scoped to the supervisor public port, not an MCP session.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getRootConfigDir } from "../config/paths.js";

export type CoreLifecycleLedgerAction = "restart" | "rollback" | "drain";
export type CoreOperationState = "pending" | "completed" | "failed";
export interface CoreOperationReceipt {
  operationHash: string;
  action: CoreLifecycleLedgerAction;
  expectedBuildDigest: string;
  state: CoreOperationState;
  startedAt: number;
  completedAt?: number;
  beforePid: number;
  afterPid?: number;
  errorCode?: string;
}
type Snapshot = {version:1;port:number;operations:CoreOperationReceipt[]};
const VALID_ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{15,127}$/;
const VALID_DIGEST=/^[a-f0-9]{64}$/;
const LIMIT=256;

export function validateCoreOperationId(id:unknown):string {
  if(typeof id!=="string" || !VALID_ID.test(id))
    throw new Error("CORE_OPERATION_ID_REQUIRED: 16-128 URL-safe characters");
  return id;
}
export const coreOperationsPath=(port:number)=>
  path.join(getRootConfigDir(),"core-control-operations-"+port+".json");

function validReceipt(x:any):x is CoreOperationReceipt {
  return x && typeof x.operationHash==="string" && VALID_DIGEST.test(x.operationHash) &&
    ["restart","rollback","drain"].includes(x.action) &&
    typeof x.expectedBuildDigest==="string" && VALID_DIGEST.test(x.expectedBuildDigest) &&
    ["pending","completed","failed"].includes(x.state) &&
    Number.isSafeInteger(x.startedAt) && x.startedAt>0 &&
    Number.isSafeInteger(x.beforePid) && x.beforePid>0 &&
    (x.afterPid===undefined || (Number.isSafeInteger(x.afterPid)&&x.afterPid>0)) &&
    (x.completedAt===undefined || (Number.isSafeInteger(x.completedAt)&&x.completedAt>0)) &&
    (x.errorCode===undefined || (typeof x.errorCode==="string" && x.errorCode.length<=100));
}
export class CoreLifecycleLedger {
  readonly file:string;
  private state:Snapshot;
  constructor(readonly port:number) {
    if(!Number.isSafeInteger(port)||port<1||port>65535)throw new Error("CORE_LEDGER_INVALID_PORT");
    this.file=coreOperationsPath(port);
    this.state={version:1,port,operations:[]};
    if(fs.existsSync(this.file)) {
      const stat=fs.lstatSync(this.file);
      if(!stat.isFile() || stat.isSymbolicLink() || stat.size>150000)
        throw new Error("CORE_LEDGER_UNSAFE_FILE");
      const value=JSON.parse(fs.readFileSync(this.file,"utf8")) as Snapshot;
      if(value.version!==1||value.port!==port||!Array.isArray(value.operations)||
         value.operations.length>LIMIT||
         value.operations.some(item=>!validReceipt(item))||
         new Set(value.operations.map(item=>item.operationHash)).size!==value.operations.length)
        throw new Error("CORE_LEDGER_CORRUPT");
      this.state=value;
    }
  }
  private persist() {
    const dir=path.dirname(this.file);
    fs.mkdirSync(dir,{recursive:true,mode:0o700});
    if(fs.lstatSync(dir).isSymbolicLink())throw new Error("CORE_LEDGER_UNSAFE_DIRECTORY");
    const tmp=this.file+"."+process.pid+"."+crypto.randomBytes(5).toString("hex")+".tmp";
    try {
      const fd=fs.openSync(tmp,"wx",0o600);
      try {
        fs.writeFileSync(fd,JSON.stringify(this.state));
        fs.fsyncSync(fd);
      } finally {fs.closeSync(fd);}
      fs.renameSync(tmp,this.file);
    } finally {try{fs.rmSync(tmp,{force:true});}catch{}}
  }
  private hash(id:string){return crypto.createHash("sha256").update(id).digest("hex");}
  /** Pick up an operator's offline reconciliation without restarting supervisor. */
  private refresh() { this.state=new CoreLifecycleLedger(this.port).state; }
  get(id:string){validateCoreOperationId(id);return this.state.operations.find(x=>x.operationHash===this.hash(id));}
  inspect() {
    return this.state.operations.map(({operationHash,action,state,startedAt,completedAt,beforePid,afterPid,errorCode})=>
      ({operationHashPrefix:operationHash.slice(0,16),action,state,startedAt,completedAt,beforePid,afterPid,errorCode}));
  }
  begin(input:{id:string;action:CoreLifecycleLedgerAction;expectedBuildDigest:string;beforePid:number}):
    {receipt:CoreOperationReceipt;replayed:boolean} {
    validateCoreOperationId(input.id);
    this.refresh();
    if(!VALID_DIGEST.test(input.expectedBuildDigest))throw new Error("CORE_OPERATION_BUILD_DIGEST_REQUIRED");
    const hash=this.hash(input.id);
    const existing=this.state.operations.find(item=>item.operationHash===hash);
    if(existing) {
      if(existing.action!==input.action || existing.expectedBuildDigest!==input.expectedBuildDigest)
        throw new Error("CORE_OPERATION_ID_CONFLICT: operation ID already bound to different arguments");
      if(existing.state!=="completed")
        throw new Error(existing.state==="pending"?"CORE_OPERATION_UNCERTAIN_PENDING_RECONCILIATION":"CORE_OPERATION_PREVIOUSLY_FAILED");
      return {receipt:existing,replayed:true};
    }
    // No automatic replay of potentially mutating operations after a supervisor crash.
    if(this.state.operations.some(item=>item.state==="pending"))
      throw new Error("CORE_OPERATION_UNCERTAIN_PENDING_RECONCILIATION");
    const last=this.state.operations.at(-1);
    if(last && last.state==="completed" && input.action==="restart" && last.action==="restart" &&
       (last.completedAt??0)>Date.now()-5000)
      throw new Error("CORE_OPERATION_COOLDOWN: restart rate limited to protect session generations");
    if(this.state.operations.length>=LIMIT) {
      const removed=this.state.operations.shift();
      if(removed?.state==="pending")throw new Error("CORE_LEDGER_CAPACITY_EXHAUSTED");
    }
    const receipt:CoreOperationReceipt={operationHash:hash,action:input.action,
      expectedBuildDigest:input.expectedBuildDigest,state:"pending",
      startedAt:Date.now(),beforePid:input.beforePid};
    this.state.operations.push(receipt);
    this.persist();
    return {receipt,replayed:false};
  }
  /**
   * Local operator-only reconciliation after process interruption.
   * The caller MUST authenticate the current Core supervisor and compare its
   * active PID with the supplied observed PID. Never auto-replay this receipt.
   */
  reconcilePending(id:string,observedPid:number,currentPid:number,acknowledge:boolean) {
    this.refresh();
    const receipt=this.get(id);
    if(!receipt||receipt.state!=="pending")
      throw new Error("CORE_OPERATION_NO_PENDING_RECEIPT");
    if(acknowledge!==true || Date.now()-receipt.startedAt<120000 ||
       !Number.isSafeInteger(observedPid) || observedPid<=0 ||
       observedPid!==currentPid)
      throw new Error("CORE_OPERATION_OPERATOR_ATTESTATION_REQUIRED");
    receipt.state="failed";receipt.completedAt=Date.now();
    receipt.afterPid=currentPid;receipt.errorCode="OPERATOR_RECONCILED_UNKNOWN";
    this.persist();
    return {
      operationHashPrefix:receipt.operationHash.slice(0,16),state:receipt.state,
      observedActivePid:currentPid,executedAgain:false,
      note:"Ambiguous operation was marked reviewed, NOT replayed. Inspect retained workers and external side effects manually.",
    };
  }
  complete(id:string,afterPid:number) {
    const item=this.get(id);
    if(!item || item.state!=="pending" || !Number.isSafeInteger(afterPid)||afterPid<=0)
      throw new Error("CORE_LEDGER_UNEXPECTED_COMPLETION");
    item.state="completed";item.completedAt=Date.now();item.afterPid=afterPid;
    this.persist();
  }
  fail(id:string,code:string) {
    const item=this.get(id);
    if(!item || item.state!=="pending")throw new Error("CORE_LEDGER_UNEXPECTED_FAILURE");
    item.state="failed";item.completedAt=Date.now();item.errorCode=code.slice(0,100);
    this.persist();
  }
}
