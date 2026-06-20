const require_flattenDepth = require("./flattenDepth.js");
//#region src/compat/array/flattenDeep.ts
/**
* Recursively flattens array.
*
* @template T
* @param {ArrayLike<T> | null | undefined} array - The array to flatten.
* @returns {Array<ExtractNestedArrayType<T>>} Returns the new flattened array.
*
* @example
* flattenDeep([1, [2, [3, [4]], 5]]);
* // => [1, 2, 3, 4, 5]
*/
function flattenDeep(value) {
	return require_flattenDepth.flattenDepth(value, Infinity);
}
//#endregion
exports.flattenDeep = flattenDeep;
