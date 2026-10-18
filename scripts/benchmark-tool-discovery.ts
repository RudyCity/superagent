import { TokenTracker } from "../src/core/context/TokenTracker.js";
import { masterToolset, superagentToolset } from "../src/core/tools/toolsets.js";

const discoveryNames = new Set(["list_tools", "describe_tool"]);
const catalogs = [
  { tier: "master", tools: masterToolset },
  { tier: "single/superagent", tools: superagentToolset },
];

function serializeTools(tools: typeof masterToolset): string {
  return JSON.stringify(tools.map(({ name, description, parameters }) => ({
    name,
    description,
    parameters,
  })));
}

async function main() {
  const tracker = new TokenTracker("schema-benchmark");
  await tracker.ensureEncoder();

  const results = [];
  for (const { tier, tools } of catalogs) {
    const authorized = tools.filter((tool, index, all) =>
      all.findIndex((candidate) => candidate.name === tool.name) === index
    );
    const bootstrap = authorized.filter((tool) => discoveryNames.has(tool.name));
    const representative = authorized.find((tool) => !discoveryNames.has(tool.name));
    const followUp = representative ? [...bootstrap, representative] : bootstrap;

    const fullJson = serializeTools(authorized);
    const bootstrapJson = serializeTools(bootstrap);
    const followUpJson = serializeTools(followUp);
    const fullTokens = tracker.estimateText(fullJson);
    const bootstrapTokens = tracker.estimateText(bootstrapJson);
    const followUpTokens = tracker.estimateText(followUpJson);

    results.push({
      tier,
      authorizedToolCount: authorized.length,
      bootstrapToolCount: bootstrap.length,
      representativeDiscoveredTool: representative?.name ?? null,
      fullCatalog: {
        serializedBytes: Buffer.byteLength(fullJson, "utf8"),
        estimatedSchemaTokens: fullTokens,
      },
      bootstrap: {
        serializedBytes: Buffer.byteLength(bootstrapJson, "utf8"),
        estimatedSchemaTokens: bootstrapTokens,
      },
      oneToolDiscovered: {
        serializedBytes: Buffer.byteLength(followUpJson, "utf8"),
        estimatedSchemaTokens: followUpTokens,
      },
      estimatedBootstrapTokenReductionPercent: fullTokens > 0
        ? Number(((1 - bootstrapTokens / fullTokens) * 100).toFixed(2))
        : 0,
    });
  }

  console.log(JSON.stringify({
    benchmark: "progressive-tool-schema-payload",
    measuredAt: new Date().toISOString(),
    tokenizer: "cl100k_base via TokenTracker",
    method: "serialized schema definitions only; excludes system prompt, conversation, tool results, provider encoding overhead, and billing",
    results,
    limitations: [
      "Token counts are estimates over serialized schemas, not provider-billed token usage.",
      "Representative follow-up contains one discovered schema, not a workload average.",
      "Provider-level task success and latency are tested separately by tests/toolDiscoveryProviderFlow.test.ts with deterministic mock responses."
    ],
  }, null, 2));
  // Imported tool modules may keep unrelated runtime handles open; this CLI only prints a completed measurement.
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
