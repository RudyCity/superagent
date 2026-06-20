import { flatten } from "./flatten.mjs";
//#region src/compat/array/flattenDepth.ts
/**
* Recursively flattens array up to depth times.
*
* @template T
* @param {ArrayLike<T> | null | undefined} array - The array to flatten.
* @param {number} [depth=1] - The maximum recursion depth.
* @returns {T[]} Returns the new flattened array.
*
* @example
* const array = [1, [2, [3, [4]], 5]];
*
* flattenDepth(array, 1);
* // => [1, 2, [3, [4]], 5]
*
* flattenDepth(array, 2);
* // => [1, 2, 3, [4], 5]
*/
function flattenDepth(array, depth = 1) {
	return flatten(array, depth);
}
//#endregion
export { flattenDepth };
