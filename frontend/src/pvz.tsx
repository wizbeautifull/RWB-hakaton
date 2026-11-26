import { useState } from 'react';
import { Boxes, CirclePlus, MapPin, PackagePlus, Wallet } from 'lucide-react';
import { api } from './api';
import type { Ledger, Operation, Point, PointMargin, Stock } from './api';
import { demoOrder, demoStock } from './demo';
import { dateTime, fromMoscowInput, money, moscowInput, operationNames, pointName, productName } from './format';
import { Dialog, Empty, ErrorMessage, Field, Heading, field, useResource, useSubmit } from './ui';
import type { Mode } from './ui';
import { OrderList } from './orders';

type StockAction = 'storage' | 'reconcile_found' | 'reconcile_missing' | 'move_slow' | 'remove_slow' | 'send_damaged_to_hub';
const stockActions: Record<StockAction, string> = {
  storage: 'Подтвердить хранение', reconcile_found: 'Вернуть найденное', reconcile_missing: 'Списать недостачу',
  move_slow: 'Перенести товар', remove_slow: 'Вывезти товар', send_damaged_to_hub: 'Отправить брак в хаб',
};
export function StockTable({ rows, points, onSelect }: { rows: Stock[]; points: Point[]; onSelect?: (row: Stock) => void }) {
  if (!rows.length) return <Empty>Нет партий по выбранным фильтрам.</Empty>;
  return <div className="table-wrap"><table className="data-table"><thead><tr>
    <th scope="col">Товар / партия</th><th scope="col">ПВЗ</th><th scope="col">Доступно</th><th scope="col">Резерв</th><th scope="col">В пути</th><th scope="col">Готово</th><th scope="col">Спорные</th><th scope="col">Брак</th><th scope="col">Хранение</th>{onSelect && <th scope="col">Действия</th>}
  </tr></thead><tbody>{rows.map(row => <tr key={row.point_id + '/' + row.batch_id}>
    <td><strong>{productName(row.sku)}</strong><small>{row.batch_id}</small></td><td>{pointName(points, row.point_id)}</td>
    <td>{row.available}</td><td>{row.reserved}</td><td>{row.in_transit}</td><td>{row.ready}</td><td>{row.blocked}</td><td>{row.damaged}</td>
    <td>{row.storage_days} дн.{row.slow_stock && <small className="tag tag--amber">Долгое</small>}</td>
    {onSelect && <td><button className="button button--secondary" onClick={() => onSelect(row)}>Открыть партию</button></td>}
  </tr>)}</tbody></table></div>;
}
function PointForm({ close, done }: { close: () => void; done: (point: Point) => void }) {
  const transaction = useSubmit(data => api.putPoint(field(data, 'id'), {
    name: field(data, 'name'), capacity_cm3: Number(field(data, 'capacity')),
  }), done);
  return <Dialog title="Регистрация ПВЗ" close={close}><form className="form-stack" onSubmit={transaction.submit}>
    <Field label="Код ПВЗ"><input name="id" maxLength={80} required autoFocus/></Field>
    <Field label="Название"><input name="name" maxLength={80} required/></Field>
    <Field label="Вместимость, см³"><input name="capacity" type="number" min="1" max="1000000000" required/></Field>
    <ErrorMessage error={transaction.error}/><button className="button button--primary" disabled={transaction.pending}>Зарегистрировать ПВЗ</button>
  </form></Dialog>;
}
function ReceiptForm({ point, close, done }: { point: Point; close: () => void; done: () => void }) {
  const [initialDate] = useState(() => moscowInput(-1));
  const transaction = useSubmit(data => api.receipt({
    point_id: point.id, batch_id: field(data, 'batch'), seller_id: field(data, 'seller'), sku: field(data, 'sku'),
    quantity: Number(field(data, 'quantity')), unit_volume_cm3: Number(field(data, 'volume')), delivered_at: fromMoscowInput(field(data, 'date')),
  }), done);
  return <Dialog title="Приёмка партии" close={close}><form className="form-stack" onSubmit={transaction.submit}>
    <p className="muted">{point.name} · свободно {point.free_volume_cm3} см³</p>
    <div className="form-pair"><Field label="Код партии"><input name="batch" maxLength={80} required autoFocus/></Field>
    <Field label="Код товара (SKU)"><input name="sku" maxLength={80} required/></Field></div>
    <Field label="Код продавца"><input name="seller" maxLength={80} required/></Field>
    <div className="form-pair"><Field label="Количество"><input name="quantity" type="number" min="1" max="1000000" required/></Field>
    <Field label="Объём единицы, см³"><input name="volume" type="number" min="1" max="1000000000" required/></Field></div>
    <Field label="Дата поставки · Москва"><input name="date" type="datetime-local" defaultValue={initialDate} required/></Field>
    <ErrorMessage error={transaction.error}/><button className="button button--primary" disabled={transaction.pending}>Принять партию</button>
  </form></Dialog>;
}
function StockForm({ row, points, close, done }: { row: Stock; points: Point[]; close: () => void; done: () => void }) {
  const options: [StockAction, number][] = [
    ['storage', row.available + row.reserved + row.ready],
    ['reconcile_found', row.blocked], ['reconcile_missing', row.blocked], ['move_slow', row.slow_stock ? row.available : 0],
    ['remove_slow', row.slow_stock ? row.available : 0], ['send_damaged_to_hub', row.damaged],
  ];
  const allowed = options.filter(([, quantity]) => quantity > 0);
  const [selected, setSelected] = useState<StockAction>(allowed[0]?.[0] ?? 'storage');
  const transaction = useSubmit(data => api.stockAction(row.point_id, row.batch_id, selected === 'storage', {
    quantity: Number(field(data, 'quantity')),
    ...(selected !== 'storage' ? { type: selected } : {}),
    ...(selected === 'move_slow' ? { destination_point_id: field(data, 'destination') } : {}),
  }), done);
  return <Dialog title={'Партия ' + row.batch_id} close={close}>
    {!allowed.length ? <Empty>Нет доступных операций.</Empty> : <form className="form-stack" onSubmit={transaction.submit}>
      <Field label="Операция"><select value={selected} onChange={event => setSelected(event.target.value as StockAction)}>{allowed.map(([type]) => <option key={type} value={type}>{stockActions[type]}</option>)}</select></Field>
      <Field label={selected === 'storage' ? 'Количество, товаро-дни' : 'Количество, шт.'}><input name="quantity" type="number" min="1" max={options.find(([type]) => type === selected)?.[1]} defaultValue="1" required/></Field>
      {selected === 'move_slow' && <Field label="ПВЗ назначения"><select name="destination" required><option value="">Выберите ПВЗ</option>{points.filter(point => point.id !== row.point_id).map(point => <option key={point.id} value={point.id}>{point.name}</option>)}</select></Field>}
      {selected === 'storage' && <p className="muted">Подтверждение за текущие сутки UTC.</p>}
      <ErrorMessage error={transaction.error}/><button className="button button--primary" disabled={transaction.pending}>Подтвердить операцию</button>
    </form>}
  </Dialog>;
}
type Tab = 'queue' | 'stock' | 'ledger';
const tabs: { id: Tab; label: string }[] = [{ id: 'queue', label: 'Очередь заказов' }, { id: 'stock', label: 'Остатки' }, { id: 'ledger', label: 'Начисления' }];
export function Pvz({ mode, points, initialPoint, reload }: { mode: Mode; points: Point[]; initialPoint: string; reload: () => void }) {
  const [pointId, setPointId] = useState(initialPoint);
  const [tab, setTab] = useState<Tab>('queue');
  const [revision, setRevision] = useState(0);
  const [all, setAll] = useState(false);
  const [orderFilter, setOrderFilter] = useState('');
  const [message, setMessage] = useState('');
  const [modal, setModal] = useState<'point' | 'receipt' | Stock>();
  const point = points.find(item => item.id === pointId) ?? points[0];
  const filter = { point_id: point?.id ?? '', ...(orderFilter ? { order_id: orderFilter } : {}) };
  const id = point?.id;
  const key = mode + ':' + id + ':' + revision;
  const queue = useResource(() => mode === 'live' && id ? api.orders(id, !all) : Promise.resolve(id === 'A' || (id === 'B' && all) ? [demoOrder] : []), key + all);
  const stock = useResource(() => mode === 'live' && id ? api.inventory({ point_id: id }) : Promise.resolve(demoStock.filter(row => row.point_id === id)), key);
  const ledger = useResource<[Ledger, Operation[], PointMargin | null]>(() => mode === 'live' && id
    ? Promise.all([api.accruals(filter), api.operations(filter), api.pointMargin(id, orderFilter)])
    : Promise.resolve([{ items: [], total_kopecks: 0 }, [], null]), key + ':' + orderFilter);
  function changed(label: string) { setMessage(label); setModal(undefined); setRevision(value => value + 1); reload(); }
  const current = tab === 'queue' ? queue : tab === 'stock' ? stock : ledger;
  const [accruals, operations, margin] = ledger.data ?? [];
  return <>
    <Heading crumb="ПВЗ" title="Рабочее место ПВЗ" description="Приёмка партий, очередь заказов, остатки и начисления по точке."
      extra={<button className="button button--primary" disabled={mode !== 'live' || !point} onClick={() => setModal('receipt')}><PackagePlus size={19}/> Принять партию</button>}/>
    <div className="hero form-stack" data-enter>
      <div className="card point-bar">
        <span className="card__icon"><MapPin size={22}/></span>
        <Field label="Рабочая точка"><select value={id ?? ''} onChange={event => {setPointId(event.target.value); setMessage('');}}>
          {!points.length && <option value="">Нет зарегистрированных ПВЗ</option>}{points.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></Field>
        {point && <div className="point-bar__capacity"><strong>{point.free_volume_cm3} см³</strong><small>доступный объём</small></div>}
        <button className="button button--secondary" disabled={mode !== 'live'} onClick={() => setModal('point')}><CirclePlus size={18}/> Зарегистрировать ПВЗ</button>
      </div>
      {message && <div className="notice notice--success" role="status">{message}</div>}
      <div className="card">
        <div className="segmented" aria-label="Разделы ПВЗ">{tabs.map(item => <button type="button" className="segmented__button" aria-pressed={tab === item.id} key={item.id} onClick={() => setTab(item.id)}>{item.label}</button>)}</div>
        <ErrorMessage error={current.error}/>
        {!point ? <Empty>Зарегистрируйте ПВЗ, чтобы начать работу.</Empty> : <>
          {!current.data && !current.error && <Empty>Загружаем данные…</Empty>}
          {tab === 'queue' && <><label className="check"><input type="checkbox" checked={all} onChange={event => setAll(event.target.checked)}/> Показать все заказы точки</label>
            {queue.data && <OrderList orders={queue.data} points={points} point={id}/>}</>}
          {tab === 'stock' && <><div className="card__heading card__heading--spaced"><Boxes size={22}/><h2>Партии на точке</h2></div>
            {stock.data && <StockTable rows={stock.data} points={points} onSelect={mode === 'live' ? setModal : undefined}/>}</>}
          {tab === 'ledger' && <>
            <div className="card__heading card__heading--spaced"><Wallet size={22}/><h2>Начисления по операциям</h2></div>
            <Field label="Фильтр по заказу"><input placeholder="Введите полный ID заказа" value={orderFilter} maxLength={80} onChange={event => setOrderFilter(event.target.value.trim())}/></Field>
            {margin && <div className="stats">
              <div><span>Начислено ПВЗ</span><strong className="metric">{money(margin.revenue_kopecks)}</strong></div>
              <div><span>Расходы ПВЗ</span><strong className="metric">{money(margin.costs_kopecks)}</strong></div>
              <div><span>Прибыль ПВЗ</span><strong className="metric">{money(margin.profit_kopecks)}</strong></div>
            </div>}
            {accruals && operations && <>
              {operations.length ? <ul className="event-list">{operations.map(event => {
                const accrual = accruals.items.find(item => item.event_id === event.event_id);
                return <li key={event.event_id}><div><strong>{operationNames[event.type] ?? event.type}</strong><small>{dateTime(event.occurred_at)} · {event.order_id ?? event.batch_id}</small></div><span>{accrual ? money(accrual.amount_kopecks) : '—'}</span></li>;
              })}</ul> : <Empty>Нет подтверждённых операций.</Empty>}</>}
          </>}
        </>}
      </div>
    </div>
    {modal === 'point' && <PointForm close={() => setModal(undefined)} done={item => {setPointId(item.id); changed('ПВЗ зарегистрирован.');}}/>}
    {modal === 'receipt' && point && <ReceiptForm point={point} close={() => setModal(undefined)} done={() => {setTab('stock'); changed('Партия принята.');}}/>}
    {typeof modal === 'object' && <StockForm row={modal} points={points} close={() => setModal(undefined)} done={() => changed('Операция подтверждена.')}/>}
  </>;
}
