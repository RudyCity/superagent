import { isPlainObject } from "./isPlainObject.mjs";
import { isObjectLike } from "./isObjectLike.mjs";
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
	return isObjectLike(value) && value.nodeType === 1 && !isPlainObject(value);
}
//#endregion
export { isElement };
