import { activateTradeControl } from "./trade-controls.mjs";

const TABLES = ".el-table, table, [role='table'], [role='grid']";
const VISIBLE_TABLES = TABLES.split(", ").map((selector) => `${selector}:visible`).join(", ");

export async function paginationText(page) {
  const pagination = page.locator(".el-pagination:visible").first();
  return await pagination.count() ? pagination.evaluate((node) => node.querySelector(".el-pager .active, [aria-current='page']")?.textContent.trim() || node.innerText) : "";
}

export async function activateCurrentOrders(page) {
  if (!await activateTradeControl(page, "当前委托")) return false;
  return waitForAccountTable(page, "委托单号");
}

export async function turnOrderPage(page, direction) {
  const button = page.locator(`.el-pagination .btn-${direction}:visible`).first();
  if (!await button.count() || await button.isDisabled()) return false;
  const before = await paginationText(page);
  const tableText = await page.evaluate(() => [...document.querySelectorAll(".el-table, table, [role='table'], [role='grid']")].filter(node => node.getBoundingClientRect().height > 0).map(node => node.textContent));
  await button.click();
  await page.waitForFunction(({ previous, tableText }) => {
    const pagination = [...document.querySelectorAll(".el-pagination")].find((node) => node.getBoundingClientRect().height > 0);
    const current = pagination?.querySelector(".el-pager .active, [aria-current='page']")?.textContent.trim() || pagination?.innerText;
    const text = [...document.querySelectorAll(".el-table, table, [role='table'], [role='grid']")].filter((node) => node.getBoundingClientRect().height > 0).map((node) => node.textContent);
    return current !== previous && JSON.stringify(text) !== JSON.stringify(tableText) && ![...document.querySelectorAll(".el-loading-mask")].some((node) => node.getBoundingClientRect().height > 0);
  }, { previous: before, tableText }, { timeout: 8000 });
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

// Haohan mounts an empty table before its query resolves, without a loading mask.
// pageData.total starts as null and is assigned by the query's success handler.
export async function waitForAccountTable(page, header) {
  return page.waitForFunction((header) => {
    const visible = (node) => node.getBoundingClientRect().height > 0 && getComputedStyle(node).visibility !== "hidden";
    const cell = [...document.querySelectorAll("th, [role='columnheader']")].find((node) => node.textContent.trim() === header && visible(node));
    if (!cell) return false;
    const table = cell.closest(".el-table") || cell.closest("table, [role='table']");
    if ([...document.querySelectorAll(".el-loading-mask")].some(visible)) return false;
    let owner = table.__vue__;
    while (owner && !owner.pageData) owner = owner.$parent;
    if (owner?.pageData) return owner.pageData.total != null && owner.isNetWrong !== true;
    return [...table.querySelectorAll("tbody tr, [role='row'], .el-table__empty-text")].some(visible);
  }, header, { timeout: 8000 }).then(() => true, () => false);
}

export async function collectPositionTables(page, collectTables) {
  if (!await activateTradeControl(page, "持仓明细") || !await waitForAccountTable(page, "持仓单号")) {
    return [{ kind: "positions", loading: true, rows: [] }];
  }
  const previousPages = new Set();
  while (true) {
    const marker = await paginationText(page);
    if (previousPages.has(marker) || !await turnOrderPage(page, "prev")) break;
    previousPages.add(marker);
  }
  const tables = [];
  const seen = new Set();
  while (true) {
    const current = (await collectTables(page)).filter((table) => table.rows.some((row) => row.includes("持仓单号") && !row.includes("委托单号")));
    const marker = JSON.stringify(current);
    if (seen.has(marker) || !current.length || current.some((table) => table.loading)) {
      tables.push({ kind: "positions", loading: true, rows: [] });
      break;
    }
    seen.add(marker);
    tables.push(...current.map((table) => ({ ...table, kind: "positions" })));
    if (!await turnOrderPage(page, "next")) break;
  }
  return tables;
}

export async function collectPositionSummaryTables(page, collectTables) {
  if (!await activateTradeControl(page, "持仓汇总") || !await waitForAccountTable(page, "订立均价")) {
    return [{ kind: "positionSummaries", loading: true, rows: [] }];
  }
  const previous = new Set();
  while (true) {
    const marker = await paginationText(page);
    if (previous.has(marker) || !await turnOrderPage(page, "prev")) break;
    previous.add(marker);
  }
  const tables = [], seen = new Set();
  do {
    const current = (await collectTables(page)).filter(table => table.rows.some(row => row.includes("订立均价")));
    const marker = JSON.stringify(current);
    if (!current.length || seen.has(marker) || current.some(table => table.loading)) {
      tables.push({ kind: "positionSummaries", loading: true, rows: [] }); break;
    }
    seen.add(marker);
    tables.push(...current.map(table => ({ ...table, kind: "positionSummaries" })));
  } while (await turnOrderPage(page, "next"));
  return tables;
}

async function findOrderRow(page, orderId) {
  const idIndex = await page.locator("tr, [role='row']").evaluateAll((rows, orderId) => {
    for (const row of rows) {
      if (!row.getBoundingClientRect().height) continue;
      const table = row.closest(".el-table") || row.closest("table, [role='table']");
      const headers = [...(table?.querySelectorAll("th, [role='columnheader']") || [])].map(node => node.textContent.trim());
      const cells = row.querySelectorAll("td, [role='gridcell'], [role='cell']");
      const index = headers.indexOf("委托单号");
      if (index >= 0 && cells[index]?.textContent.trim() === orderId) return index;
    }
    return -1;
  }, orderId);
  // Resolve again on every action: Vue replaces rows after checkbox changes.
  if (idIndex < 0) return null;
  const header = page.locator("th, [role='columnheader']").filter({ hasText: /^\s*委托单号\s*$/ });
  const table = page.locator(VISIBLE_TABLES).filter({ has: header }).first();
  const cells = page.locator(`td:nth-child(${idIndex + 1}), [role='gridcell']:nth-child(${idIndex + 1}), [role='cell']:nth-child(${idIndex + 1})`)
    .filter({ hasText: new RegExp(`^\\s*${orderId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`) });
  return table.locator("tr:visible, [role='row']:visible").filter({ has: cells }).first();
}

async function findOrderOnAllPages(page, orderId) {
  // Search from page one before concluding an order filled/disappeared.
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
  return row;
}

export async function clickOrderCancellation(page, orderId) {
  if (!await activateCurrentOrders(page)) return { clicked: false, code: "ORDER_TABLE_UNVERIFIED" };
  let row = await findOrderOnAllPages(page, orderId);
  if (!row) return { clicked: false, code: "ORDER_NO_LONGER_OPEN" };
  const active = await row.evaluate((node) => {
    const table = node.closest(".el-table") || node.closest("table, [role='table']");
    const headers = [...table.querySelectorAll("th, [role='columnheader']")].map((cell) => cell.textContent.trim());
    const cells = [...node.querySelectorAll("td, [role='gridcell'], [role='cell']")];
    return /^(已委托|部分成交)$/.test(cells[headers.indexOf("状态")]?.textContent.trim() || "")
      && Number(cells[headers.indexOf("未成交数量")]?.textContent.trim()) > 0;
  });
  if (!active) return { clicked: false, code: "ORDER_NO_LONGER_OPEN" };
  // Keep a nonempty selection while replacing the previous choice: Haohan
  // re-queries the table when selection becomes empty. Never toggle headers.
  const setSelected = async (id, selected) => {
    const current = await findOrderRow(page, id);
    if (!current) return false;
    const checkbox = current.locator("input[type='checkbox']").first();
    if (!await checkbox.count() || await checkbox.isDisabled()) return false;
    if (await checkbox.isChecked() !== selected) {
      const label = current.locator("label.el-checkbox").first();
      await (await label.count() ? label : checkbox).click({ timeout: 3000 });
    }
    return true;
  };
  const selectedIds = () => page.locator("tbody tr:visible, [role='row']:visible").evaluateAll(rows => rows.flatMap(row => {
    const table = row.closest(".el-table") || row.closest("table, [role='table']");
    const headers = [...(table?.querySelectorAll("th, [role='columnheader']") || [])].map(node => node.textContent.trim());
    if (!headers.includes("委托单号") || !row.querySelector("input[type='checkbox']:checked")) return [];
    return [row.querySelectorAll("td, [role='gridcell'], [role='cell']")[headers.indexOf("委托单号")]?.textContent.trim() || ""];
  }));
  let verified = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!await setSelected(orderId, true)) return { clicked: false, code: "ORDER_CANCEL_CONTROL_NOT_FOUND" };
    for (const id of [...new Set(await selectedIds())].filter(id => id !== orderId)) {
      if (!id || !await setSelected(id, false)) return { clicked: false, code: "ORDER_SELECTION_UNVERIFIED" };
    }
    const selected = await selectedIds();
    if (selected.length === 1 && selected[0] === orderId) { verified = true; break; }
  }
  if (!verified) return { clicked: false, code: "ORDER_SELECTION_UNVERIFIED" };
  if (!await activateTradeControl(page, "撤单")) return { clicked: false, code: "ORDER_CANCEL_CONTROL_NOT_FOUND" };
  return { clicked: true };
}

export async function readCurrentOrderStatus(page, orderId) {
  if (!await activateCurrentOrders(page)) return "";
  const row = await findOrderOnAllPages(page, orderId);
  if (!row) return "";
  return row.evaluate((node) => {
    const table = node.closest(".el-table") || node.closest("table, [role='table']");
    const headers = [...table.querySelectorAll("th, [role='columnheader']")].map((cell) => cell.textContent.trim());
    return node.querySelectorAll("td, [role='gridcell'], [role='cell']")[headers.indexOf("状态")]?.textContent.trim() || "";
  });
}

export async function ensureCurrentAccountView(page) {
  const historyVisible = await page.locator("#hisPage:visible, [role='tabpanel'][aria-label='历史委托']:visible").count()
    || await page.locator(".head_l_btns.s, .header_l_item.s, .el-tabs__item.is-active, [role='tab'][aria-selected='true']").evaluateAll(nodes => nodes.some(node => node.textContent.replace(/\s+/g, "") === "历史委托" && node.getBoundingClientRect().height > 0));
  if (historyVisible && !await activateCurrentOrders(page)) throw new Error("CURRENT_ORDER_TABLE_UNVERIFIED");
}
