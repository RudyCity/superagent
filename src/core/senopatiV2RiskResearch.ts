/**
 * Research-only risk escalation proposal for Senopati V2 shadow diagnostics.
 * It is NOT imported by the production safety guard or ToolExecutor.
 * Never lowers an existing risk label, grants a tool permission or silently
 * treats a question about a sensitive action as an approved action.
 */
import type { SenopatiV2ShadowLabels } from "./senopatiV2Shadow.js";

export type RiskLabel = SenopatiV2ShadowLabels["risk"];
export type RiskResearchReason =
  "unfamiliar_external_delivery" | "unfamiliar_wire_beneficiary" |
  "existing_high_risk" | "no_specific_signal";

const EXTERNAL_DELIVERY =
  /\b(?:kirim|send|share|forward|bagikan|emailkan|transmit)\b/i;
const DOCUMENT =
  /\b(?:laporan|report|dokumen|document|file|files|data|attachment|lampiran|invoice|berkas)\b/i;
const EXTERNAL_UNFAMILIAR =
  /\b(?:eksternal|external|outside|third[- ]party|pihak luar)\b.{0,75}\b(?:tidak dikenal|belum dikenal|unknown|unfamiliar|unverified|untrusted|belum diverifikasi)\b|\b(?:tidak dikenal|belum dikenal|unknown|unfamiliar|unverified|untrusted)\b.{0,75}\b(?:eksternal|external|recipient|penerima|alamat email|email|destination|pihak luar)\b/i;
const WIRE =
  /\b(?:wire transfer|bank transfer|international transfer|transfer bank|transfer dana|transfer uang|transfer kawat)\b/i;
const AUTHORIZE =
  /\b(?:authorize|authorise|approve|execute|send|initiate|confirm|proses|setujui|otorisasi|otorisasikan|izinkan|jalankan|lakukan)\b/i;
const UNKNOWN_BENEFICIARY =
  /\b(?:unfamiliar|unknown|unverified|untrusted|new|baru|belum dikenal|tidak dikenal|belum diverifikasi)\b.{0,70}\b(?:beneficiary|recipient|payee|penerima|rekening tujuan|tujuan|pihak)\b|\b(?:beneficiary|recipient|payee|penerima|rekening tujuan|tujuan|pihak)\b.{0,70}\b(?:unfamiliar|unknown|unverified|untrusted|new|baru|belum dikenal|tidak dikenal|belum diverifikasi)\b/i;
const RANK:Record<RiskLabel,number> = {safe:0,sensitive:1,destructive:2};

export interface RiskResearchObservation {
  readonly label:RiskLabel;
  readonly baseline:RiskLabel;
  readonly proposal:RiskLabel;
  readonly reason:RiskResearchReason;
  readonly escalated:boolean;
  readonly source:"senopati-risk-research-v1";
  readonly authorizesExecution:false;
  readonly eligibleForAutomaticToolRouting:false;
  readonly confidenceCalibrated:false;
}

export function observeExperimentalRisk(text:string, baseline:RiskLabel):RiskResearchObservation {
  if(typeof text!=="string"||text.length>8192||!Object.hasOwn(RANK,baseline))
    throw new Error("Invalid risk research request or baseline");
  const normalized=text.normalize("NFKC").replace(/\s+/gu," ").trim();
  let proposal:RiskLabel="safe";
  let reason:RiskResearchReason="no_specific_signal";
  if(EXTERNAL_DELIVERY.test(normalized) && DOCUMENT.test(normalized) &&
     EXTERNAL_UNFAMILIAR.test(normalized)){
    proposal="sensitive";
    reason="unfamiliar_external_delivery";
  } else if(WIRE.test(normalized) && AUTHORIZE.test(normalized) &&
            UNKNOWN_BENEFICIARY.test(normalized)){
    proposal="sensitive";
    reason="unfamiliar_wire_beneficiary";
  }
  const label=RANK[baseline]>=RANK[proposal]?baseline:proposal;
  if(proposal==="safe"&&baseline!=="safe")reason="existing_high_risk";
  return {
    label,baseline,proposal,reason,
    escalated:RANK[label]>RANK[baseline],
    source:"senopati-risk-research-v1",
    authorizesExecution:false,
    eligibleForAutomaticToolRouting:false,
    confidenceCalibrated:false,
  };
}
