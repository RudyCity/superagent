import { flattenDepth } from "./flattenDepth.mjs";
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
	return flattenDepth(value, Infinity);
}
//#endregion
export { flattenDeep };
