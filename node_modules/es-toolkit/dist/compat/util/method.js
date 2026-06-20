const require_invoke = require("./invoke.js");
//#region src/compat/util/method.ts
/**
* Creates a function that invokes the method at `path` of a given object with the provided arguments.
*
* @param {PropertyKey | PropertyKey[]} path - The path of the method to invoke.
* @param {...any} args - The arguments to invoke the method with.
* @returns {(object?: unknown) => any} - Returns a new function that takes an object and invokes the method at `path` with `args`.
*
* @example
* const object = {
*   a: {
*     b: function (x, y) {
*       return x + y;
*     }
*   }
* };
*
* const add = method('a.b', 1, 2);
* console.log(add(object)); // => 3
*/
function method(path, ...args) {
	return function(object) {
		return require_invoke.invoke(object, path, args);
	};
}
//#endregion
exports.method = method;
