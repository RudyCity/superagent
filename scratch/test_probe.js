import fs from 'fs';
import path from 'path';

const historyPath = 'C:\\Users\\USER\\.superagent-r\\history\\single\\D__backup_from_pc_asus_Documents_Development_superagent_1784127919317\\D__backup_from_pc_asus_Documents_Development_superagent_1784127919317.json';
const history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));

// Format messages like agent.ts buildMessages(supportsNativeTools = false)
const coreMessages = [];
const threshold = 16000;

for (const m of history.messages) {
  if (m.role === 'system') continue;

  if (m.role === 'user') {
    coreMessages.push({
      role: 'user',
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    });
  } else if (m.role === 'assistant') {
    const hasToolCalls = m.toolCalls && m.toolCalls.length > 0;
    if (hasToolCalls) {
      let text = m.content || '';
      text += '\n<tool_calls>\n' + m.toolCalls.map(tc => `<tool_call>\n${JSON.stringify({ name: tc.name, arguments: tc.args })}\n</tool_call>`).join('\n') + '\n</tool_calls>';
      coreMessages.push({
        role: 'assistant',
        content: text
      });
    } else {
      coreMessages.push({
        role: 'assistant',
        content: m.content || ''
      });
    }
  } else if (m.role === 'tool') {
    const results = m.toolResults || [];
    const resultText = results.map(tr => `<tool_response name="${tr.name}">\n${tr.result}\n</tool_response>`).join('\n');
    coreMessages.push({
      role: 'user',
      content: resultText
    });
  }
}

console.log('Total messages formatted:', coreMessages.length);

// Let's inspect the last 10 messages
console.log('Last 15 messages:');
coreMessages.slice(-15).forEach((m, idx) => {
  const actualIndex = coreMessages.length - 15 + idx;
  console.log(`[${actualIndex}] Role: ${m.role}, Length: ${m.content.length}`);
  console.log(`  Content snippet: ${m.content.slice(0, 150).replace(/\n/g, '\\n')}`);
});

// Let's check for consecutive roles
for (let i = 1; i < coreMessages.length; i++) {
  if (coreMessages[i].role === coreMessages[i-1].role) {
    console.warn(`WARNING: Consecutive messages with same role: ${coreMessages[i].role} at index ${i-1} and ${i}`);
  }
}

// Make the HTTP request
async function testRequest() {
  const url = 'http://localhost:20128/v1/chat/completions';
  const payload = {
    model: 'cf/@cf/moonshotai/kimi-k2.7-code',
    messages: coreMessages,
    stream: false
  };

  console.log('Sending request to', url);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer sk-639f9539c975822e-tdi40b-3eb4e258'
      },
      body: JSON.stringify(payload)
    });

    console.log('Response Status:', response.status);
    console.log('Response Headers:', Object.fromEntries(response.headers.entries()));
    const text = await response.text();
    console.log('Response Body:', text);
  } catch (error) {
    console.error('Request failed:', error);
  }
}

testRequest();
