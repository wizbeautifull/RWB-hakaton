import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function registerPoint(page: Page, id: string, name: string) {
  await page.getByRole('button', { name: 'Зарегистрировать ПВЗ' }).click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('Код ПВЗ').fill(id);
  await modal.getByLabel('Название').fill(name);
  await modal.getByLabel('Вместимость, см³').fill('1000');
  await modal.getByRole('button', { name: 'Зарегистрировать ПВЗ' }).click();
  await expect(modal).toBeHidden();
  await expect(page.getByLabel('Рабочая точка')).toHaveValue(id);
}

async function perform(page: Page, operation: string, scanCode: string) {
  await page.getByRole('button', { name: operation, exact: true }).click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('Код заказа').fill(scanCode);
  await modal.getByRole('button', { name: 'Подтвердить операцию' }).click();
  await expect(modal).toBeHidden();
}

async function placeDelivery(page: Page) {
  await page.getByRole('button', { name: 'Показать варианты' }).click();
  await page.getByRole('radio', { name: /Дождаться доставки в ПВЗ/ }).check();
  await page.getByRole('button', { name: 'Оформить доставку' }).click();
  await page.getByRole('link', { name: 'Открыть заказ' }).click();
}

test('Wildberries Mesh processes a live order and shows the economics', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('Wildberries Mesh');
  await expect(page.getByText('API подключён')).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Разделы проекта' });
  await nav.getByRole('link', { name: 'ПВЗ', exact: true }).click();
  const register = page.getByRole('button', { name: 'Зарегистрировать ПВЗ' });
  await register.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(register).toBeFocused();
  await registerPoint(page, 'A', 'ПВЗ А');
  await registerPoint(page, 'B', 'ПВЗ Б');
  await page.getByLabel('Рабочая точка').selectOption('A');
  await page.getByRole('button', { name: 'Принять партию' }).click();
  const receipt = page.getByRole('dialog');
  await receipt.getByLabel('Код партии').fill('lot-e2e');
  await receipt.getByLabel('Код товара (SKU)').fill('CABLE');
  await receipt.getByLabel('Код продавца').fill('seller-1');
  await receipt.getByLabel('Количество', { exact: true }).fill('3');
  await receipt.getByLabel('Объём единицы, см³').fill('100');
  await receipt.getByRole('button', { name: 'Принять партию' }).click();
  await expect(receipt).toBeHidden();
  await expect(page.getByText('lot-e2e')).toBeVisible();

  await nav.getByRole('link', { name: 'Оформление' }).click();
  await page.getByLabel('Пункт выдачи').selectOption('B');
  await page.getByRole('switch', { name: /WB Клуб/ }).check();
  await placeDelivery(page);
  await expect(page.getByText('Прямой рейс', { exact: true }).first()).toBeVisible();
  const scanCode = await page.locator('code').innerText();
  await page.getByRole('button', { name: 'Собрать заказ', exact: true }).click();
  const scan = page.getByRole('dialog');
  await scan.getByLabel('Код заказа').fill('unknown');
  await scan.getByRole('button', { name: 'Подтвердить операцию' }).click();
  await expect(scan.getByRole('alert')).toContainText('Код посылки не соответствует заказу');
  await scan.getByLabel('Код заказа').fill(scanCode);
  await scan.getByRole('button', { name: 'Подтвердить операцию' }).click();
  await expect(scan).toBeHidden();
  await perform(page, 'Передать курьеру', scanCode);
  await page.getByLabel('Рабочая точка').selectOption('B');
  await perform(page, 'Принять заказ', scanCode);
  await perform(page, 'Выдать заказ', scanCode);
  await expect(page.getByText('Выдан', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/^45[\s\u00a0]*₽$/)).toBeVisible();

  await nav.getByRole('link', { name: 'ПВЗ', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Рабочее место ПВЗ' })).toBeVisible();
  await page.getByLabel('Рабочая точка').selectOption('B');
  await page.getByRole('button', { name: 'Начисления', exact: true }).click();
  await expect(page.getByText('Прибыль ПВЗ', { exact: true })).toBeVisible();
  await expect(page.getByText(/^10[\s\u00a0]*₽$/)).toBeVisible();
  await nav.getByRole('link', { name: 'Продавец' }).click();
  await page.getByLabel('Код продавца').fill('seller-1');
  await page.getByRole('button', { name: 'Показать отчёт' }).click();
  await expect(page.getByRole('columnheader', { name: 'Прибыль' })).toBeVisible();
  await expect(page.getByText(/^107,5[\s\u00a0]*₽$/)).toBeVisible();

  await nav.getByRole('link', { name: 'Оформление' }).click();
  await expect(page.getByRole('heading', { name: 'Оформление заказа' })).toBeVisible();
  await page.getByLabel('Пункт выдачи').selectOption('B');
  await expect(page.getByRole('switch', { name: /WB Клуб/ })).not.toBeChecked();
  await placeDelivery(page);
  await expect(page.getByText('Через хаб', { exact: true }).first()).toBeVisible();
  const hubCode = await page.locator('code').innerText();
  await perform(page, 'Подтвердить доставку хаба', hubCode);
  await perform(page, 'Выдать заказ', hubCode);
  await perform(page, 'Принять возврат с браком', hubCode);
  await expect(page.getByText('Возвращён', { exact: true }).first()).toBeVisible();

  await nav.getByRole('link', { name: 'Для жюри' }).click();
  await expect(page.getByText('Экономия 7,67%', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '8 заказов' }).click();
  await expect(page.getByText(/^185[\s\u00a0]*₽$/)).toBeVisible();
  await page.getByRole('button', { name: '10 заказов' }).click();
  await page.getByLabel('Дни хранения').fill('40');
  await page.getByRole('button', { name: 'Пересчитать сценарий' }).click();
  await expect(page.getByText(/^270[\s\u00a0]*₽$/)).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: 'Сравнение маршрутов' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  await nav.getByRole('link', { name: 'Оформление' }).click();
  await expect(page.getByRole('heading', { name: 'Оформление заказа' })).toBeVisible();
  await page.getByLabel('Пункт выдачи').selectOption('B');
  const optionsResponse = page.waitForResponse(response => response.url().endsWith('/api/orders/options'));
  await page.getByRole('button', { name: 'Показать варианты' }).click();
  const options = await (await optionsResponse).json();
  const shelf = page.getByRole('radio', { name: /Забрать сегодня с полки.*ПВЗ А/ });
  await expect(page.getByRole('radio', { name: /Дождаться доставки в ПВЗ.*ПВЗ Б/ })).toBeVisible();
  if (options.shelf_today.length) {
    await shelf.check();
    await page.getByRole('button', { name: 'Зарезервировать с полки' }).click();
    await page.getByRole('link', { name: 'Открыть заказ' }).click();
    await expect(page.getByText('Выдача с полки', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('1 шт. · выдача в ПВЗ А')).toBeVisible();
  } else {
    await expect(shelf).toHaveCount(0);
    await expect(page.getByText(/Самовывоз сегодня недоступен/)).toBeVisible();
  }
});
