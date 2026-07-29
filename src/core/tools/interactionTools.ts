import { Tool, ScheduleJob } from "./types.js";
import { scheduledJobs, notifyScheduleTriggered } from "./state.js";

export const askQuestionTool: Tool = {
  name: "ask_question",
  description: "Ask the user a question. For select/multi-select, provide options. For text/password input, leave options empty or omit.",
  parameters: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The question to ask the user",
      },
      options: {
        type: "array",
        description: "List of options for the user to choose from",
        items: {
          type: "string",
        },
      },
      isMultiSelect: {
        type: "boolean",
        description: "If true, the user can select multiple options using space and submit with Enter",
      },
      type: {
        type: "string",
        enum: ["select", "text", "password"],
        description: "Input type: 'select' (default, multiple-choice), 'text' (free-text), 'password' (masked text). Default: select.",
      },
    },
    required: ["question", "options"],
  },
  async execute(args, cwd, signal) {
    // Determine the calling agent's tier to route the question appropriately.
    // Master/Single tier → forward to user UI (activeQuestionHandler).
    // Superagent/Subagent tier → route to Master Agent LLM for answering.
    const { agentLocalStorage } = await import("../agent.js");
    const { getMasterAgent, getActiveQuestionHandler, appendMasterLog } = await import("./state.js");
    const currentAgent = agentLocalStorage.getStore();
    const currentTier = currentAgent ? (currentAgent as any).tier : undefined;
    const handler = getActiveQuestionHandler();

    // Check if we are running in a multi-question workflow
    let questionsVal = args.questions;
    if (typeof questionsVal === "string") {
      try {
        const parsed = JSON.parse(questionsVal);
        if (Array.isArray(parsed)) {
          questionsVal = parsed;
        }
      } catch (e) {}
    }

    const hasQuestionsArray = Array.isArray(questionsVal) && questionsVal.length > 0;

    if (hasQuestionsArray) {
      const questionsList = questionsVal as any[];
      const normalizedQuestions = questionsList.map((q: any, idx: number) => {
        const qText = q.question as string || "";
        let qOptsRaw = q.options || [];
        if (typeof qOptsRaw === "string") {
          try {
            const parsed = JSON.parse(qOptsRaw);
            if (Array.isArray(parsed)) {
              qOptsRaw = parsed;
            }
          } catch (e) {}
        }
        const qOpts = Array.isArray(qOptsRaw) ? qOptsRaw.map(o => String(o)) : [];
        const isMsRaw = q.isMultiSelect !== undefined ? q.isMultiSelect : q.is_multi_select;
        const isMs = typeof isMsRaw === "string" ? isMsRaw.toLowerCase() === "true" : !!isMsRaw;
        const inputTypeRaw: string = q.inputType || "";
        const inputType: "select" | "text" | "password" | undefined = inputTypeRaw === "text" || inputTypeRaw === "password" ? inputTypeRaw : undefined;
        return { question: qText, options: qOpts, isMultiSelect: isMs, inputType };
      });

      if (currentTier === "superagent" || currentTier === "subagent") {
        const master = getMasterAgent();
        const role = (currentAgent as any).subagentType || (currentAgent as any).tier || "?";
        const sourceLabel = currentTier === "superagent" ? `Superagent "${role}"` : `Subagent (${role})`;
        
        const answers: string[] = [];
        for (const q of normalizedQuestions) {
          appendMasterLog(`[QUESTION] ${sourceLabel} asks: ${q.question} | Options: ${q.options.join(", ")}`);
          if (master && typeof master.answerQuestionAsMaster === "function") {
            try {
              const selected = await master.answerQuestionAsMaster(q.question, q.options, {
                source: currentTier,
                role,
                typeName: (currentAgent as any).subagentType,
              });
              appendMasterLog(`[MASTER ANSWER] For ${sourceLabel}: "${selected}"`);
              answers.push(selected);
            } catch (err: any) {
              answers.push(`Error: ${err.message}`);
            }
          } else if (handler) {
            try {
              const selected = await handler(q.question, q.options, q.isMultiSelect, undefined, q.inputType);
              answers.push(String(selected));
            } catch (err: any) {
              answers.push(`Error: ${err.message}`);
            }
          } else {
            answers.push("Error: No handler");
          }
        }
        return JSON.stringify(answers);
      }

      // Master / Single tier — forward to activeQuestionHandler directly passing the array of questions
      if (normalizedQuestions.length === 1) {
        if (!handler) {
          return "Error: ask_question must be executed interactively. No question handler is registered.";
        }
        try {
          const q = normalizedQuestions[0];
          const inputType = q.inputType;
          const result = await handler(q.question, q.options, q.isMultiSelect, undefined, inputType);
          return `User selected option: "${result}"`;
        } catch (err: any) {
          return `Error getting user answer: ${err.message}`;
        }
      }

      if (!handler) {
        return "Error: ask_question must be executed interactively. No question handler is registered.";
      }
      try {
        const result = await handler(normalizedQuestions);
        if (Array.isArray(result)) {
          return JSON.stringify(result);
        }
        return String(result);
      } catch (err: any) {
        return `Error getting user answer: ${err.message}`;
      }
    }

    let question = args.question as string || "";
    let rawOptionsVal = args.options;
    let isMultiSelectRaw = args.isMultiSelect !== undefined ? args.isMultiSelect : (args as any).is_multi_select;
    let isMultiSelect: boolean | undefined = undefined;
    if (isMultiSelectRaw !== undefined) {
      isMultiSelect = typeof isMultiSelectRaw === "string" ? isMultiSelectRaw.toLowerCase() === "true" : !!isMultiSelectRaw;
    }
    let inputType: "text" | "password" | undefined = undefined;
    const rawType = args.type as string;
    if (rawType === "text" || rawType === "password") inputType = rawType;

    if (typeof rawOptionsVal === "string") {
      try {
        const parsed = JSON.parse(rawOptionsVal);
        if (Array.isArray(parsed)) {
          rawOptionsVal = parsed;
        }
      } catch (e) {}
    }

    const rawOptions = Array.isArray(rawOptionsVal)
      ? rawOptionsVal
      : (rawOptionsVal !== undefined && rawOptionsVal !== null ? [rawOptionsVal] : []);
    const options: string[] = rawOptions.map(o => String(o));

    if (currentTier === "superagent" || currentTier === "subagent") {
      const master = getMasterAgent();
      if (master && typeof master.answerQuestionAsMaster === "function") {
        const role = (currentAgent as any).subagentType || (currentAgent as any).tier || "?";
        const sourceLabel = currentTier === "superagent" ? `Superagent "${role}"` : `Subagent (${role})`;
        appendMasterLog(`[QUESTION] ${sourceLabel} asks: ${question} | Options: ${options.join(", ")}`);
        try {
          const selected = await master.answerQuestionAsMaster(question, options, {
            source: currentTier,
            role,
            typeName: (currentAgent as any).subagentType,
          });
          appendMasterLog(`[MASTER ANSWER] For ${sourceLabel}: "${selected}"`);
          return `Master Agent selected option: "${selected}"`;
        } catch (err: any) {
          return `Error getting Master Agent answer: ${err.message}`;
        }
      }
      // Single-mode fallback (no Master registered): route to user UI
      if (handler) {
        const role = (currentAgent as any).subagentType || (currentAgent as any).tier || "?";
        const prefix = currentTier === "superagent" ? `[Superagent "${role}"]` : `[Subagent (${role})]`;
        try {
          const selected = await handler(`${prefix}: ${question}`, options, isMultiSelect, undefined, inputType);
          return `User selected option: "${selected}"`;
        } catch (err: any) {
          return `Error getting user answer: ${err.message}`;
        }
      }
      return `Error: No question handler available to route the question from tier "${currentTier}".`;
    }

    if (!handler) {
      return `Error: ask_question must be executed interactively. No question handler is registered.`;
    }

    try {
      const selected = await handler(question, options, isMultiSelect, undefined, inputType);
      return `User selected option: "${selected}"`;
    } catch (err: any) {
      return `Error getting user answer: ${err.message}`;
    }
  },
};

export const scheduleTool: Tool = {
  name: "schedule",
  description: "Schedule a one-shot timer or recurring notification in the background. Optionally wait for it synchronously.",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "The message prompt to display when triggered",
      },
      durationSeconds: {
        type: "number",
        description: "Wait duration in seconds before triggering (for one-shot)",
      },
      cronExpression: {
        type: "string",
        description: "Simple interval (e.g. '1s' for 1 second, '5m' for 5 minutes, '1h' for 1 hour) for recurring checks",
      },
      wait: {
        type: "boolean",
        description: "Whether the tool should block and wait synchronously for the duration before returning control to the agent",
      },
    },
    required: ["prompt"],
  },
  async execute(args, cwd, signal) {
    const prompt = args.prompt as string;
    const durationSeconds = args.durationSeconds as number;
    const cronExpression = args.cronExpression as string;
    const wait = args.wait as boolean ?? false;
    const jobId = Math.random().toString(36).substring(2, 9);

    if (!durationSeconds && !cronExpression) {
      return "Error: Either durationSeconds or cronExpression must be provided.";
    }

    const job: ScheduleJob = { id: jobId, prompt };

    if (durationSeconds) {
      const ms = durationSeconds * 1000;
      
      if (wait) {
        const MAX_WAIT_SECONDS = 300;
        if (durationSeconds > MAX_WAIT_SECONDS) {
          return `Error: Maximum blocking wait duration is ${MAX_WAIT_SECONDS} seconds (requested: ${durationSeconds}s). Use background scheduling (wait: false) for longer delays.`;
        }

        await new Promise<void>((resolve, reject) => {
          let secondsLeft = durationSeconds;
          
          const interval = setInterval(() => {
            secondsLeft--;
            if (secondsLeft > 0) {
              process.stdout.write(`\r⏳ Active waiting: ${secondsLeft}s remaining... `);
            } else {
              process.stdout.write(`\r⏳ Active waiting: done!          \n`);
              clearInterval(interval);
            }
          }, 1000);

          const timeout = setTimeout(() => {
            clearInterval(interval);
            console.log(`\n[Schedule Triggered (ID: ${jobId})]: ${prompt}`);
            cleanup();
            resolve();
          }, ms);

          const onAbort = () => {
            clearInterval(interval);
            clearTimeout(timeout);
            cleanup();
            const err = new Error("AbortError");
            err.name = "AbortError";
            reject(err);
          };

          const cleanup = () => {
            if (signal) {
              signal.removeEventListener("abort", onAbort);
            }
          };

          if (signal) {
            signal.addEventListener("abort", onAbort);
          }
          
          process.stdout.write(`⏳ Active waiting: ${secondsLeft}s remaining... `);
        });
        
        return `One-shot timer ID: ${jobId} triggered after waiting ${durationSeconds} seconds. Prompt: ${prompt}`;
      } else {
        job.timer = setTimeout(() => {
          console.log(`\n[Schedule Triggered (ID: ${jobId})]: ${prompt}`);
          notifyScheduleTriggered(jobId, prompt);
          scheduledJobs.delete(jobId);
        }, ms);
        if (typeof job.timer?.unref === "function") job.timer.unref();
        scheduledJobs.set(jobId, job);
        return `One-shot timer scheduled with ID: ${jobId} (triggers in ${durationSeconds} seconds)`;
      }
    }

    if (cronExpression) {
      const match = cronExpression.match(/^(\d+)([smh])$/);
      if (!match) {
        return "Error: cronExpression must be a simple interval like '10s', '5m', or '2h'.";
      }
      const val = parseInt(match[1], 10);
      const unit = match[2];
      let ms = val * 1000;
      if (unit === "m") ms *= 60;
      if (unit === "h") ms *= 3600;

      job.interval = setInterval(() => {
        console.log(`\n[Recurring Schedule Triggered (ID: ${jobId})]: ${prompt}`);
        notifyScheduleTriggered(jobId, prompt);
      }, ms);
      if (typeof job.interval?.unref === "function") job.interval.unref();
      scheduledJobs.set(jobId, job);
      return `Recurring schedule configured with ID: ${jobId} (triggers every ${cronExpression})`;
    }

    return "Error scheduling job.";
  },
};
