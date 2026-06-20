const require_flatten = require("./flatten.js");
//#region src/array/flattenDeep.ts
/**
* Flattens all depths of a nested array.
*
* @template T - The type of elements within the array.
* @param {T[]} arr - The array to flatten.
* @returns {Array<ExtractNestedArrayType<T>>} A new array that has been flattened.
*
* @example
* const arr = flattenDeep([1, [2, [3]], [4, [5, 6]]]);
* // Returns: [1, 2, 3, 4, 5, 6]
*/
function flattenDeep(arr) {
	return require_flatten.flatten(arr, Infinity);
}
//#endregion
exports.flattenDeep = flattenDeep;
