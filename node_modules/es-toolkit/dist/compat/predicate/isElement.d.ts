//#region src/compat/predicate/isElement.d.ts
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
declare function isElement(value?: any): boolean;
//#endregion
export { isElement };