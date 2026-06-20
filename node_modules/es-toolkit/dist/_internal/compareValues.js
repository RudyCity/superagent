//#region src/_internal/compareValues.ts
function compareValues(a, b, order) {
	if (a < b) return order === "asc" ? -1 : 1;
	if (a > b) return order === "asc" ? 1 : -1;
	return 0;
}
//#endregion
exports.compareValues = compareValues;
