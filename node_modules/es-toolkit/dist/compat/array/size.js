const require_isNil = require("../../predicate/isNil.js");
//#region src/compat/array/size.ts
function size(target) {
	if (require_isNil.isNil(target)) return 0;
	if (target instanceof Map || target instanceof Set) return target.size;
	return Object.keys(target).length;
}
//#endregion
exports.size = size;
