const require_clamp = require("../math/clamp.js");
const require_MAX_ARRAY_LENGTH = require("../_internal/MAX_ARRAY_LENGTH.js");
//#region src/compat/util/toLength.ts
/**
* Converts the value to a valid index. A valid index is an integer that is greater than or equal to `0` and less than or equal to `2^32 - 1`.
*
* It converts the given value to a number and floors it to an integer. If the value is less than `0`, it returns `0`. If the value exceeds `2^32 - 1`, it returns `2^32 - 1`.
*
* @param {unknown} value - The value to convert to a valid index.
* @returns {number} The converted value.
*
* @example
* toLength(3.2)  // => 3
* toLength(-1)   // => 0
* toLength(1.9)  // => 1
* toLength('42') // => 42
* toLength(null) // => 0
*/
function toLength(value) {
	if (value == null) return 0;
	const length = Math.floor(Number(value));
	return require_clamp.clamp(length, 0, require_MAX_ARRAY_LENGTH.MAX_ARRAY_LENGTH);
}
//#endregion
exports.toLength = toLength;
