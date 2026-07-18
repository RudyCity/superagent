export function checkPlanStructure(content: string): boolean {
  const hasTitle = /^#\s+.+/m.test(content);
  if (!hasTitle) return false;

  const hasProposedChanges = /##\s+.*(proposed\s+changes|changes|rencana\s+perubahan|perubahan)/i.test(content);
  const hasVerificationPlan = /##\s+.*(verification\s+plan|verification|rencana\s+verifikasi|verifikasi)/i.test(content);
  const hasAutomatedTests = /(##|###)\s+.*(automated\s+tests|tests|test\s+otomatis)/i.test(content);
  const hasManualVerification = /(##|###)\s+.*(manual\s+verification|manual\s+testing|verifikasi\s+manual)/i.test(content);
  
  const hasArchitecture = /##\s+.*(architecture|arsitektur|refactor|design|desain)/i.test(content);

  // check full template
  const isFull = hasProposedChanges && hasVerificationPlan && hasAutomatedTests && hasManualVerification;
  // check quick template
  const isQuick = hasProposedChanges;
  // check refactor template
  const isRefactor = hasProposedChanges && hasArchitecture;

  return isFull || isQuick || isRefactor;
}
