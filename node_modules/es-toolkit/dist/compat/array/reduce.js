const require_identity = require("../../function/identity.js");
const require_range = require("../../math/range.js");
const require_isArrayLike = require("../predicate/isArrayLike.js");
//#region src/compat/array/reduce.ts
/**
* Reduces a collection to a single value using an iteratee function.
*
* @param {T[] | ArrayLike<T> | Record<string, T> | null | undefined} collection - The collection to iterate over.
* @param {((accumulator: any, value: any, index: PropertyKey, collection: any) => any) | PropertyKey | object} iteratee - The function invoked per iteration or the key to reduce over.
* @param {any} initialValue - The initial value.
* @returns {any} - Returns the accumulated value.
*
* @example
* // Using a reducer function
* const array = [1, 2, 3];
* reduce(array, (acc, value) => acc + value, 0); // => 6
*
* @example
* // Using a reducer function with initialValue
* const array = [1, 2, 3];
* reduce(array, (acc, value) => acc + value % 2 === 0, true); // => false
*
* @example
* // Using an object as the collection
* const obj = { a: 1, b: 2, c: 3 };
* reduce(obj, (acc, value) => acc + value, 0); // => 6
*/
function reduce(collection, iteratee = require_identity.identity, accumulator) {
	if (!collection) return accumulator;
	let keys;
	let startIndex = 0;
	if (require_isArrayLike.isArrayLike(collection)) {
		keys = require_range.range(0, collection.length);
		if (accumulator == null && collection.length > 0) {
			accumulator = collection[0];
			startIndex += 1;
		}
	} else {
		keys = Object.keys(collection);
		if (accumulator == null) {
			accumulator = collection[keys[0]];
			startIndex += 1;
		}
	}
	for (let i = startIndex; i < keys.length; i++) {
		const key = keys[i];
		const value = collection[key];
		accumulator = iteratee(accumulator, value, key, collection);
	}
	return accumulator;
}
//#endregion
exports.reduce = reduce;
