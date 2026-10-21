import { paginationText, turnOrderPage, waitForAccountTable } from "./order-controls.mjs";

const BUTTONS = "button, input[type='button'], input[type='submit'], [role='button'], a";
const TABS = "button, [role='tab'], .el-tabs__item, .el-radio-button__inner, .trade_btn, .tab_btn, .header_l_item, span, a, div";
const ROWS = "tr, [role='row'], .el-table__row, .position-row";
let controlSequence = 0;
const controlToken = () => `control-${Date.now()}-${++controlSequence}`;

async function findControl(root, labels, selector = BUTTONS, allowPartial = true) {
  const token = controlToken();
  const found = await root.locator(selector).evaluateAll((nodes, { wanted, token, allowPartial }) => {
    const compact = (value) => String(value || "").replace(/[\s:：|｜]/g, "");
    const candidates = nodes.filter((node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    });
    const value = (node) => compact(node.value || node.getAttribute("aria-label") || node.textContent);
    const semantic = (node) => node.matches("button, input, [role='button'], [role='tab'], a, .el-tabs__item, .el-radio-button__inner, .trade_btn, .tab_btn, .header_l_item, .head_l_btns, .spotS, [data-action]");
    const exact = candidates.filter(node => wanted.includes(value(node)));
    // Generic wrappers aggregate all descendant labels. Only a leaf with an
    // exact label or an actual control may be clicked.
    const node = exact.find(semantic)
      || exact.find(node => !exact.some(child => child !== node && node.contains(child)))
      || (allowPartial && candidates.find(node => semantic(node) && wanted.some(label => value(node).includes(label))));
    if (!node) return false;
    node.dataset.axiomControl = token;
    return true;
  }, { wanted: labels.map((label) => label.replace(/[\s:：|｜]/g, "")), token, allowPartial });
  return found ? root.locator(`[data-axiom-control="${token}"]`) : null;
}

export async function activateTradeControl(page, label) {
  if (String(label).replace(/\s+/g, "") === "历史委托") return false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const control = await findControl(page, [label], TABS, false);
    if (!control) {
      await page.waitForTimeout(150);
      continue;
    }
    const active = ["当前委托", "持仓明细"].includes(label) && await control.evaluate((node) => {
      return node.getAttribute("aria-selected") === "true"
        || node.matches(".head_l_btns.s, .header_l_item.s, .el-tabs__item.is-active");
    }).catch(() => false);
    // The trading site refreshes tab data when a tab is mounted. Avoid clicking
    // an already active tab: its live DOM is already updating by itself.
    if (active) return true;
    try {
      await control.scrollIntoViewIfNeeded({ timeout: 2500 });
      await control.click({ timeout: 5000 });
      return true;
    } catch (error) {
      if (attempt === 2) throw error;
      await page.waitForTimeout(150);
    }
  }
  return false;
}

export async function fillTradeFields(page, fields, root = page) {
  const filled = [];
  for (const { labels, value } of fields) {
    if (value == null) continue;
    let match = null;
    let lastError = null;
    const deadline = Date.now() + 5000;
    do {
      const token = controlToken();
      match = await root.locator("input").evaluateAll((inputs, { wanted, token }) => {
        const compact = (value) => String(value || "").replace(/[\s:：]/g, "");
        const visible = (node) => {
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== "hidden";
        };
        const editable = (input) => visible(input) && !/checkbox|radio|hidden|button|submit/.test(input.type) && !input.disabled && !input.readOnly;
        for (let index = 0; index < inputs.length; index += 1) {
          const input = inputs[index];
          if (!editable(input)) continue;
          const container = input.closest(".inputWrap, .el-form-item, li, label, .form-item") || input.parentElement;
          const scoped = container && container !== document.body && container !== document.documentElement
            && [...container.querySelectorAll("input")].filter(editable).length === 1;
          const labels = input.labels?.length ? [...input.labels] : scoped ? [...container.querySelectorAll("label, span, p, .el-form-item__label")] : [];
          const label = labels.find((node) => visible(node) && wanted.some((item) => {
            const text = compact(node.textContent);
            return text === item || text.includes(item);
          }));
          if (label) {
            input.dataset.axiomControl = token;
            return { label: compact(label.textContent) };
          }
        }
        return null;
      }, { wanted: labels.map((label) => label.replace(/[\s:：]/g, "")), token });
      if (!match) {
        await page.waitForTimeout(100);
        continue;
      }
      try {
        const input = root.locator(`input[data-axiom-control="${token}"]`);
        await input.scrollIntoViewIfNeeded({ timeout: 750 });
        await input.fill(String(value), { timeout: 750 });
      } catch (error) {
        lastError = error;
        match = null;
        await page.waitForTimeout(100);
      }
    } while (!match && Date.now() < deadline);
    if (!match && lastError) throw lastError;
    if (match) filled.push(match.label);
  }
  return filled;
}

export async function prepareTradeEntry(page, action) {
  await activateTradeControl(page, action === "SELL" ? "卖出" : "买入");
  await activateTradeControl(page, "订立");
  const labels = action === "SELL" ? ["卖出订立", "卖订立"] : ["买入订立", "买订立"];
  const deadline = Date.now() + 5000;
  do {
    if (await findControl(page, labels)) return true;
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);
  return false;
}

export async function clickTradeEntry(page, action) {
  const labels = action === "SELL" ? ["卖出订立", "卖订立"] : ["买入订立", "买订立"];
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const control = await findControl(page, labels);
    if (!control) {
      await page.waitForTimeout(150);
      continue;
    }
    try {
      await acceptTradeAgreement(control);
      await control.scrollIntoViewIfNeeded({ timeout: 2500 });
      await control.click({ timeout: 5000 });
      return { clicked: true, label: labels[0] };
    } catch (error) {
      lastError = error;
      if (attempt < 2) await page.waitForTimeout(150);
    }
  }
  if (!lastError) return { clicked: false, code: "SUBMIT_BUTTON_NOT_FOUND", tried: labels };
  const current = await findControl(page, labels).catch(() => null);
  const disabled = current ? await current.isDisabled().catch(() => false) : false;
  return { clicked: false, code: disabled ? "SUBMIT_BUTTON_DISABLED" : "SUBMIT_CLICK_FAILED", message: lastError.message, tried: labels };
}

async function acceptTradeAgreement(control) {
  // Clicking both input and label toggles agreement back off.
  await control.evaluate((button) => {
    let root = button.parentElement;
    while (root && !root.querySelector(".cotract, .el-checkbox")) root = root.parentElement;
    if (!root) return;
    const checkbox = [...root.querySelectorAll("input[type='checkbox']")].find((input) => {
      const box = input.closest(".cotract, .el-checkbox, label") || input;
      return box.getBoundingClientRect().width > 0 && box.getBoundingClientRect().height > 0;
    });
    if (checkbox && !checkbox.checked) checkbox.click();
  });
}

export async function prepareEntryAgreement(page, action) {
  const control = await findControl(page, action === "SELL" ? ["卖出订立", "卖订立"] : ["买入订立", "买订立"]);
  if (control) await acceptTradeAgreement(control);
}

export async function findPositionRows(page, { targetPositionIds = [], symbol = "", symbolName = "", instrumentId = "", action } = {}) {
  const result = await page.locator(ROWS).evaluateAll((nodes, input) => {
    const compact = (value) => String(value || "").replace(/\s+/g, "").toLocaleLowerCase();
    const visible = (node) => node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0 && getComputedStyle(node).visibility !== "hidden";
    const ids = input.targetPositionIds.map(compact);
    const values = [input.symbol, input.symbolName, input.instrumentId].map(compact).filter(Boolean);
    const matches = [];
    for (let index = 0; index < nodes.length; index += 1) {
      const row = nodes[index];
      if (!visible(row)) continue;
      const cells = [...row.querySelectorAll("td, [role='cell']")].map((node) => compact(node.textContent));
      if (!cells.length) continue;
      const table = row.closest(".el-table") || row.closest("table, [role='table']");
      const headers = [...(table?.querySelectorAll(".el-table__header th, th, [role='columnheader']") || [])].map((node) => compact(node.textContent));
      const idIndex = headers.findIndex((label) => /持仓单号|订单号/.test(label));
      const sideIndex = headers.findIndex((label) => /^买[|/]卖$|^买卖$/.test(label));
      const id = idIndex >= 0 ? cells[idIndex] : cells.find((cell) => ids.includes(cell));
      const heldSide = sideIndex >= 0 ? cells[sideIndex] : "";
      const directionMatches = !heldSide || !input.action || (input.action === "SELL" ? /买|多|long/i.test(heldSide) : /卖|空|short/i.test(heldSide));
      const targetMatches = ids.length ? ids.includes(id) : values.some((value) => cells.some((cell) => cell === value || cell.includes(value)));
      if (!targetMatches || !directionMatches) continue;
      if (id && matches.some((item) => compact(item.id) === id)) continue;
      const quantityIndex = headers.findIndex((label) => /存货数量|持仓数量/.test(label));
      const frozenIndex = headers.findIndex((label) => /冻结数量/.test(label));
      const number = (value) => Number(String(value || "").replace(/,/g, ""));
      matches.push({ index, id: idIndex >= 0 ? row.querySelectorAll("td, [role='cell']")[idIndex]?.textContent.trim() : input.targetPositionIds.find((value) => compact(value) === id) || "", quantity: quantityIndex >= 0 ? number(cells[quantityIndex]) - (frozenIndex >= 0 ? number(cells[frozenIndex]) : 0) : null });
    }
    return matches;
  }, { targetPositionIds: targetPositionIds.map(String), symbol, symbolName, instrumentId, action });
  return result.map((item) => {
    const cells = item.id ? page.locator("td, [role='cell']").filter({ hasText: new RegExp(`^\\s*${item.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`) }) : null;
    return { ...item, row: cells
      ? page.locator(ROWS.split(", ").map(selector => `${selector}:visible`).join(", ")).filter({ has: cells }).first()
      : page.locator(ROWS).nth(item.index) };
  });
}

export async function preparePositionRows(page, input) {
  await activateTradeControl(page, "持仓明细");
  if (!await waitForAccountTable(page, "持仓单号")) return [];
  const previousPages = new Set();
  while (true) {
    const marker = await paginationText(page);
    if (previousPages.has(marker) || !await turnOrderPage(page, "prev")) break;
    previousPages.add(marker);
  }
  const deadline = Date.now() + 5000;
  const found = new Map();
  const visitedPages = new Set();
  do {
    const rows = await findPositionRows(page, input);
    if (!input.targetPositionIds?.length && rows.length) return rows;
    for (const row of rows) found.set(row.id, row);
    if (input.targetPositionIds?.every((id) => found.has(String(id)))) return [...found.values()];
    const marker = await paginationText(page);
    if (visitedPages.has(marker) || !await turnOrderPage(page, "next")) break;
    visitedPages.add(marker);
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);
  return [];
}

export async function clickPositionTransfer(page, input) {
  const rows = await preparePositionRows(page, input);
  const target = input.targetPositionIds?.length || input.rowIndex == null ? rows[0] : rows.find((row) => row.index === input.rowIndex);
  if (!target) return { clicked: false, code: "EXIT_POSITION_NOT_FOUND" };
  const control = await findControl(target.row, ["转让"], "button, input[type='button'], [role='button'], a, .spotS, [data-action], span", false);
  if (!control) return { clicked: false, code: "EXIT_CONTROL_NOT_FOUND", targetPositionIds: input.targetPositionIds };
  try {
    await control.scrollIntoViewIfNeeded({ timeout: 2500 });
    await control.click({ timeout: 5000 });
    return { clicked: true, label: "转让", positionId: target.id, quantity: target.quantity };
  } catch (error) {
    return { clicked: false, code: "EXIT_CLICK_FAILED", message: error.message, targetPositionIds: input.targetPositionIds };
  }
}

export async function completeTradeDialogs(page, { exitType, cancelOrder = false, orderType, price, baselineToken = "", finished = () => false, canConfirm, resolveConfirmation } = {}) {
  const deadline = Date.now() + 7000;
  const confirmationToken = `${Date.now()}-${Math.random()}`;
  const selector = ".el-message-box, .el-dialog, [role='dialog']";
  let confirmed = false;
  do {
    const boxes = page.locator(selector);
    for (let index = 0; index < await boxes.count(); index += 1) {
      const box = boxes.nth(index);
      if (!await box.isVisible()) continue;
      const text = (await box.innerText()).replace(/\s+/g, "");
      if (!(cancelOrder ? /撤单|撤销.*委托/.test(text) : exitType ? /转让/.test(text) : /确认下单|确认买入|确认卖出|是否确认|合同|协议/.test(text)) || /止盈.*止损|所有委托|所有买|所有卖|全撤|快捷撤单/.test(text)) continue;
      if (/转让价格/.test(text)) {
        // The production dialog initializes counterparty price after 200 ms.
        await page.waitForTimeout(300);
        if (orderType === "LIMIT") {
          const fields = await fillTradeFields(page, [{ labels: ["转让价格"], value: price }], box);
          if (!fields.length) return { ok: false, code: "TRANSFER_PRICE_FIELD_NOT_FOUND" };
        }
        const prices = await box.locator("input").evaluateAll((inputs) => inputs.filter((node) => !node.disabled && node.type !== "checkbox").map((node) => Number(node.value)));
        if (!prices.some((value) => Number.isFinite(value) && value > 0)) continue;
      }
      const control = await findControl(box, ["确定", "确认", "是的", "同意", "我已阅读并同意", "我已阅读并同意签署"], BUTTONS, false)
        || (resolveConfirmation ? await resolveConfirmation(box) : null);
      if (!control || await control.isDisabled()) continue;
      if (canConfirm) {
        const price = await box.locator("input").evaluateAll((inputs) => inputs.filter(node => !node.disabled && node.type !== "checkbox").map(node => Number(node.value)).find(value => value > 0) ?? null);
        const guard = await canConfirm(price);
        if (!guard.ok) {
          const cancel = await findControl(box, ["取消", "关闭"]);
          if (cancel && !await cancel.isDisabled()) await cancel.click({ timeout: 1500 });
          return { ok: false, code: guard.code };
        }
      }
      const fresh = await control.evaluate((node, token) => {
        if (node.dataset.axiomTradeConfirmation === token) return false;
        node.dataset.axiomTradeConfirmation = token;
        return true;
      }, confirmationToken);
      if (!fresh) continue;
      await control.click({ timeout: 5000 });
      confirmed = true;
      await page.waitForTimeout(150);
    }
    if (finished()) return { ok: true, confirmed };
    if (cancelOrder && confirmed) {
      const dialogs = await page.locator(".el-message-box:visible, .el-dialog:visible, [role='dialog']:visible").allTextContents();
      // The caller verifies current orders and fresh feedback after the modal closes.
      if (!dialogs.some((text) => /撤单|撤销.*委托/.test(text))) return { ok: true, confirmed };
    }
    const hint = await page.locator(".el-message:visible, .el-notification__content:visible").evaluateAll((nodes, token) => nodes
      .filter((node) => !token || node.dataset.axiomNoticeBaseline !== token || node.dataset.axiomNoticeText !== String(node.textContent || "").trim())
      .map((node) => node.textContent || ""), baselineToken);
    if (hint.some((text) => /成功|已提交|失败|不足|拒绝|错误/.test(text))) return { ok: true, confirmed };
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);
  return { ok: !exitType || confirmed, confirmed, code: confirmed ? "DIALOG_CONFIRMED" : "TRADE_DIALOG_NOT_CONFIRMED" };
}

export async function dismissOrderCancellationDialogs(page) {
  for (const box of await page.locator(".el-message-box:visible, .el-dialog:visible, [role='dialog']:visible").all()) {
    const text = (await box.innerText()).replace(/\s+/g, "");
    if (!/撤单|撤销.*委托/.test(text) || /所有委托|所有买|所有卖|全撤|快捷撤单/.test(text)) continue;
    const control = await findControl(box, ["取消", "关闭"]);
    if (control && !await control.isDisabled()) await control.click({ timeout: 1500 });
  }
}
