//#region src/compat/predicate/isNull.ts
/**
* Checks if `value` is `null`.
*
* @param {any} value - The value to check.
* @returns {value is null} Returns `true` if `value` is `null`, else `false`.
*
* @example
* isNull(null); // true
* isNull(undefined); // false
* isNull(0); // false
*/
function isNull(value) {
	return value === null;
}
//#endregion
exports.isNull = isNull;
