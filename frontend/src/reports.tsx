import { useState } from 'react';
import { ArrowDownRight, ArrowRight, ChartNoAxesCombined, ChevronDown, Database, Truck, Warehouse } from 'lucide-react';
import { api } from './api';
import type { Point, SellerMargin, Stock } from './api';
import { demoOrder, demoStock } from './demo';
import { dateTime, money, pointName, productName, routeNames, shortId, statusNames } from './format';
import { StockTable } from './pvz';
import { Empty, ErrorMessage, Field, Heading, RouteMap, useResource } from './ui';
import type { Mode } from './ui';

export function Seller({ mode, points }: { mode: Mode; points: Point[] }) {
  const [seller, setSeller] = useState(mode === 'demo' ? 'seller-1' : '');
  const [point, setPoint] = useState('');
  const filter = { seller_id: seller, ...(point ? { point_id: point } : {}) };
  const report = useResource<[Stock[], SellerMargin[]]>(() => mode === 'live' && seller
    ? Promise.all([api.inventory(filter), api.sellerMargin(seller, point)])
    : Promise.resolve([demoStock.filter(item => mode === 'demo' && item.seller_id === seller
      && (!point || item.point_id === point)), []]), JSON.stringify([mode, seller, point]), mode === 'live' && !!seller);
  const [rows = [], orderMargins = []] = report.data ?? [];
  return <>
    <Heading crumb="Продавец" title="Кабинет продавца" description="Остатки, срок хранения и расчёт прибыли по заказам."/>
    <div className="hero form-stack" data-enter>
      <form className="card seller-filter" onSubmit={event => {event.preventDefault(); setSeller(String(new FormData(event.currentTarget).get('seller')).trim());}}>
        <Field label="Код продавца"><input name="seller" defaultValue={seller} placeholder="seller-1" maxLength={80} required/></Field>
        <Field label="Пункт выдачи"><select value={point} onChange={event => setPoint(event.target.value)}><option value="">Все точки</option>{points.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
        <button className="button button--primary">Показать отчёт <ArrowRight size={17}/></button>
      </form>
      {seller && report.data && <div className="stats">
        <div className="card"><span>Доступно к заказу</span><strong className="metric">{rows.reduce((sum, row) => sum + row.available, 0)} шт.</strong></div>
        <div className="card"><span>В резерве</span><strong className="metric">{rows.reduce((sum, row) => sum + row.reserved, 0)} шт.</strong></div>
        <div className="card"><span>На долгом хранении</span><strong className="metric">{rows.filter(row => row.slow_stock).length} парт.</strong></div>
      </div>}
      <div className="card"><h2>Партии продавца</h2><ErrorMessage error={report.error}/>
        {!seller ? <Empty>Укажите код продавца.</Empty> : report.data ? <StockTable rows={rows} points={points}/> : !report.error && <Empty>Загружаем остатки…</Empty>}
      </div>
      <div className="card"><h2>Прибыль по заказам</h2>
        <p className="muted">Расчёт по учебным тарифам. До выдачи показана прогнозная прибыль, после возврата учтён его исход.</p>
        {orderMargins.length ? <div className="table-wrap" role="region" tabIndex={0} aria-label="Прибыль по заказам"><table className="data-table">
          <thead><tr>{['Заказ', 'ПВЗ', 'Выручка', 'Товар', 'Комиссия', 'Доставка', 'Хранение', 'Возврат', 'Прибыль'].map(name =>
            <th scope="col" key={name}>{name}</th>)}</tr></thead>
          <tbody>{orderMargins.map(row => <tr key={row.order_id}>
            <td><strong>{shortId(row.order_id)}</strong>
              <small>{productName(row.sku)} · {statusNames[row.status] ?? row.status}</small></td>
            <td>{pointName(points, row.point_id)}</td><td>{money(row.revenue_kopecks)}</td><td>{money(row.goods_kopecks)}</td>
            <td>{money(row.commission_kopecks)}</td><td>{money(row.logistics_kopecks)}</td><td>{money(row.storage_kopecks)}</td>
            <td>{money(row.return_kopecks)}</td><td><strong>{money(row.profit_kopecks)}</strong></td>
          </tr>)}</tbody>
        </table></div> : <Empty>{mode === 'demo' ? 'Подключите API, чтобы увидеть расчёт по заказам.' : 'Нет заказов по выбранным фильтрам.'}</Empty>}
      </div>
    </div>
  </>;
}

const scenarios = [
  ['Прямой рейс', 'Примите три кабеля в А и оформите один в Б с WB Клубом при загрузке 10 заказов. Соберите, передайте, примите и выдайте. Ожидаем 162 ₽ против 172 ₽, две единицы доступны в А, в пути — ноль.'],
  ['Хаб при низкой загрузке', 'При 8 заказах прямой рейс стоит 185 ₽, хаб — 172 ₽. Подтвердите доставку хаба и выдайте заказ.'],
  ['Выдача с полки', 'Примите товар в ПВЗ выдачи. Сборка сразу переводит заказ в готовность.'],
  ['Закрыто окно приёмки', 'Закройте окно прямого рейса в Б в конфигурации. Оформите заказ и проверьте причину отклонения рейса.'],
  ['Повторное сканирование', 'В проверке API повтор идентичного запроса выдачи возвращает текущее состояние. Изменённое тело с тем же request_id даёт 409.'],
  ['Маршрутов нет', 'Отключите прямой рейс и хаб, уберите местный остаток. Оформление отклоняется с причиной.'],
  ['Отмена до отправки', 'После резервирования отмените заказ. Проверьте остаток и освобождение мест в рейсе и окнах.'],
  ['Недостача при сборке', 'Отметьте недостачу. Спорный остаток заблокирован, заказ перенаправлен или ожидает маршрут.'],
  ['Сверка недостачи', 'Откройте спорную партию в остатках ПВЗ. Найденное верните в доступные остатки, подтверждённую недостачу спишите.'],
  ['Рейс сорвался до отправки', 'Пересчитайте маршрут с указанием причины. В истории видно, почему рейс исключён.'],
  ['Курьер опоздал в пути', 'Обновите положение и минуты до прибытия. Без окна готовность уточняется, с доступным окном появляется новый срок.'],
  ['ПВЗ переполнен', 'Попробуйте принять партию или заказ сверх доступного объёма. Остатки и текущий статус сохраняются.'],
  ['Два покупателя на последний товар', 'Оформите два заказа параллельно. Только один резервирует последнюю единицу.'],
  ['Последнее место в рейсе или окне', 'Оформите два заказа параллельно. Вместимость не превышена, при отмене место освобождается.'],
  ['Сохраняющиеся расходы хаба', 'В конфигурации увеличьте retained_hub_unit_kopecks до равной стоимости. При доступности обоих вариантов выбран хаб.'],
  ['Возврат годного товара', 'Примите годный возврат. Товар снова доступен в точке возврата.'],
  ['Возврат брака', 'Примите брак, затем отправьте его в хаб из карточки партии.'],
  ['Долгое хранение', 'В остатках перенесите одну старую партию и вывезите другую. Проверьте остатки в обеих точках и дни хранения.'],
  ['Начисления по заказу', 'После прямого рейса проверьте историю и выплаты. По примеру начисляется 45 ₽ за четыре операции, приёмка партии учитывается отдельно.'],
  ['Двойное начисление за хранение', 'Подтвердите хранение дважды с разными request_id. За одни сутки UTC начисление для партии в ПВЗ возникает один раз.'],
  ['Тарифы покупателя', 'Ускоренная выдача в пилоте без доплаты. Включение WB Клуба влияет на доступные маршруты.'],
];

export function Jury({ mode, points, initialOrder }: { mode: Mode; points: Point[]; initialOrder: string }) {
  const [load, setLoad] = useState<8 | 10>(10);
  const [assumptions, setAssumptions] = useState({ days: '', returns: '' });
  const [orderId, setOrderId] = useState(initialOrder);
  const [expanded, setExpanded] = useState(false);
  const orders = useResource(() => mode === 'live' ? api.orders() : Promise.resolve([demoOrder]), mode, mode === 'live');
  const selected = orders.data?.find(order => order.id === orderId) ?? orders.data?.[0];
  const comparison = useResource(
    () => mode === 'live' ? api.comparison(load, assumptions.days, assumptions.returns) : Promise.resolve(null),
    JSON.stringify([mode, load, assumptions]),
  );
  const quote = comparison.data;
  const route = selected?.route;
  return <>
    <Heading crumb="Для жюри" title="Сравнение маршрутов" description="Себестоимость рейса при разной загрузке и решение системы по конкретному заказу."/>
    <div className="hero form-stack" data-enter>
      <div className="workspace-grid">
        <div className="card comparison">
          <div className="card__heading"><span className="card__icon"><ChartNoAxesCombined size={22}/></span><h2>Контрольный расчёт</h2></div>
          <div className="comparison__control"><span>Заказов в рейсе</span><div className="segmented" aria-label="Число заказов">
            {([10, 8] as const).map(count => <button className="segmented__button" key={count} aria-pressed={count === load} onClick={() => setLoad(count)}>{count} заказов</button>)}
          </div></div>
          <form className="form-stack" onSubmit={event => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            setAssumptions({ days: String(data.get('days') ?? ''), returns: String(data.get('returns') ?? '') });
          }}>
            <div className="form-pair">
              <Field label="Дни хранения"><input name="days" type="number" min="0" max="3650" placeholder="4"/></Field>
              <Field label="Вероятность возврата, %"><input name="returns" type="number" min="0" max="100" step="0.01" placeholder="10"/></Field>
            </div>
            <button type="submit" className="button button--secondary" disabled={mode !== 'live'}>Пересчитать сценарий</button>
          </form>
          <ErrorMessage error={comparison.error}/>
          {quote && <div aria-live="polite">
            <div className="comparison__options">
              <div className={'comparison__option' + (quote.selected_route === 'direct' ? ' comparison__option--winner' : '')}>
                <Truck size={23}/><span>Прямой рейс</span><strong>{money(quote.direct_kopecks)}</strong></div>
              <div className={'comparison__option' + (quote.selected_route === 'hub' ? ' comparison__option--winner' : '')}>
                <Warehouse size={23}/><span>Через хаб</span><strong>{money(quote.hub_kopecks)}</strong></div>
            </div>
            <p className="comparison__result"><ArrowDownRight size={19}/>{routeNames[quote.selected_route]} при загрузке {quote.trip_orders}.</p>
            <p className="muted">Дополнительные расходы WB на хранение {money(quote.direct_storage_extra_kopecks)}, ожидаемые расходы на возврат {money(quote.expected_return_kopecks)} на заказ.</p>
          </div>}
          {mode === 'demo' && <Empty>Подключите API для расчёта сценария.</Empty>}
        </div>
        <RouteMap route={route} points={points} sample={mode === 'demo'}/>
      </div>
      {quote && <div className="card" aria-live="polite">
        <h2>Расходы Wildberries на {quote.cohort_orders} заказов</h2>
        <p className="muted">С полки {quote.distribution.shelf} · прямым рейсом {quote.distribution.direct} · через хаб {quote.distribution.hub}</p>
        <div className="stats">
          <div><span>Все через хаб</span><strong className="metric">{money(quote.baseline_kopecks)}</strong></div>
          <div><span>Схема Mesh</span><strong className="metric">{money(quote.mesh_kopecks)}</strong></div>
          <div><span>Экономия {quote.savings_percent.toLocaleString('ru-RU')}%</span><strong className="metric">{money(quote.savings_kopecks)}</strong></div>
        </div>
      </div>}
      <div className="card">
        <div className="card__heading"><span className="card__icon"><Database size={21}/></span><h2>Решение по заказу</h2></div>
        <ErrorMessage error={orders.error}/>
        {orders.data?.length ? <>
          <Field label="Заказ"><select value={selected?.id ?? ''} onChange={event => setOrderId(event.target.value)}>{orders.data.map(order => <option key={order.id} value={order.id}>{shortId(order.id)} · {order.sku}</option>)}</select></Field>
          {route ? <>
            <p><strong>{routeNames[route.route_type]}.</strong> {route.reason}</p>
            <div className="table-wrap" role="region" tabIndex={0} aria-label="Варианты маршрута"><table className="data-table"><thead><tr><th>Вариант</th><th>Стоимость</th><th>Готовность · МСК</th><th>Решение</th></tr></thead>
              <tbody><tr><td>{routeNames[route.route_type]}</td><td>{money(route.estimated_unit_cost_kopecks)}</td><td>{dateTime(route.ready_at)}</td><td><span className="tag tag--green">Выбран</span></td></tr>
                {route.evaluations.filter(item => item.quote && item.status !== 'selected').map((item, index) => <tr key={index}><td>{routeNames[item.route_type]}</td><td>{money(item.quote!.cost_kopecks)}</td><td>{dateTime(item.quote!.ready_at)}</td><td>{item.status === 'rejected' ? 'Недоступен' : 'Альтернатива'}</td></tr>)}
              </tbody></table></div>
            {route.evaluations.length > 0 && <details className="scenario"><summary>Почему варианты отклонили или выбрали<ChevronDown size={16}/></summary>
              <ul className="event-list">{route.evaluations.map((item, index) => <li key={index}><div><strong>{routeNames[item.route_type]} · {item.reason}</strong><small>{[item.source_id, item.trip_id, item.reason_code].filter(Boolean).join(' · ')}</small></div>{item.quote && <span>{money(item.quote.cost_kopecks)}<small>{dateTime(item.quote.ready_at)}</small></span>}</li>)}</ul>
            </details>}
          </> : <Empty>{selected?.route_failure ?? 'У заказа пока нет маршрута.'}</Empty>}
        </> : !orders.error && <Empty>{orders.data ? 'После оформления здесь появится сравнение вариантов.' : 'Загружаем заказы…'}</Empty>}
      </div>
      <div className="card"><div className="scenarios__heading"><h2>Сценарии проверки</h2><button className="button button--secondary" onClick={() => setExpanded(value => !value)} aria-expanded={expanded}>{expanded ? 'Свернуть список' : 'Показать 21 сценарий'} <ChevronDown size={17}/></button></div>
        {expanded && <ol className="scenarios">{scenarios.map(([title, description]) => <li key={title}><details className="scenario"><summary>{title}<ChevronDown size={17}/></summary><p>{description}</p></details></li>)}</ol>}
      </div>
    </div>
  </>;
}
