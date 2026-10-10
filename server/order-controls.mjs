import { activateTradeControl } from "./trade-controls.mjs";

const TABLES = ".el-table, table, [role='table'], [role='grid']";
const VISIBLE_TABLES = TABLES.split(", ").map((selector) => `${selector}:visible`).join(", ");

async function paginationText(page) {
  const pagination = page.locator(".el-pagination:visible").first();
  return await pagination.count() ? pagination.evaluate((node) => node.querySelector(".el-pager .active, [aria-current='page']")?.textContent.trim() || node.innerText) : "";
}

export async function activateCurrentOrders(page) {
  if (!await activateTradeControl(page, "当前委托")) return false;
  return page.waitForFunction(() => [...document.querySelectorAll("th, [role='columnheader']")]
    .some((node) => node.textContent.trim() === "委托单号" && node.getBoundingClientRect().height > 0)
    && ![...document.querySelectorAll(".el-loading-mask")].some((node) => node.getBoundingClientRect().height > 0), null, { timeout: 1500 }).then(() => true, () => false);
}

async function turnOrderPage(page, direction) {
  const button = page.locator(`.el-pagination .btn-${direction}:visible`).first();
  if (!await button.count() || await button.isDisabled()) return false;
  const before = await paginationText(page);
  const tableText = await page.locator(VISIBLE_TABLES).allTextContents();
  await button.click();
  await page.waitForFunction(({ previous, tableText }) => {
    const pagination = [...document.querySelectorAll(".el-pagination")].find((node) => node.getBoundingClientRect().height > 0);
    const current = pagination?.querySelector(".el-pager .active, [aria-current='page']")?.textContent.trim() || pagination?.innerText;
    const text = [...document.querySelectorAll(".el-table, table, [role='table'], [role='grid']")].filter((node) => node.getBoundingClientRect().height > 0).map((node) => node.textContent);
    return current !== previous && JSON.stringify(text) !== JSON.stringify(tableText) && ![...document.querySelectorAll(".el-loading-mask")].some((node) => node.getBoundingClientRect().height > 0);
  }, { previous: before, tableText }, { timeout: 1500 }).catch(() => {});
  return true;
}

export async function collectCurrentOrderTables(page, collectTables) {
  if (!await activateCurrentOrders(page)) return [{ kind: "currentOrders", loading: true, rows: [] }];
  // Start at page one, including when a prior cancellation left the UI on another page.
  const previousPages = new Set();
  while (true) {
    const marker = await paginationText(page);
    if (previousPages.has(marker) || !await turnOrderPage(page, "prev")) break;
    previousPages.add(marker);
  }
  const tables = [];
  const seen = new Set();
  while (true) {
    const current = (await collectTables(page)).filter((table) => table.rows.some((row) => row.some((cell) => String(cell).trim() === "委托单号")));
    const marker = JSON.stringify(current);
    if (seen.has(marker) || !current.length || current.some((table) => table.loading)) {
      tables.push({ kind: "currentOrders", loading: true, rows: [] });
      break;
    }
    seen.add(marker);
    tables.push(...current.map((table) => ({ ...table, kind: "currentOrders" })));
    if (!await turnOrderPage(page, "next")) break;
  }
  return tables;
}

async function findOrderRow(page, orderId) {
  const token = `${Date.now()}-${Math.random()}`;
  const found = await page.locator("tr, [role='row']").evaluateAll((rows, { orderId, token }) => rows.some((row) => {
    if (!row.getBoundingClientRect().height) return false;
    const table = row.closest(".el-table") || row.closest("table, [role='table']");
    const headers = [...(table?.querySelectorAll("th, [role='columnheader']") || [])].map((node) => node.textContent.trim());
    const idIndex = headers.indexOf("委托单号");
    const cells = [...row.querySelectorAll("td, [role='gridcell'], [role='cell']")];
    if (idIndex < 0 || cells[idIndex]?.textContent.trim() !== orderId) return false;
    row.dataset.axiomCancelOrder = token;
    return true;
  }), { orderId, token });
  return found ? page.locator(`[data-axiom-cancel-order='${token}']`) : null;
}

export async function clickOrderCancellation(page, orderId) {
  if (!await activateCurrentOrders(page)) return { clicked: false, code: "ORDER_TABLE_UNVERIFIED" };
  // Search all current-order pages before concluding the order already filled/disappeared.
  const previousPages = new Set();
  while (true) {
    const marker = await paginationText(page);
    if (previousPages.has(marker) || !await turnOrderPage(page, "prev")) break;
    previousPages.add(marker);
  }
  const seen = new Set();
  let row;
  do {
    const marker = await page.locator(VISIBLE_TABLES).allTextContents();
    if (seen.has(JSON.stringify(marker))) break;
    seen.add(JSON.stringify(marker));
    row = await findOrderRow(page, orderId);
    if (row) break;
  } while (await turnOrderPage(page, "next"));
  if (!row) return { clicked: false, code: "ORDER_NO_LONGER_OPEN" };
  const active = await row.evaluate((node) => {
    const table = node.closest(".el-table") || node.closest("table, [role='table']");
    const headers = [...table.querySelectorAll("th, [role='columnheader']")].map((cell) => cell.textContent.trim());
    const cells = [...node.querySelectorAll("td, [role='gridcell'], [role='cell']")];
    return /^(已委托|部分成交)$/.test(cells[headers.indexOf("状态")]?.textContent.trim() || "")
      && Number(cells[headers.indexOf("未成交数量")]?.textContent.trim()) > 0;
  });
  if (!active) return { clicked: false, code: "ORDER_NO_LONGER_OPEN" };
  // The production page uses row checkboxes plus the selected-order 撤单 toolbar.
  await page.locator(VISIBLE_TABLES).locator("input[type='checkbox']").evaluateAll((nodes) => {
    for (const node of nodes) if (node.checked && !node.disabled) node.click();
  });
  row = await findOrderRow(page, orderId);
  if (!row) return { clicked: false, code: "ORDER_NO_LONGER_OPEN" };
  const checkbox = row.locator("input[type='checkbox']").first();
  if (!await checkbox.count() || await checkbox.isDisabled()) return { clicked: false, code: "ORDER_CANCEL_CONTROL_NOT_FOUND" };
  await checkbox.evaluate((node) => { if (!node.checked) node.click(); });
  const selected = await page.locator(VISIBLE_TABLES).locator("tbody input[type='checkbox']").evaluateAll((nodes) => nodes.filter((node) => node.checked).length);
  if (selected !== 1 || !await checkbox.isChecked()) return { clicked: false, code: "ORDER_SELECTION_UNVERIFIED" };
  if (!await activateTradeControl(page, "撤单")) return { clicked: false, code: "ORDER_CANCEL_CONTROL_NOT_FOUND" };
  return { clicked: true };
}

export async function readHistoricalOrderStatus(page, orderId) {
  if (!await activateTradeControl(page, "历史委托")) return "";
  await page.waitForFunction(() => [...document.querySelectorAll("th")].some((node) => node.textContent.trim() === "委托单号" && node.getBoundingClientRect().height > 0), null, { timeout: 1500 }).catch(() => {});
  const row = await findOrderRow(page, orderId);
  if (!row) return "";
  return row.evaluate((node) => {
    const table = node.closest(".el-table") || node.closest("table, [role='table']");
    const headers = [...table.querySelectorAll("th, [role='columnheader']")].map((cell) => cell.textContent.trim());
    return node.querySelectorAll("td, [role='gridcell'], [role='cell']")[headers.indexOf("状态")]?.textContent.trim() || "";
  });
}
