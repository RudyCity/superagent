import { streamText, jsonSchema } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import dotenv from 'dotenv';
import path from 'path';
import os from 'os';

dotenv.config({ path: path.join(os.homedir(), '.superagent-r', '.env') });

const openai = createOpenAI({
  apiKey: process.env.CUSTOM_API_KEY,
  baseURL: process.env.CUSTOM_BASE_URL,
});

async function main() {
  try {
    const result = streamText({
      model: openai(process.env.MODEL || 'openrouter/poolside/laguna-m.1:free'),
      messages: [{ role: 'user', content: 'List the files in the directory.' }],
      tools: {
        glob: {
          description: 'Find files by pattern',
          parameters: jsonSchema({
            type: 'object',
            properties: {
              pattern: { type: 'string' }
            },
            required: ['pattern']
          })
        }
      }
    });

    for await (const chunk of result.fullStream) {
      console.log(JSON.stringify(chunk));
    }
  } catch (err) {
    console.error('Error during stream:', err);
  }
}

main();
