import { useInput } from 'ink';
import React, { useState, useEffect } from 'react';
import { render, Text, Box } from 'ink';

const TestApp = () => {
  const [logs, setLogs] = useState([]);

  useInput((input, key) => {
    const logStr = `input: ${JSON.stringify(input)}, key: ${JSON.stringify(key)}`;
    setLogs((prev) => [...prev.slice(-10), logStr]);
    if (key.ctrl && input === 'c') {
      process.exit();
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Text color="cyan">Press any keys (PageUp, PageDown, Ctrl+Up, etc.). Ctrl+C to exit.</Text>
      {logs.map((log, i) => (
        <Text key={i} color="yellow">{log}</Text>
      ))}
    </Box>
  );
};

render(<TestApp />);
