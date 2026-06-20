import { getTag } from "../_internal/getTag.mjs";
//#region src/compat/predicate/isError.ts
/**
* Checks if `value` is an Error object.
*
* @param {any} value The value to check.
* @returns {value is Error} Returns `true` if `value` is an Error object, `false` otherwise.
*
* @example
* ```typescript
* console.log(isError(new Error())); // true
* console.log(isError('Error')); // false
* console.log(isError({ name: 'Error', message: '' })); // false
* ```
*/
function isError(value) {
	return getTag(value) === "[object Error]";
}
//#endregion
export { isError };
