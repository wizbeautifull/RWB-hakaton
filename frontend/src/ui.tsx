import { Fragment, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { ArrowLeft, ArrowRight, CircleAlert, Clock3, GitFork, MapPin, Package, PackageCheck, Warehouse, X } from 'lucide-react';
import type { Order, Point, Route } from './api';
import { ApiError } from './api';
import { dateTime, pointName, routeNames, statusNames } from './format';

export type Mode = 'checking' | 'demo' | 'live';
export function useResource<T>(load: () => Promise<T>, key: string) {
  const [state, setState] = useState<{ key: string; data?: T; error?: unknown }>({ key });
  useEffect(() => {
    let current = true;
    load().then(data => { if (current) setState({ key, data }); }, error => { if (current) setState({ key, error }); });
    return () => { current = false; };
  }, [key]);
  return state.key === key ? state : { key };
}
export function useSubmit<T>(save: (data: FormData) => Promise<T>, done: (value: T) => void) {
  const locked = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked.current) return;
    const data = new FormData(event.currentTarget);
    locked.current = true;
    setPending(true);
    setError(undefined);
    try { done(await save(data)); }
    catch (failure) { setError(failure); }
    finally { locked.current = false; setPending(false); }
  }
  return { submit, pending, error, clearError: () => setError(undefined) };
}
export const field = (data: FormData, key: string) => String(data.get(key) ?? '').trim();
export function ErrorMessage({ error }: { error: unknown }) {
  if (!error) return null;
  return <div className="notice notice--error" role="alert"><CircleAlert size={19}/><div>
    {error instanceof Error ? error.message : 'Не удалось выполнить запрос.'}
    {error instanceof ApiError && (error.reason || error.code) && <small>{[error.code, error.reason].filter(Boolean).join(' · ')}</small>}
  </div></div>;
}
export function Heading({ crumb, title, description, extra }: { crumb: string; title: string; description: string; extra?: ReactNode }) {
  return <div className="page-heading"><div>
    <div className="page-heading__crumb"><a href="#/">Wildberries Mesh</a><span>/</span>{crumb}</div>
    <h1 className="page-heading__title">{title}</h1>
    <p className="page-heading__description">{description}</p>
  </div>{extra}</div>;
}
export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="field"><span className="field__label">{label}</span>{children}</label>;
}
export function Status({ value }: { value: string }) {
  const tone = ['ready', 'delivered'].includes(value) ? 'green' : ['cancelled', 'awaiting_route'].includes(value) ? 'amber' : 'berry';
  return <span className={'tag tag--' + tone}>{statusNames[value] ?? value}</span>;
}
export function RouteMap({ route, points, pickup, sample = false }: { route?: Route | null; points: Point[]; pickup?: string; sample?: boolean }) {
  const type = route?.route_type;
  const destinationId = route?.pickup_point_id ?? pickup;
  const stops = [{
    id: 'destination', label: destinationId ? pointName(points, destinationId) : 'Выберите ПВЗ',
    marker: <MapPin size={17}/>, end: Boolean(type),
  }];
  if (type === 'hub') {
    stops.unshift(
      { id: 'dispatch', label: 'Отправление', marker: <Package size={17}/>, end: false },
      { id: 'hub', label: 'Хаб', marker: <Warehouse size={17}/>, end: false },
    );
  } else if (route?.route_type === 'direct') {
    stops.unshift({
      id: 'source', label: pointName(points, route.source_point_id),
      marker: <>{route.source_point_id ?? 'А'}</>, end: false,
    });
  }
  return <div className="route-map">
    <div className="route-map__grid" aria-hidden="true"/>
    <div className="route-map__top"><span className="route-map__label"><GitFork size={16}/> Маршрут доставки</span>{sample && <span className="route-map__badge">Пример</span>}</div>
    <div className="route-map__body">
      <strong className="route-map__title">{type ? routeNames[type] : 'Маршрут появится после оформления'}</strong>
      <div className={'route-map__track' + (type === 'hub' ? ' route-map__track--hub' : '')} role="list" aria-label="Точки маршрута">
        {stops.map((stop, index) => <Fragment key={stop.id}>
          {index > 0 && <span className="route-map__line" aria-hidden="true"><ArrowRight size={15}/></span>}
          <span className="route-map__node" role="listitem">
            <span className={'route-map__pin' + (stop.end ? ' route-map__pin--end' : '')} aria-hidden="true">{stop.marker}</span>
            {stop.label}
          </span>
        </Fragment>)}
      </div>
    </div>
  </div>;
}
export function OrderSummary({ order, points, link }: { order: Order; points: Point[]; link?: boolean }) {
  return <div className="order-summary">
    <div className="order-summary__heading"><PackageCheck size={20}/><strong>Заказ {order.id}</strong><Status value={order.status}/></div>
    <div className="order-summary__line"><MapPin size={17}/>{pointName(points, order.pickup_point_id)}</div>
    <div className="order-summary__line"><Clock3 size={17}/>{dateTime(order.route?.ready_at)} {order.route?.ready_at && 'МСК'}</div>
    {order.route_failure && <p className="order-summary__line">{order.route_failure}</p>}
    {link && <a className="button button--secondary" href={'#/orders/' + encodeURIComponent(order.id)}>Открыть заказ <ArrowRight size={16}/></a>}
  </div>;
}
export function Dialog({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const trigger = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);
  return <dialog ref={ref} className="dialog" aria-labelledby="dialog-title" onCancel={event => { event.preventDefault(); close(); }}>
    <div className="dialog__heading"><h2 id="dialog-title">{title}</h2><button className="button button--icon" type="button" aria-label="Закрыть" onClick={close}><X size={22}/></button></div>
    {children}
  </dialog>;
}
export function Back({ to, children }: { to: string; children: ReactNode }) {
  return <a className="button button--secondary" href={to}><ArrowLeft size={17}/>{children}</a>;
}
