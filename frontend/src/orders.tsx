import { useState } from 'react';
import { ArrowRight, ChevronRight, ClipboardList, ScanLine } from 'lucide-react';
import { api, ApiError } from './api';
import type { NextAction, Order, Point } from './api';
import { customerOrderIds } from './customer-orders';
import { demoOrder } from './demo';
import { actionNames, dateTime, money, operationNames, pointName, productName, shortId } from './format';
import { Back, Dialog, Empty, ErrorMessage, Field, Heading, OrderSummary, RouteMap, Status, field, useResource, useSubmit } from './ui';
import type { Mode } from './ui';

export function OrderList({ orders, points, point }: { orders: Order[]; points: Point[]; point?: string }) {
  if (!orders.length) return <Empty>Заказов пока нет.</Empty>;
  return <ul className="order-list">{orders.map(order => {
    const action = point ? order.next_actions.find(item => item.point_id === point) : undefined;
    const target = '#/orders/' + encodeURIComponent(order.id) + (point ? '?point=' + encodeURIComponent(point) : '');
    return <li key={order.id}><a className="order-list__row" href={target}>
      <span className="order-list__icon"><ClipboardList size={19}/></span><span className="order-list__name"><strong>{productName(order.sku)} · {order.quantity} шт.</strong><small>{shortId(order.id)} · {pointName(points, order.pickup_point_id)}</small></span>
      <span className="order-list__action">{action && actionNames[action.type]}</span><Status value={order.status}/><ChevronRight size={17}/>
    </a></li>;
  })}</ul>;
}
export function CustomerOrders({ mode, points }: { mode: Mode; points: Point[] }) {
  const orders = useResource(async () => {
    if (mode === 'demo') return [demoOrder];
    const records = await Promise.all(customerOrderIds().map(async id => {
      try { return await api.order(id); }
      catch (error) {
        if (error instanceof ApiError && error.code === 'order_not_found') return undefined;
        throw error;
      }
    }));
    return records.filter(order => order !== undefined);
  }, mode, mode === 'live');
  return <>
    <Heading crumb="Заказы" title="Мои заказы" description="Статусы заказов, оформленных в этом браузере."
      extra={<a className="button button--primary" href="#/">Оформить заказ <ArrowRight size={17}/></a>}/>
    <div className="card hero" data-enter><ErrorMessage error={orders.error}/>{orders.data ? <OrderList orders={orders.data} points={points}/> : !orders.error && <Empty>Загружаем заказы…</Empty>}</div>
  </>;
}
function ActionForm({ order, action, points, done, close }: { order: Order; action: NextAction; points: Point[]; done: (order: Order) => void; close: () => void }) {
  const transaction = useSubmit(data => api.orderAction(order.id, {
    type: action.type, point_id: action.point_id, scan_code: field(data, 'scan_code'),
    ...(action.type === 'replan' ? { reason: field(data, 'reason') } : {}),
    ...(action.type === 'shortage' ? { shortage_batch_id: field(data, 'batch') || null, shortage_quantity: field(data, 'quantity') ? Number(field(data, 'quantity')) : null } : {}),
    ...(action.type === 'update_transit' ? { actual_position: field(data, 'position'), remaining_travel_minutes: field(data, 'minutes') ? Number(field(data, 'minutes')) : null } : {}),
  }), done);
  return <Dialog title={actionNames[action.type]} close={close}>
    <form className="form-stack" onSubmit={transaction.submit}>
      <p className="muted">{pointName(points, action.point_id)}</p>
      <Field label="Код заказа"><input autoFocus name="scan_code" maxLength={80} required autoComplete="off"/></Field>
      {action.type === 'replan' && <Field label="Причина пересчёта"><input name="reason" maxLength={80} required/></Field>}
      {action.type === 'shortage' && <>
        <Field label="Партия"><select name="batch"><option value="">Резерв заказа</option>{order.allocations.map(batch => <option key={batch.batch_id}>{batch.batch_id}</option>)}</select></Field>
        <Field label="Количество · пустое поле означает весь резерв"><input name="quantity" type="number" min="1" max={order.quantity}/></Field>
      </>}
      {action.type === 'update_transit' && <>
        <Field label="Текущее положение"><input name="position" maxLength={80} defaultValue={order.actual_position ?? ''} required/></Field>
        <Field label="Минут до прибытия"><input name="minutes" type="number" min="0" max="525600"/></Field>
      </>}
      <ErrorMessage error={transaction.error}/>
      <button className="button button--primary" disabled={transaction.pending}>{transaction.pending ? 'Подтверждаем…' : 'Подтвердить операцию'}</button>
    </form>
  </Dialog>;
}
export function OrderDetail({ id, point, mode, points, canOperate }: { id: string; point: string; mode: Mode; points: Point[]; canOperate: boolean }) {
  const [revision, setRevision] = useState(0);
  const resource = useResource(() => mode === 'live' ? api.order(id) : Promise.resolve(id === demoOrder.id ? demoOrder : undefined), `${mode}:${id}:${revision}`, mode === 'live');
  const [latest, setLatest] = useState<Order>();
  const [action, setAction] = useState<NextAction>();
  const order = resource.data ?? latest;
  const [selectedPoint, setSelectedPoint] = useState(point);
  const activePoint = selectedPoint || order?.next_actions[0]?.point_id || '';
  const available = order?.next_actions.filter(item => item.point_id === activePoint) ?? [];
  return <>
    <Heading crumb="Карточка заказа" title={order ? productName(order.sku) : 'Карточка заказа'} description={order ? order.quantity + ' шт. · выдача в ' + pointName(points, order.pickup_point_id) : 'Статус и маршрут доставки.'}
      extra={<Back to={canOperate ? '#/' + (point ? '?point=' + encodeURIComponent(point) : '') : '#/orders'}>{canOperate ? 'К очереди ПВЗ' : 'К списку заказов'}</Back>}/>
    <ErrorMessage error={resource.error}/>
    {!order && !resource.error && <Empty>{mode === 'demo' && id !== demoOrder.id ? 'Для просмотра этого заказа подключите FastAPI.' : 'Загружаем карточку…'}</Empty>}
    {order && <div className="workspace-grid hero" data-enter>
      <div className="workspace-grid__main">
        <div className="card"><OrderSummary order={order} points={points}/></div>
        {canOperate ? <div className="card">
          <div className="card__heading"><span className="card__icon"><ScanLine size={21}/></span><h2>Операции ПВЗ</h2></div>
          <p className="muted">Код для ручного ввода <code>{order.scan_code}</code></p>
          <Field label="Рабочая точка"><select value={activePoint} onChange={event => setSelectedPoint(event.target.value)}>
            <option value="">Выберите ПВЗ</option>{points.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select></Field>
          {available.length ? <div className="actions">{available.map((entry, index) => <button className={'button ' + (index === 0 ? 'button--primary' : 'button--secondary')} disabled={mode !== 'live'} key={entry.type} onClick={() => setAction(entry)}>{actionNames[entry.type]}</button>)}</div> : <Empty>Для этого ПВЗ сейчас нет действий по заказу.</Empty>}
        </div> : <div className="card"><h2>Код получения</h2><code>{order.scan_code}</code></div>}
        <div className="card"><h2>{canOperate ? 'История операций' : 'История заказа'}</h2>
          {order.operations.length ? <ul className="event-list">{order.operations.map(event => <li key={event.event_id}>
            <div><strong>{operationNames[event.type] ?? event.type}</strong><small>{pointName(points, event.point_id)} · {dateTime(event.occurred_at)}</small>
            {canOperate && ['reason', 'replan_cause'].map(key => typeof event.details[key] === 'string' ? <small key={key}>{String(event.details[key])}</small> : null)}</div>
            <span>{event.quantity} шт.</span>
          </li>)}</ul> : <Empty>Подтверждённых операций пока нет.</Empty>}
        </div>
      </div>
      <aside className="workspace-grid__aside">
        <RouteMap route={order.route} points={points} pickup={order.pickup_point_id} sample={mode === 'demo'}/>
        {canOperate && order.route && <div className="card"><h2>Причина выбора</h2><p>{order.route.reason}</p><a className="text-link" href={'#/jury?order=' + encodeURIComponent(order.id)}>Сравнить маршруты <ArrowRight size={16}/></a></div>}
        {canOperate && <div className="card"><h2>Начисления по заказу</h2><strong className="metric">{money(order.accrual_total_kopecks)}</strong>
          {order.accruals.length > 0 && <ul className="event-list">{order.accruals.map(item => <li key={item.event_id}><div>{operationNames[item.reason] ?? item.reason}<small>{pointName(points, item.point_id)}</small></div><strong>{money(item.amount_kopecks)}</strong></li>)}</ul>}
        </div>}
      </aside>
    </div>}
    {order && action && <ActionForm order={order} action={action} points={points} close={() => setAction(undefined)} done={updated => {setLatest(updated); setRevision(value => value + 1); setAction(undefined);}}/>}
  </>;
}
