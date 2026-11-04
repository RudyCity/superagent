// Smoke test the actual SuperAgent arrays and discovery wrappers without
// changing the server, loading a model, or contacting ChatGPT.
process.env.VITEST = "true"; // Skip dynamic hook filesystem watcher in this one-off process.
const {
  delegateToolset,
  superagentToolset,
  chromeExtensionToolset,
  masterToolset,
  filterExtensionChatTools,
  withModeAwareDiscoveryTools,
  EXTENSION_CHAT_HIDDEN_TOOL_NAMES,
  ORCHESTRATION_TOOL_NAMES,
} = await import("../src/core/tools/toolsets.js");

const expected = [
  "delegate.create_chat",
  "delegate.read_chat",
  "delegate.send_message",
  "delegate.stop_generation",
];

function assert(condition: boolean, error: string): void {
  if (!condition) throw new Error(error);
}

async function inspect(
  mode: string,
  base: typeof delegateToolset,
  chromeExtensionMode: boolean,
  includeDelegate: boolean,
): Promise<void> {
  const selected = includeDelegate ? [...base, ...delegateToolset] : base;
  const available = withModeAwareDiscoveryTools(selected, chromeExtensionMode);
  const discovery = available.find((t) => t.name === "list_tools");
  assert(!!discovery, `list_tools missing in ${mode}`);
  const response = await discovery!.execute({ query: "delegate" }, process.cwd());
  console.log(`=== ${mode} list_tools({ query: "delegate" }) ===`);
  console.log(response);
  for (const name of expected) {
    assert(response.includes(name) === includeDelegate, `Unexpected ${name} in ${mode}`);
  }
  const hiddenCount = [...EXTENSION_CHAT_HIDDEN_TOOL_NAMES].filter((name) =>
    available.some((tool) => tool.name === name)
  ).length;
  if (!chromeExtensionMode) assert(hiddenCount === 0, `Filtered tool leaked in ${mode}`);
  assert(ORCHESTRATION_TOOL_NAMES.size > 0, "Master tool allowlist missing");
  assert(expected.every((name) => !ORCHESTRATION_TOOL_NAMES.has(name)), "Delegate leaked to Master allowlist");
  console.log(`PASS: delegate=${includeDelegate}, old-extension-hidden-visible-count=${hiddenCount}\n`);
}

await inspect("T-Line single", filterExtensionChatTools(superagentToolset), false, true);
await inspect("Chrome-extension single", chromeExtensionToolset, true, true);
await inspect("T-Line Master", filterExtensionChatTools(masterToolset), false, false);
process.exit(0);
