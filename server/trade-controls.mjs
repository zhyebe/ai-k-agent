const BUTTONS = "button, input[type='button'], input[type='submit'], [role='button'], a";
const TABS = "button, [role='tab'], .el-tabs__item, .el-radio-button__inner, .trade_btn, .tab_btn, .header_l_item, span, a, div";
const ROWS = "tr, [role='row'], .el-table__row, .position-row";

async function findControl(root, labels, selector = BUTTONS) {
  const index = await root.locator(selector).evaluateAll((nodes, wanted) => {
    const compact = (value) => String(value || "").replace(/\s+/g, "");
    return nodes.findIndex((node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none"
        && wanted.includes(compact(node.value || node.getAttribute("aria-label") || node.textContent));
    });
  }, labels.map((label) => label.replace(/\s+/g, "")));
  return index < 0 ? null : root.locator(selector).nth(index);
}

export async function activateTradeControl(page, label) {
  const control = await findControl(page, [label], TABS);
  if (!control) return false;
  await control.click({ timeout: 5000 });
  return true;
}

export async function fillTradeFields(root, fields) {
  const filled = [];
  for (const { labels, value } of fields) {
    if (value == null) continue;
    const match = await root.locator("input").evaluateAll((inputs, wanted) => {
      const compact = (value) => String(value || "").replace(/[\s:：]/g, "");
      const visible = (node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== "hidden";
      };
      for (let index = 0; index < inputs.length; index += 1) {
        const input = inputs[index];
        if (!visible(input) || /checkbox|radio|hidden|button|submit/.test(input.type) || input.disabled || input.readOnly) continue;
        const container = input.closest(".inputWrap, .el-form-item, li, label, .form-item") || input.parentElement;
        const labels = [...(input.labels || []), ...container.querySelectorAll("label, span, p, .el-form-item__label")];
        const label = labels.find((node) => visible(node) && wanted.includes(compact(node.textContent)));
        if (label) return { index, label: compact(label.textContent) };
      }
      return null;
    }, labels.map((label) => label.replace(/[\s:：]/g, "")));
    if (!match) continue;
    await root.locator("input").nth(match.index).fill(String(value), { timeout: 5000 });
    filled.push(match.label);
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
  const control = await findControl(page, labels);
  if (!control) return { clicked: false, code: "SUBMIT_BUTTON_NOT_FOUND", tried: labels };
  await acceptTradeAgreement(control);
  try {
    await control.click({ timeout: 5000 });
    return { clicked: true, label: labels[0] };
  } catch (error) {
    return { clicked: false, code: await control.isDisabled() ? "SUBMIT_BUTTON_DISABLED" : "SUBMIT_CLICK_FAILED", message: error.message, tried: labels };
  }
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
  return result.map((item) => ({ ...item, row: page.locator(ROWS).nth(item.index) }));
}

export async function preparePositionRows(page, input) {
  await activateTradeControl(page, "持仓明细");
  const deadline = Date.now() + 5000;
  do {
    const rows = await findPositionRows(page, input);
    if (rows.length && (!input.targetPositionIds?.length || input.targetPositionIds.every((id) => rows.some((row) => row.id === String(id))))) return rows;
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);
  return [];
}

export async function clickPositionTransfer(page, input) {
  const rows = await preparePositionRows(page, input);
  const target = input.targetPositionIds?.length || input.rowIndex == null ? rows[0] : rows.find((row) => row.index === input.rowIndex);
  if (!target) return { clicked: false, code: "EXIT_POSITION_NOT_FOUND" };
  const control = await findControl(target.row, ["转让"], "button, input[type='button'], [role='button'], a, .spotS, [data-action], span");
  if (!control) return { clicked: false, code: "EXIT_CONTROL_NOT_FOUND", targetPositionIds: input.targetPositionIds };
  await control.click({ timeout: 5000 });
  return { clicked: true, label: "转让", positionId: target.id, quantity: target.quantity };
}

export async function completeTradeDialogs(page, { exitType, orderType, price, baselineToken = "", finished = () => false } = {}) {
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
      if (!(exitType ? /转让/.test(text) : /确认下单|确认买入|确认卖出|是否确认|合同|协议/.test(text)) || /止盈.*止损/.test(text)) continue;
      if (/转让价格/.test(text)) {
        // The production dialog initializes counterparty price after 200 ms.
        await page.waitForTimeout(300);
        if (orderType === "LIMIT") {
          const fields = await fillTradeFields(box, [{ labels: ["转让价格"], value: price }]);
          if (!fields.length) return { ok: false, code: "TRANSFER_PRICE_FIELD_NOT_FOUND" };
        }
        const prices = await box.locator("input").evaluateAll((inputs) => inputs.filter((node) => !node.disabled && node.type !== "checkbox").map((node) => Number(node.value)));
        if (!prices.some((value) => Number.isFinite(value) && value > 0)) continue;
      }
      const control = await findControl(box, ["确定", "确认", "是的", "同意", "我已阅读并同意", "我已阅读并同意签署"]);
      if (!control || await control.isDisabled()) continue;
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
    const hint = await page.locator(".el-message:visible, .el-notification__content:visible").evaluateAll((nodes, token) => nodes
      .filter((node) => !token || node.dataset.axiomNoticeBaseline !== token || node.dataset.axiomNoticeText !== String(node.textContent || "").trim())
      .map((node) => node.textContent || ""), baselineToken);
    if (hint.some((text) => /成功|已提交|失败|不足|拒绝|错误/.test(text))) return { ok: true, confirmed };
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);
  return { ok: !exitType || confirmed, confirmed, code: confirmed ? "DIALOG_CONFIRMED" : "TRADE_DIALOG_NOT_CONFIRMED" };
}
