import type { ActionType, Point, RouteType } from './api';

export const statusNames: Record<string, string> = {
  reserved: 'В резерве', packed: 'Собран', in_transit: 'В пути', awaiting_hub: 'Ожидает хаб',
  ready: 'Готов к выдаче', delivered: 'Выдан', cancelled: 'Отменён', awaiting_route: 'Ожидает маршрут', returned: 'Возвращён',
};
export const routeNames: Record<RouteType, string> = { shelf: 'Выдача с полки', direct: 'Прямой рейс', hub: 'Через хаб' };
export const actionNames: Record<ActionType, string> = {
  pack: 'Собрать заказ', handoff: 'Передать курьеру', receive: 'Принять заказ', confirm_hub_delivery: 'Подтвердить доставку хаба',
  issue: 'Выдать заказ', cancel: 'Отменить заказ', shortage: 'Отметить недостачу', replan: 'Пересчитать маршрут',
  update_transit: 'Обновить прогноз', return_good: 'Принять годный возврат', return_damaged: 'Принять возврат с браком',
};
export const operationNames: Record<string, string> = {
  ...actionNames, intake: 'Приёмка партии', storage: 'Хранение', handover: 'Передача курьеру',
  transfer_receive: 'Приёмка в ПВЗ', return: 'Возврат', batch_received: 'Приёмка партии',
  order_created: 'Оформление заказа',
};
const rub = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', minimumFractionDigits: 0, maximumFractionDigits: 2 });
const dates = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Moscow' });
export const money = (value: number) => rub.format(value / 100);
export const dateTime = (value?: string | null) => value ? dates.format(new Date(value)) : 'Срок уточняется';
export const pointName = (points: Point[], id?: string | null) => points.find(point => point.id === id)?.name ?? id ?? '—';
export const productName = (sku: string) => sku === 'CABLE' ? 'Кабель USB-C' : sku;
export const shortId = (id: string) => id.length > 12 ? id.slice(0, 8) : id;
export function moscowInput(offsetHours: number) {
  return new Date(Date.now() + (offsetHours + 3) * 3600000).toISOString().slice(0, 16);
}
export const fromMoscowInput = (value: string) => new Date(value + '+03:00').toISOString();
