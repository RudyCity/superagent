import { effectRegistry } from "../registry.js";
import { entranceEffects } from "./entranceEffects.js";
import { exitEffects } from "./exitEffects.js";
import { kineticTypographyEffects } from "./kineticTypographyEffects.js";
import { cameraEffects } from "./cameraEffects.js";
import { transitionEffects } from "./transitionEffects.js";
import { backgroundEffects } from "./backgroundEffects.js";
import { graphicAccentEffects } from "./graphicAccentEffects.js";
import { scaleBounceEffects } from "./scaleBounceEffects.js";

let registered = false;

export function registerAllMotionEffects(): void {
  if (registered) return;
  registered = true;

  for (const e of entranceEffects) effectRegistry.register(e);
  for (const e of exitEffects) effectRegistry.register(e);
  for (const e of kineticTypographyEffects) effectRegistry.register(e);
  for (const e of cameraEffects) effectRegistry.register(e);
  for (const e of transitionEffects) effectRegistry.register(e);
  for (const e of backgroundEffects) effectRegistry.register(e);
  for (const e of graphicAccentEffects) effectRegistry.register(e);
  for (const e of scaleBounceEffects) effectRegistry.register(e);
}

// Auto-register upon import
registerAllMotionEffects();

export {
  entranceEffects,
  exitEffects,
  kineticTypographyEffects,
  cameraEffects,
  transitionEffects,
  backgroundEffects,
  graphicAccentEffects,
  scaleBounceEffects,
};
