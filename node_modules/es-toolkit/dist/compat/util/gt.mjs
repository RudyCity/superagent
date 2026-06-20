import { toNumber } from "./toNumber.mjs";
//#region src/compat/util/gt.ts
/**
* Checks if value is greater than other.
*
* @param {any} value The value to compare.
* @param {any} other The other value to compare.
* @returns {boolean} Returns `true` if value is greater than other, else `false`.
*
* @example
* gt(3, 1); // true
* gt(3, 3); // false
* gt(1, 3); // false
*/
function gt(value, other) {
	if (typeof value === "string" && typeof other === "string") return value > other;
	return toNumber(value) > toNumber(other);
}
//#endregion
export { gt };
