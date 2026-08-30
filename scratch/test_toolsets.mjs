import { masterToolset } from "../src/core/tools/toolsets.js";
const undefinedItems = masterToolset.filter(t => t === undefined || t === null);
console.log("Total tools:", masterToolset.length);
console.log("Undefined items:", undefinedItems.length);
const toolNames = masterToolset.map((t, i) => t?.name ?? `<UNDEF-${i}>`);
console.log("Names:");
toolNames.forEach((n, i) => console.log(`  ${i}: ${n}`));
