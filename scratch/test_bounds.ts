import { isToolCallOutOfBounds } from "../src/core/permissions.js";

const workspacePath = "D:\\backup from pc asus\\Documents Development\\UB\\surat-bebas-tanggungan";
const toolCall = {
  name: "write_to_file",
  args: {
    filePath: "C:\\Users\\USER\\Documents\\Development\\UB\\surat_bebas_tanggungan\\package.json",
    content: "dummy"
  }
};

const outOfBounds = isToolCallOutOfBounds(toolCall, workspacePath);
console.log("Is Out of Bounds?", outOfBounds);
