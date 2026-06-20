const require_isPlainObject = require("./isPlainObject.js");
//#region src/predicate/isEmptyObject.ts
/**
* Checks if a value is an empty plain object.
*
* @param {unknown} value - The value to check.
* @returns {value is Record<PropertyKey, never>} - True if the value is an empty plain object, otherwise false.
*
* @example
* isEmptyObject({}); // true
* isEmptyObject({ a: 1 }); // false
* isEmptyObject([]); // false
* isEmptyObject(null); // false
*/
function isEmptyObject(value) {
	return require_isPlainObject.isPlainObject(value) && Object.keys(value).length === 0;
}
//#endregion
exports.isEmptyObject = isEmptyObject;
