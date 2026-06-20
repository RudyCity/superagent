const require_isArrayLike = require("../predicate/isArrayLike.js");
//#region src/compat/array/join.ts
/**
* Joins elements of an array into a string.
*
* @param {ArrayLike<any> | null | undefined} array - The array to join.
* @param {string} [separator=','] - The separator used to join the elements, default is common separator `,`.
* @returns {string} - Returns a string containing all elements of the array joined by the specified separator.
*
* @example
* const arr = ["a", "b", "c"];
* const result = join(arr, "~");
* console.log(result); // Output: "a~b~c"
*/
function join(array, separator) {
	if (!require_isArrayLike.isArrayLike(array)) return "";
	return Array.from(array).join(separator);
}
//#endregion
exports.join = join;
