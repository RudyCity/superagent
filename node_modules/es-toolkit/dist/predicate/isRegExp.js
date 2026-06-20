//#region src/predicate/isRegExp.ts
/**
* Checks if `value` is a RegExp.
*
* @param {unknown} value The value to check.
* @returns {value is RegExp} Returns `true` if `value` is a RegExp, `false` otherwise.
*
* @example
* const value1 = /abc/;
* const value2 = '/abc/';
*
* console.log(isRegExp(value1)); // true
* console.log(isRegExp(value2)); // false
*/
function isRegExp(value) {
	return value instanceof RegExp;
}
//#endregion
exports.isRegExp = isRegExp;
