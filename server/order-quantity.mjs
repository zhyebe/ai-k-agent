export const DEFAULT_ENTRY_QUANTITY = 1;

export function parseEntryQuantity(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const quantity = Number(value);
  return Number.isSafeInteger(quantity) && quantity > 0 ? quantity : null;
}

export function entryQuantityForTask(task) {
  return parseEntryQuantity(task?.entryQuantity) ?? DEFAULT_ENTRY_QUANTITY;
}
