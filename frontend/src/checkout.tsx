import { useState } from 'react';
import { ArrowRight, CalendarDays, ChevronDown, MapPin, Minus, Package, Plus, ShoppingBag, Sparkles, Store, Truck } from 'lucide-react';
import { api } from './api';
import type { CheckoutDraft, CheckoutOptions, Order, Point, Product, Route } from './api';
import { rememberCustomerOrder } from './customer-orders';
import { demoOrder } from './demo';
import { dateTime, fromMoscowInput, money, moscowInput, pointName, productName } from './format';
import { ErrorMessage, Field, Heading, OrderSummary, RouteMap, field, useSubmit } from './ui';
import type { Mode } from './ui';
import { PickupMap } from './yandex-map';

type Selection = { kind: 'delivery' | 'shelf_today'; route: Route; id: string };

function choices(options: CheckoutOptions): Selection[] {
  const entries: Selection[] = options.shelf_today.map(route => ({
    kind: 'shelf_today', route, id: 'shelf:' + route.pickup_point_id,
  }));
  if (options.delivery) entries.push({ kind: 'delivery', route: options.delivery, id: 'delivery' });
  return entries;
}

function ProductThumbnail({ sku }: { sku: string }) {
  return <span className="checkout-photo" aria-hidden="true">
    <Package size={28} strokeWidth={1.5}/>
    {sku === 'CABLE' && <img alt="" src={import.meta.env.BASE_URL + 'usb-c-cable.png'}
      onError={event => { event.currentTarget.hidden = true; }}/>}
  </span>;
}

export function Checkout({ mode, points, products }: { mode: Mode; points: Point[]; products: Product[] }) {
  const [pickup, setPickup] = useState('');
  const [sku, setSku] = useState('');
  const [club, setClub] = useState(false);
  const [quantity, setQuantity] = useState('1');
  const [order, setOrder] = useState<Order>();
  const [quote, setQuote] = useState<{ draft: CheckoutDraft; options: CheckoutOptions }>();
  const [selectedId, setSelectedId] = useState('');
  const [deadline] = useState(() => moscowInput(48));
  const selectedPickup = points.some(point => point.id === pickup) ? pickup : points.at(-1)?.id ?? '';
  const pickupAddress = points.find(point => point.id === selectedPickup)?.location?.address;
  const mapPoints = points.flatMap(point => point.location ? [{ id: point.id, name: point.name, location: point.location }] : []);
  const selectedSku = products.some(product => product.sku === sku) ? sku : products[0]?.sku ?? '';
  const units = Number(quantity) || 0;
  const quoteRequest = useSubmit(async data => {
    confirm.clearError();
    const draft: CheckoutDraft = {
      sku: selectedSku, pickup_point_id: selectedPickup, wb_club: club,
      quantity: Number(field(data, 'quantity')), promised_by: fromMoscowInput(field(data, 'promised_by')),
    };
    return { draft, options: await api.checkoutOptions(draft) };
  }, result => {
    setQuote(result);
    const entries = choices(result.options);
    setSelectedId(entries.length === 1 ? entries[0].id : '');
    setOrder(undefined);
  });
  const entries = quote ? choices(quote.options) : [];
  const selection = entries.find(entry => entry.id === selectedId);
  const confirm = useSubmit(async () => {
    if (!quote || !selection) throw new Error('Выберите способ получения');
    return api.create({
      ...quote.draft, fulfillment: selection.kind,
      ...(selection.kind === 'shelf_today' ? {
        shelf_point_id: selection.route.pickup_point_id, shelf_date: quote.options.shelf_date,
      } : {}),
    });
  }, placedOrder => {
    rememberCustomerOrder(placedOrder.id);
    setOrder(placedOrder);
    setQuote(undefined);
    setSelectedId('');
  });
  function invalidateQuote() {
    confirm.clearError();
    quoteRequest.clearError();
    setQuote(undefined);
    setSelectedId('');
    setOrder(undefined);
  }
  function changeQuantity(delta: number) {
    setQuantity(String(Math.min(1_000_000, Math.max(1, units + delta))));
    invalidateQuote();
  }
  function choosePickup(id: string) {
    if (confirm.pending || quoteRequest.pending) return;
    setPickup(id);
    if (id !== selectedPickup) invalidateQuote();
  }
  const sample = mode === 'demo' && !order && selectedSku === demoOrder.sku && selectedPickup === demoOrder.pickup_point_id;
  return <>
    <Heading crumb="Покупатель" title="Оформление заказа" description="Выберите товар и ПВЗ для доставки, затем проверьте, где его можно забрать сегодня."
      extra={<span className="location"><MapPin size={17}/> Москва</span>}/>
    <div className="checkout hero" data-enter>
      <div className="checkout__main">
        <form id="checkout-form" className="checkout-form" onSubmit={quoteRequest.submit} onChange={invalidateQuote}>
          <fieldset className="checkout-fields checkout-form__sections" disabled={confirm.pending || quoteRequest.pending}>
            <section className="card checkout-product">
              <div className="card__heading"><span className="card__icon"><ShoppingBag size={21}/></span><h2>Товар в заказе</h2></div>
              <div className="checkout-product__body">
                <ProductThumbnail sku={selectedSku}/>
                <div className="checkout-product__fields">
                  <Field label="Товар"><select required value={selectedSku} onChange={e => setSku(e.target.value)}>
                    {!products.length && <option value="">Каталог пуст</option>}
                    {products.map(product => <option key={product.sku} value={product.sku}>{productName(product.sku)}</option>)}
                  </select></Field>
                  <div className="field">
                    <label className="field__label" htmlFor="checkout-quantity">Количество</label>
                    <div className="checkout-quantity">
                      <button type="button" aria-label="Уменьшить количество" disabled={units <= 1} onClick={() => changeQuantity(-1)}><Minus size={17}/></button>
                      <input id="checkout-quantity" name="quantity" type="number" min="1" max="1000000" value={quantity} onChange={e => setQuantity(e.target.value)} required/>
                      <button type="button" aria-label="Увеличить количество" disabled={units >= 1_000_000} onClick={() => changeQuantity(1)}><Plus size={17}/></button>
                    </div>
                  </div>
                </div>
              </div>
            </section>
            <section className="card checkout-delivery">
              <div className="card__heading"><span className="card__icon"><MapPin size={21}/></span><h2>Получение заказа</h2></div>
              <Field label="Пункт выдачи"><select required value={selectedPickup} onChange={e => setPickup(e.target.value)}>
                {!points.length && <option value="">Нет зарегистрированных ПВЗ</option>}
                {points.map(point => <option key={point.id} value={point.id}>{point.name}</option>)}
              </select></Field>
              {pickupAddress && <p className="checkout-pickup-address muted">{pickupAddress}</p>}
              {points.length > 0 && <PickupMap mode={mode} points={mapPoints} selectedId={selectedPickup}
                focusSelected={Boolean(pickup)} onSelect={choosePickup}/>}
              <label className="club"><span className="club__icon"><Sparkles size={19}/></span><span><strong>WB Клуб</strong><small>Открывает проверку локальной доставки</small></span>
                <input className="club__switch" type="checkbox" role="switch" checked={club} onChange={e => setClub(e.target.checked)}/>
              </label>
              <details className="deadline"><summary><CalendarDays size={17}/> Крайний срок для расчёта <ChevronDown size={16}/></summary>
                <Field label="Дата и время · Москва"><input name="promised_by" type="datetime-local" defaultValue={deadline} required/></Field>
              </details>
            </section>
          </fieldset>
        </form>
        {order && <div className="card" role="status">
          <OrderSummary order={order} points={points} link/>
          {order.route?.reason && <p className="muted">{order.route.reason}</p>}
        </div>}
      </div>
      <aside className="checkout__aside">
        <div className="card checkout-total">
          <h2>Ваш заказ</h2>
          {selectedSku && <div className="checkout-total__product">
            <ProductThumbnail sku={selectedSku}/>
            <div><strong>{productName(selectedSku)}</strong><small>{units} шт.</small></div>
          </div>}
          <div className="checkout-total__row"><span>Пункт выдачи</span><strong>{pointName(points, order?.pickup_point_id ?? selection?.route.pickup_point_id ?? selectedPickup)}</strong></div>
          {order && <div className="checkout-total__row"><span>Доплата за ускорение</span><strong>{money(order.buyer_acceleration_fee_kopecks ?? 0)}</strong></div>}
          <ErrorMessage error={quoteRequest.error}/>
          {quote && <form className="form-stack" onSubmit={confirm.submit}>
            {entries.length > 0 && <fieldset className="checkout-fields fulfillment-options" aria-label="Доступные варианты получения" disabled={confirm.pending || quoteRequest.pending}>
              {entries.map(entry => <label className="fulfillment-option" key={entry.id}>
                <input type="radio" name="fulfillment" value={entry.id} checked={selectedId === entry.id} onChange={() => setSelectedId(entry.id)}/>
                <span>
                  <strong>{entry.kind === 'shelf_today' ? 'Забрать сегодня с полки' : 'Дождаться доставки в ПВЗ'}</strong>
                  <small>{pointName(points, entry.route.pickup_point_id)} · {dateTime(entry.route.ready_at)} МСК</small>
                </span>
                {entry.kind === 'shelf_today' ? <Store size={18} aria-hidden="true"/> : <Truck size={18} aria-hidden="true"/>}
              </label>)}
            </fieldset>}
            {!quote.options.shelf_today.length && <p className="muted">Самовывоз сегодня недоступен. Проверьте другой товар или количество.</p>}
            {quote.options.delivery_failure && <p className="muted">Доставка недоступна к указанному сроку. {quote.options.delivery_failure}</p>}
            <ErrorMessage error={confirm.error}/>
            {entries.length > 0 && <button className="button button--primary button--full" disabled={!selection || confirm.pending || quoteRequest.pending}>
              {confirm.pending ? 'Подтверждаем…' : selection?.kind === 'shelf_today' ? 'Зарезервировать с полки' : 'Оформить доставку'} <ArrowRight size={19}/>
            </button>}
          </form>}
          {mode === 'demo'
            ? <a className="button button--primary button--full" href={'#/orders/' + demoOrder.id}>Открыть пример заказа <ArrowRight size={19}/></a>
            : <button className={'button button--full ' + (quote ? 'button--secondary fulfillment-refresh' : 'button--primary')} form="checkout-form" type="submit" disabled={mode !== 'live' || !selectedSku || !selectedPickup || quoteRequest.pending || confirm.pending}>
              {quoteRequest.pending ? 'Проверяем…' : quote ? 'Обновить варианты' : 'Показать варианты'}<ArrowRight size={19}/>
            </button>}
          {mode === 'demo' && <p className="checkout-total__note">Для оформления подключите FastAPI.</p>}
          {mode === 'live' && (!points.length || !products.length) && <p className="checkout-total__note">Товары появятся в каталоге после приёмки партии в ПВЗ.</p>}
        </div>
        {(order?.route || selection || sample) && <RouteMap route={order?.route ?? selection?.route ?? demoOrder.route} points={points} pickup={selectedPickup} sample={sample}/>}
      </aside>
    </div>
  </>;
}
