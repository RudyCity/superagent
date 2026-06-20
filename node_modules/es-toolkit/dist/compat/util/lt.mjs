import { toNumber } from "./toNumber.mjs";
//#region src/compat/util/lt.ts
/**
* Checks if value is less than other.
*
* @param {any} value The value to compare.
* @param {any} other The other value to compare.
* @returns {boolean} Returns `true` if value is less than other, else `false`.
*
* @example
* lt(1, 3); // true
* lt(3, 3); // false
* lt(3, 1); // false
*/
function lt(value, other) {
	if (typeof value === "string" && typeof other === "string") return value < other;
	return toNumber(value) < toNumber(other);
}
//#endregion
export { lt };
