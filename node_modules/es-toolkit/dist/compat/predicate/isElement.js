const require_isPlainObject = require("./isPlainObject.js");
const require_isObjectLike = require("./isObjectLike.js");
//#region src/compat/predicate/isElement.ts
/**
* Checks if `value` is likely a DOM element.
*
* @param {any} value The value to check.
* @returns {boolean} Returns `true` if `value` is a DOM element, else `false`.
*
* @example
* console.log(isElement(document.body)); // true
* console.log(isElement('<body>')); // false
*/
function isElement(value) {
	return require_isObjectLike.isObjectLike(value) && value.nodeType === 1 && !require_isPlainObject.isPlainObject(value);
}
//#endregion
exports.isElement = isElement;
