import { isRegExp as isRegExp$1 } from "../../predicate/isRegExp.mjs";
//#region src/compat/predicate/isRegExp.ts
/**
* Checks if `value` is a RegExp.
*
* @param {any} value The value to check.
* @returns {boolean} Returns `true` if `value` is a RegExp, `false` otherwise.
*
* @example
* const value1 = /abc/;
* const value2 = '/abc/';
*
* console.log(isRegExp(value1)); // true
* console.log(isRegExp(value2)); // false
*/
function isRegExp(value) {
	return isRegExp$1(value);
}
//#endregion
export { isRegExp };
