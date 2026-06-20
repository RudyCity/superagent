import { isNil } from "../../predicate/isNil.mjs";
//#region src/compat/array/size.ts
function size(target) {
	if (isNil(target)) return 0;
	if (target instanceof Map || target instanceof Set) return target.size;
	return Object.keys(target).length;
}
//#endregion
export { size };
