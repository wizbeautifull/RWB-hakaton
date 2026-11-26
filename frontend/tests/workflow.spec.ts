import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

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

async function openPickupOrder(pickup: Page, buyer: Page, point: string) {
  const hash = new URL(buyer.url()).hash;
  const id = decodeURIComponent(hash.slice('#/orders/'.length));
  const shortId = id.length > 12 ? id.slice(0, 8) : id;
  await pickup.goto('/pvz/#/?point=' + encodeURIComponent(point));
  await pickup.getByRole('link').filter({ hasText: shortId }).click();
  await expect(pickup.getByRole('heading', { name: 'Операции ПВЗ' })).toBeVisible();
}

test('customer, pickup and seller sites share live stock and order status', async ({ page, context, request }) => {
  const pickup = await context.newPage();
  const seller = await context.newPage();
  await seller.route('https://yandex.ru/map-widget/**', route => route.fulfill({ contentType: 'text/html', body: 'Map widget' }));
  await Promise.all([page.goto('/'), pickup.goto('/pvz/'), seller.goto('/seller/')]);
  await expect(page).toHaveTitle('Wildberries Mesh');
  await expect(pickup).toHaveTitle('Wildberries Mesh · ПВЗ');
  await expect(seller).toHaveTitle('Wildberries Mesh · Продавец');
  const nav = page.getByRole('navigation', { name: 'Разделы проекта' });
  const pickupNav = pickup.getByRole('navigation', { name: 'Разделы проекта' });
  const sellerNav = seller.getByRole('navigation', { name: 'Разделы проекта' });
  await expect(nav.getByRole('link')).toHaveText(['Оформление', 'Мои заказы']);
  await expect(pickupNav.getByRole('link')).toHaveText(['ПВЗ']);
  await expect(sellerNav.getByRole('link')).toHaveText(['Продавец']);
  const buyerCatalog = page.getByRole('combobox', { name: 'Товар', exact: true });
  await expect(buyerCatalog).toHaveText('Каталог пуст');
  await seller.getByLabel('Код продавца').fill('seller-1');
  await seller.getByRole('button', { name: 'Показать отчёт' }).click();
  await expect(seller.getByText('Нет партий по выбранным фильтрам.')).toBeVisible();

  const register = pickup.getByRole('link', { name: 'Зарегистрировать ПВЗ' });
  await expect(register).toHaveAttribute('href', 'https://pvz.wb.ru');
  for (const [id, name, longitude] of [['A', 'ПВЗ А', 37.5979], ['B', 'ПВЗ Б', 37.6559]] as const) {
    const response = await request.put(`/api/points/${id}`, { data: {
      name, capacity_cm3: 1000, location: { longitude, latitude: 55.7521 },
    } });
    expect(response.ok()).toBe(true);
  }
  await seller.bringToFront();
  const supply = seller.getByRole('region', { name: 'Куда привезти поставку' });
  await expect(supply.getByTitle('Яндекс Карты · ПВЗ Wildberries')).toBeVisible({ timeout: 10_000 });
  const pointA = supply.getByRole('button', { name: /^ПВЗ А\s/ });
  const pointB = supply.getByRole('button', { name: /^ПВЗ Б\s/ });
  const quantity = supply.getByLabel('Количество в поставке, шт.');
  await quantity.fill('10');
  await expect(pointA).toBeDisabled();
  await expect(pointB).toBeDisabled();
  await quantity.fill('9');
  await pointA.click();
  await expect(supply.getByText('Выбран ПВЗ А')).toBeVisible();
  await expect(supply.getByTitle('Яндекс Карты · ПВЗ Wildberries')).toHaveAttribute('src', /ll=37\.5979%2C55\.7521/);
  await pickup.getByLabel('Рабочая точка').selectOption('A');
  const acceptBatch = pickup.getByRole('button', { name: 'Принять партию' });
  await acceptBatch.click();
  const receipt = pickup.getByRole('dialog');
  await expect(receipt).toBeVisible();
  await pickup.keyboard.press('Escape');
  await expect(acceptBatch).toBeFocused();
  await acceptBatch.click();
  await receipt.getByLabel('Код партии').fill('lot-e2e');
  await receipt.getByLabel('Код товара (SKU)').fill('CABLE');
  await receipt.getByLabel('Код продавца').fill('seller-1');
  await receipt.getByLabel('Имя продавца').fill('Магазин электроники');
  await receipt.getByLabel('Количество', { exact: true }).fill('3');
  await receipt.getByLabel('Объём единицы, см³').fill('100');
  await receipt.getByRole('button', { name: 'Принять партию' }).click();
  await expect(receipt).toBeHidden();
  await expect(pickup.getByRole('columnheader', { name: 'Продавец' })).toBeVisible();
  const stockRow = pickup.getByRole('row').filter({ hasText: 'lot-e2e' });
  await expect(stockRow.getByRole('cell', { name: 'Магазин электроники' })).toBeVisible();
  await seller.bringToFront();
  await expect(pointA).toBeDisabled({ timeout: 10_000 });
  await expect(pointB).toBeEnabled();
  await expect(supply.getByText(/В выбранном ПВЗ сейчас недостаточно места/)).toBeVisible();
  await pointB.click();
  await expect(supply.getByText('Выбран ПВЗ Б')).toBeVisible();
  await expect(seller.getByText('lot-e2e')).toBeVisible({ timeout: 10_000 });
  await expect(seller.getByText('3 шт.', { exact: true }).first()).toBeVisible();

  await page.bringToFront();
  await expect(buyerCatalog).toHaveValue('CABLE', { timeout: 10_000 });
  await page.getByLabel('Пункт выдачи').selectOption('B');
  await page.getByRole('switch', { name: /WB Клуб/ }).check();
  await placeDelivery(page);
  await expect(page.getByText('Прямой рейс', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Операции ПВЗ' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Код получения' })).toBeVisible();
  const scanCode = await page.locator('code').innerText();
  await openPickupOrder(pickup, page, 'A');
  await seller.bringToFront();
  await expect(seller.getByText('2 шт.', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
  await pickup.getByRole('button', { name: 'Собрать заказ', exact: true }).click();
  const scan = pickup.getByRole('dialog');
  await scan.getByLabel('Код заказа').fill('unknown');
  await scan.getByRole('button', { name: 'Подтвердить операцию' }).click();
  await expect(scan.getByRole('alert')).toContainText('Код посылки не соответствует заказу');
  await scan.getByLabel('Код заказа').fill(scanCode);
  await scan.getByRole('button', { name: 'Подтвердить операцию' }).click();
  await expect(scan).toBeHidden();
  await perform(pickup, 'Передать курьеру', scanCode);
  await pickup.getByLabel('Рабочая точка').selectOption('B');
  await perform(pickup, 'Принять заказ', scanCode);
  await perform(pickup, 'Выдать заказ', scanCode);
  await expect(pickup.getByText(/^45[\s\u00a0]*₽$/)).toBeVisible();
  await page.bringToFront();
  await expect(page.getByText('Выдан', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
  await nav.getByRole('link', { name: 'Мои заказы' }).click();
  await expect(page.getByRole('heading', { name: 'Мои заказы' })).toBeVisible();
  await expect(page.getByText('Выдан', { exact: true })).toBeVisible();

  await pickupNav.getByRole('link', { name: 'ПВЗ', exact: true }).click();
  await expect(pickup.getByRole('heading', { name: 'Рабочее место ПВЗ' })).toBeVisible();
  await pickup.getByLabel('Рабочая точка').selectOption('B');
  await pickup.getByRole('button', { name: 'Начисления', exact: true }).click();
  await expect(pickup.getByText('Прибыль ПВЗ', { exact: true })).toBeVisible();
  await expect(pickup.getByText(/^10[\s\u00a0]*₽$/)).toBeVisible();
  await seller.bringToFront();
  await expect(seller.getByRole('columnheader', { name: 'Прибыль' })).toBeVisible();
  await expect(seller.getByText(/^107,5[\s\u00a0]*₽$/)).toBeVisible({ timeout: 10_000 });

  await nav.getByRole('link', { name: 'Оформление' }).click();
  await expect(page.getByRole('heading', { name: 'Оформление заказа' })).toBeVisible();
  await page.getByLabel('Пункт выдачи').selectOption('B');
  await expect(page.getByRole('switch', { name: /WB Клуб/ })).not.toBeChecked();
  await placeDelivery(page);
  await expect(page.getByText('Через хаб', { exact: true }).first()).toBeVisible();
  const desktopViewport = page.viewportSize()!;
  const routeStops = page.getByRole('list', { name: 'Точки маршрута' });
  await expect(routeStops.getByRole('listitem')).toHaveText(['Отправление', 'Хаб', 'ПВЗ Б']);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await routeStops.evaluate(track => track.scrollWidth <= track.clientWidth)).toBe(true);
  await page.setViewportSize(desktopViewport);
  const hubCode = await page.locator('code').innerText();
  await openPickupOrder(pickup, page, 'B');
  await perform(pickup, 'Подтвердить доставку хаба', hubCode);
  await perform(pickup, 'Выдать заказ', hubCode);
  await perform(pickup, 'Принять возврат с браком', hubCode);
  await page.bringToFront();
  await expect(page.getByText('Возвращён', { exact: true }).first()).toBeVisible({ timeout: 10_000 });

  await pickup.goto('/pvz/#/jury');
  await expect(pickup.getByText('Экономия 7,67%', { exact: true })).toBeVisible();
  await pickup.getByRole('button', { name: '8 заказов' }).click();
  await expect(pickup.getByText(/^185[\s\u00a0]*₽$/)).toBeVisible();
  await pickup.getByRole('button', { name: '10 заказов' }).click();
  await pickup.getByLabel('Дни хранения').fill('40');
  await pickup.getByRole('button', { name: 'Пересчитать сценарий' }).click();
  await expect(pickup.getByText(/^270[\s\u00a0]*₽$/)).toBeVisible();

  await pickup.setViewportSize({ width: 390, height: 844 });
  await expect(pickup.getByRole('heading', { name: 'Сравнение маршрутов' })).toBeVisible();
  expect(await pickup.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

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
