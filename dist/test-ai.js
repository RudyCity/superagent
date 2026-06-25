import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../.env") });
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, jsonSchema } from "ai";
import { getToolDefinitions } from "./core/tools.js";
async function main() {
    const customBaseUrl = process.env.CUSTOM_BASE_URL;
    const customApiKey = process.env.CUSTOM_API_KEY;
    const modelName = process.env.MODEL || "cx/gpt-5.4-mini";
    console.log("URL:", customBaseUrl);
    console.log("Key:", customApiKey?.slice(0, 10) + "...");
    console.log("Model:", modelName);
    const openai = createOpenAI({
        apiKey: customApiKey,
        baseURL: customBaseUrl,
    });
    const toolDefs = getToolDefinitions();
    try {
        console.log("Calling generateText with tools...");
        const result = await generateText({
            model: openai(modelName),
            system: "You are a helpful assistant.",
            messages: [{ role: "user", content: "Hello, who are you? Respond in 1 sentence." }],
            tools: Object.fromEntries(toolDefs.map((t) => [
                t.name,
                {
                    description: t.description,
                    parameters: jsonSchema(t.input_schema),
                },
            ])),
            maxSteps: 1,
        });
        console.log("Text response:", result.text);
        console.log("Tool calls:", result.toolCalls);
        console.log("Done!");
    }
    catch (err) {
        console.error("Caught exception:", err);
    }
}
main();
//# sourceMappingURL=test-ai.js.map