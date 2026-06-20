//#region src/predicate/isError.ts
/**
* Checks if `value` is an Error object.
*
* @param {unknown} value The value to check.
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
	return value instanceof Error;
}
//#endregion
export { isError };
