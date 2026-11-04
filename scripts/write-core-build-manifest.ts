import { writeCoreBuildManifest } from "../src/core/runtime/coreBuildIdentity.js";
const result=writeCoreBuildManifest(process.cwd());
console.log("[Core build] SHA-256 "+result.digest+"; source "+result.sourceDigest+
  "; files "+result.fileCount);
