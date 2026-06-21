import { useCallback } from "react";
// Import sub-wizards
import { useLoginWizard } from "./wizard/useLoginWizard.js";
import { useModelWizard } from "./wizard/useModelWizard.js";
import { useGoalWizard } from "./wizard/useGoalWizard.js";
export function useWizardSubmit(ctx) {
    const { activeWizard, setActiveWizard, wizardOptions, setWizardOptions, wizardSelectedIndex, setWizardSelectedIndex, addLine, setIsProcessing, setPlanState, agentRef, pendingQuestion, setPendingQuestion, planState, streamBufferRef, setStreamDisplay, } = ctx;
    const handleLoginWizard = useLoginWizard(ctx);
    const handleModelWizard = useModelWizard(ctx);
    const handleGoalWizard = useGoalWizard(ctx);
    const handleWizardSubmit = useCallback((value) => {
        if (!activeWizard)
            return;
        const now = Date.now();
        if (activeWizard.type === "login") {
            handleLoginWizard(value, activeWizard.step, activeWizard.data);
            return;
        }
        if (activeWizard.type === "model") {
            handleModelWizard(value, activeWizard.step, activeWizard.data);
            return;
        }
        if (activeWizard.type === "goal") {
            handleGoalWizard(value, activeWizard.step, activeWizard.data);
            return;
        }
        if (activeWizard.type === "plan_approve") {
            // Step 2: custom feedback — send feedback to agent for revision
            if (activeWizard.step === 2) {
                const feedback = (typeof value === "string" ? value : "").trim();
                if (!feedback)
                    return;
                if (agentRef.current) {
                    agentRef.current.planState = "IDLE";
                    setPlanState("IDLE");
                    setIsProcessing(true);
                    streamBufferRef.current = "";
                    setStreamDisplay("");
                    agentRef.current.sendMessage(`Plan revision feedback: ${feedback}`).catch((err) => {
                        setIsProcessing(false);
                        addLine({ type: "error", content: `Plan feedback error: ${err.message}`, timestamp: Date.now() });
                    });
                }
                addLine({
                    type: "system",
                    content: `💬 Plan feedback sent: "${feedback.slice(0, 100)}${feedback.length > 100 ? "..." : ""}"`,
                    timestamp: now,
                });
                setActiveWizard(null);
                setWizardOptions([]);
                setWizardSelectedIndex(0);
                return;
            }
            // Step 1: approve / reject
            const approved = value === "approve";
            if (approved && planState === "APPROVED")
                return;
            if (approved) {
                if (agentRef.current) {
                    agentRef.current.approvePlan();
                    setPlanState("APPROVED");
                    setIsProcessing(true);
                    streamBufferRef.current = "";
                    setStreamDisplay("");
                    agentRef.current.sendMessage("Implementation plan approved via interactive approval wizard. Continue with the approved plan now.").catch((err) => {
                        setIsProcessing(false);
                        addLine({ type: "error", content: `Plan approval resume error: ${err.message}`, timestamp: Date.now() });
                    });
                }
                addLine({
                    type: "system",
                    content: "✅ Implementation plan approved! Continuing with the approved plan now.",
                    timestamp: now,
                });
            }
            else {
                // Reject — stop the agent process
                if (agentRef.current) {
                    agentRef.current.planState = "IDLE";
                    setPlanState("IDLE");
                    agentRef.current.abort();
                }
                setIsProcessing(false);
                addLine({
                    type: "system",
                    content: "❌ Implementation plan rejected. Agent process stopped.",
                    timestamp: now,
                });
            }
            setActiveWizard(null);
            setWizardOptions([]);
            setWizardSelectedIndex(0);
            return;
        }
        if (activeWizard.type === "question") {
            if (pendingQuestion) {
                pendingQuestion.resolve(value);
                addLine({
                    type: "system",
                    content: `❓ Answered: "${value}"`,
                    timestamp: now,
                });
                setPendingQuestion(null);
            }
            setActiveWizard(null);
            setWizardOptions([]);
            setWizardSelectedIndex(0);
            return;
        }
    }, [
        activeWizard,
        handleLoginWizard,
        handleModelWizard,
        handleGoalWizard,
        planState,
        agentRef,
        setPlanState,
        setIsProcessing,
        streamBufferRef,
        setStreamDisplay,
        addLine,
        setActiveWizard,
        setWizardOptions,
        setWizardSelectedIndex,
        pendingQuestion,
        setPendingQuestion,
    ]);
    return handleWizardSubmit;
}
//# sourceMappingURL=useWizardSubmit.js.map