import { flatMapDepth } from "./flatMapDepth.mjs";
//#region src/compat/array/flatMapDeep.ts
/**
* Creates a flattened array of values by running each element through iteratee and recursively flattening the mapped results.
*
* @template T, R
* @param {Record<string, ArrayLike<T | RecursiveArray<T>> | T> | Record<number, ArrayLike<T | RecursiveArray<T>> | T> | ArrayLike<T> | object | null | undefined} collection - The array or object to iterate over.
* @param {((value: T, index: number, array: ArrayLike<T>) => ArrayLike<R | RecursiveArray<R>> | R) | ((value: T[keyof T], key: string, object: T) => ArrayLike<R | RecursiveArray<R>> | R) | string | object} [iteratee] - The function that produces the new array elements.
* @returns {T[] | R[] | any[] | boolean[]} A new array that has been deeply flattened.
*
* @example
* flatMapDeep([1, 2, 3], n => [[n, n]]);
* // => [1, 1, 2, 2, 3, 3]
*/
function flatMapDeep(collection, iteratee) {
	return flatMapDepth(collection, iteratee, Infinity);
}
//#endregion
export { flatMapDeep };
