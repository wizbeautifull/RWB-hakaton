import { useState } from 'react';
import { ArrowRight, CalendarDays, ChevronDown, MapPin, Package, ShoppingBag, Sparkles, Usb } from 'lucide-react';
import { api } from './api';
import type { Order, Point, Product } from './api';
import { demoOrder } from './demo';
import { fromMoscowInput, money, moscowInput, pointName, productName } from './format';
import { ErrorMessage, Field, Heading, OrderSummary, RouteMap, field, useSubmit } from './ui';
import type { Mode } from './ui';

export function Checkout({ mode, points, products }: { mode: Mode; points: Point[]; products: Product[] }) {
  const [pickup, setPickup] = useState('');
  const [sku, setSku] = useState('');
  const [club, setClub] = useState(false);
  const [order, setOrder] = useState<Order>();
  const [deadline] = useState(() => moscowInput(48));
  const selectedPickup = points.some(point => point.id === pickup) ? pickup : points.at(-1)?.id ?? '';
  const selectedSku = products.some(product => product.sku === sku) ? sku : products[0]?.sku ?? '';
  const transaction = useSubmit(data => api.create({
    sku: selectedSku, pickup_point_id: selectedPickup, wb_club: club,
    quantity: Number(field(data, 'quantity')), promised_by: fromMoscowInput(field(data, 'promised_by')),
  }), setOrder);
  const sample = mode === 'demo' && !order && selectedSku === demoOrder.sku && selectedPickup === demoOrder.pickup_point_id;
  return <>
    <Heading crumb="Покупатель" title="Оформление заказа" description="Выберите товар и пункт выдачи. Срок готовности появится после оформления."
      extra={<span className="location"><MapPin size={17}/> Москва</span>}/>
    <div className="checkout hero" data-enter>
      <div className="checkout__main">
        <form id="checkout-form" className="card checkout-form" onSubmit={transaction.submit}>
          <div className="card__heading"><span className="card__icon"><ShoppingBag size={21}/></span><h2>Товар в заказе</h2></div>
          <div className="checkout-form__product">
            <div className="product-art" aria-hidden="true"><Usb size={42} strokeWidth={1.4}/></div>
            <Field label="Товар"><select required value={selectedSku} onChange={e => setSku(e.target.value)}>
              {!products.length && <option value="">Каталог пуст</option>}
              {products.map(product => <option key={product.sku} value={product.sku}>{productName(product.sku)}</option>)}
            </select></Field>
            <Field label="Количество"><input name="quantity" type="number" min="1" max="1000000" defaultValue="1" required/></Field>
          </div>
          <div className="checkout-form__delivery">
            <div className="card__heading"><span className="card__icon"><MapPin size={21}/></span><h2>Получение заказа</h2></div>
            <Field label="Пункт выдачи"><select required value={selectedPickup} onChange={e => setPickup(e.target.value)}>
              {!points.length && <option value="">Нет зарегистрированных ПВЗ</option>}
              {points.map(point => <option key={point.id} value={point.id}>{point.name}</option>)}
            </select></Field>
            <label className="club"><span className="club__icon"><Sparkles size={19}/></span><span><strong>WB Клуб</strong><small>Открывает проверку локальной доставки</small></span>
              <input className="club__switch" type="checkbox" role="switch" checked={club} onChange={e => setClub(e.target.checked)}/>
            </label>
            <details className="deadline"><summary><CalendarDays size={17}/> Крайний срок для расчёта <ChevronDown size={16}/></summary>
              <Field label="Дата и время · Москва"><input name="promised_by" type="datetime-local" defaultValue={deadline} required/></Field>
            </details>
          </div>
        </form>
        {order && <div className="card" role="status">
          <OrderSummary order={order} points={points} link/>
          {order.route?.reason && <p className="muted">{order.route.reason}</p>}
        </div>}
      </div>
      <aside className="checkout__aside">
        <RouteMap route={order?.route ?? (sample ? demoOrder.route : undefined)} points={points} pickup={selectedPickup} sample={sample}/>
        <div className="card checkout-total">
          <div className="card__heading"><span className="card__icon"><Package size={21}/></span><h2>Подтверждение</h2></div>
          <div className="checkout-total__row"><span>Пункт выдачи</span><strong>{pointName(points, selectedPickup)}</strong></div>
          <div className="checkout-total__row"><span>WB Клуб</span><strong>{club ? 'Подключён' : 'Без подписки'}</strong></div>
          {order && <div className="checkout-total__row"><span>Доплата за ускорение</span><strong>{money(order.buyer_acceleration_fee_kopecks ?? 0)}</strong></div>}
          <ErrorMessage error={transaction.error}/>
          {mode === 'demo'
            ? <a className="button button--primary button--full" href={'#/orders/' + demoOrder.id}>Открыть пример заказа <ArrowRight size={19}/></a>
            : <button className="button button--primary button--full" form="checkout-form" type="submit" disabled={mode !== 'live' || !selectedSku || !selectedPickup || transaction.pending}>
              {transaction.pending ? 'Оформляем заказ…' : 'Оформить заказ'}<ArrowRight size={19}/>
            </button>}
          {mode === 'demo' && <p className="checkout-total__note">Для оформления подключите FastAPI.</p>}
          {mode === 'live' && (!points.length || !products.length) && <p className="checkout-total__note"><a href="#/pvz">Зарегистрируйте ПВЗ и примите партию</a>, чтобы оформить заказ.</p>}
        </div>
      </aside>
    </div>
  </>;
}
