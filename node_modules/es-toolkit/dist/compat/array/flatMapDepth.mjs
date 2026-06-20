import { identity } from "../../function/identity.mjs";
import { iteratee } from "../util/iteratee.mjs";
import { flatten } from "./flatten.mjs";
import { map } from "./map.mjs";
//#region src/compat/array/flatMapDepth.ts
/**
* Creates a flattened array of values by running each element through iteratee and flattening the mapped results up to depth times.
*
* @template T, R
* @param {Record<string, ArrayLike<T | ListOfRecursiveArraysOrValues<T>> | T> | Record<number, ArrayLike<T | ListOfRecursiveArraysOrValues<T>> | T> | ArrayLike<T> | object | null | undefined} collection - The array or object to iterate over.
* @param {((value: T, index: number, array: ArrayLike<T>) => ArrayLike<R | RecursiveArray<R>> | R) | ((value: T[keyof T], key: string, object: T) => ArrayLike<R | RecursiveArray<R>> | R) | string | object} [iteratee] - The function that produces the new array elements.
* @param {number} [depth=1] - The maximum recursion depth.
* @returns {T[] | R[] | any[] | boolean[]} A new array that has been flattened up to the specified depth.
*
* @example
* flatMapDepth([1, 2, 3], n => [[n, n]], 2);
* // => [1, 1, 2, 2, 3, 3]
*/
function flatMapDepth(collection, iteratee$1 = identity, depth = 1) {
	if (collection == null) return [];
	return flatten(map(collection, iteratee(iteratee$1)), depth);
}
//#endregion
export { flatMapDepth };
