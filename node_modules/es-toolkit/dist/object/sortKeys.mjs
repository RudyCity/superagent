//#region src/object/sortKeys.ts
/**
* Creates a new object with the keys sorted.
*
* The keys are sorted alphabetically by default, but a custom compare function can be provided.
*
* @template T - The type of the object.
* @param {T} object - The object to sort keys from.
* @param {(a: string, b: string) => number} [compareKeys] - A custom compare function for sorting keys.
* @returns {T} A new object with the keys sorted.
*
* @example
* sortKeys({ b: 2, a: 1, c: 3 });
* // => { a: 1, b: 2, c: 3 }
*
* @example
* sortKeys({ b: 2, a: 1, c: 3 }, (a, b) => b.localeCompare(a));
* // => { c: 3, b: 2, a: 1 }
*/
function sortKeys(object, compareKeys) {
	const sortedKeys = Object.keys(object).sort(compareKeys);
	const result = {};
	for (let i = 0; i < sortedKeys.length; i++) {
		const key = sortedKeys[i];
		result[key] = object[key];
	}
	return result;
}
//#endregion
export { sortKeys };
