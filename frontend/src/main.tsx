import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Boxes, ClipboardList, GitFork, MapPin, RefreshCw, ShoppingBag, Store } from 'lucide-react';
import { api } from './api';
import type { Point, Product } from './api';
import { Checkout } from './checkout';
import { demoPoints, demoProducts } from './demo';
import { CustomerOrders, OrderDetail } from './orders';
import { Pvz } from './pvz';
import { Jury, Seller } from './reports';
import { Empty, ErrorMessage, useResource } from './ui';
import type { Mode } from './ui';
import './styles.css';

const sites = {
  customer: { label: 'Покупатель', nav: [
    { path: '/', caption: 'Оформление', icon: ShoppingBag },
    { path: '/orders', caption: 'Мои заказы', icon: ClipboardList },
  ] },
  pickup: { label: 'Рабочее место ПВЗ', nav: [
    { path: '/', caption: 'ПВЗ', icon: MapPin },
  ] },
  seller: { label: 'Кабинет продавца', nav: [
    { path: '/', caption: 'Продавец', icon: Store },
  ] },
};

const entry = document.documentElement.dataset.site;
const site = entry === 'pickup' || entry === 'seller' ? entry : 'customer';
const readPath = () => location.hash.startsWith('#/') ? location.hash.slice(1) : '/';

function movedPage(path: string) {
  if (site !== 'customer') return;
  const [pathname, query] = path.split('?');
  if (pathname === '/pvz') return '/pvz/#/' + (query ? '?' + query : '');
  if (pathname === '/seller') return '/seller/';
  if (pathname === '/jury') return '/pvz/#' + path;
}

function App() {
  const [path, setPath] = useState(readPath);
  const [mode, setMode] = useState<Mode>('checking');
  const [revision, setRevision] = useState(0);
  const [pathname, query = ''] = path.split('?');
  const params = new URLSearchParams(query);
  const orderId = pathname.startsWith('/orders/') ? decodeOrderId(pathname.slice(8)) : '';
  useEffect(() => {
    function navigate() {
      const currentPath = readPath();
      const moved = movedPage(currentPath);
      if (moved) { location.replace(moved); return; }
      setPath(currentPath);
      window.scrollTo(0, 0);
    }
    navigate();
    window.addEventListener('hashchange', navigate);
    return () => window.removeEventListener('hashchange', navigate);
  }, []);
  async function connect() {
    setMode('checking');
    try {
      const health = await api.health();
      setMode(health.status === 'ok' ? 'live' : 'demo');
    } catch { setMode('demo'); }
  }
  useEffect(() => { void connect(); }, []);
  const catalog = useResource<[Point[], Product[]]>(() => {
    if (mode === 'live') return Promise.all([api.points(), site === 'customer' ? api.products() : Promise.resolve([])]);
    return Promise.resolve(mode === 'demo' ? [demoPoints, demoProducts] : [[], []]);
  }, mode + ':' + revision, mode === 'live');
  const [points, products] = catalog.data ?? [[], []];
  const reload = () => setRevision(value => value + 1);
  const active = orderId ? (site === 'pickup' ? '/' : '/orders') : pathname;
  const isCheckout = site === 'customer' && pathname === '/';
  let page;
  if (site === 'pickup' && pathname === '/') page = <Pvz key={path + mode} mode={mode} points={points} initialPoint={params.get('point') ?? ''} reload={reload}/>;
  else if (site === 'seller' && pathname === '/') page = <Seller key={mode} mode={mode} points={points}/>;
  else if (site === 'pickup' && pathname === '/jury') page = <Jury key={path + mode} mode={mode} points={points} initialOrder={params.get('order') ?? ''}/>;
  else if (site !== 'seller' && orderId) page = <OrderDetail key={path + mode} mode={mode} points={points} id={orderId} point={params.get('point') ?? ''} canOperate={site === 'pickup'}/>;
  else if (site === 'customer' && pathname === '/orders') page = <CustomerOrders mode={mode} points={points}/>;
  else if (isCheckout) page = <Checkout key={mode} mode={mode} points={points} products={products}/>;
  else page = <div className="card"><h1>Страница не найдена</h1><a className="button button--primary" href="#/">На главную</a></div>;

  return <>
    <a className="skip-link" href="#content" onClick={event => {
      event.preventDefault();
      document.getElementById('content')?.focus();
    }}>К содержанию</a>
    <header className={isCheckout ? 'checkout-header' : undefined}><div className="masthead"><div className="shell masthead__inner">
      <a className="masthead__brand" href="#/"><span className="masthead__mark"><GitFork size={24} strokeWidth={2.3}/></span><span>Wildberries <small>Mesh</small></span></a>
      <div className="masthead__context"><Boxes size={17}/><span>{sites[site].label}</span></div>
      <button className="connection" title="Проверить подключение FastAPI" aria-label="Проверить подключение FastAPI" onClick={connect} disabled={mode === 'checking'}>
        <span className={'connection__dot connection__dot--' + mode}/><span>{mode === 'live' ? 'API подключён' : mode === 'demo' ? 'Демо-режим' : 'Проверяем API'}</span><RefreshCw size={14}/>
      </button>
    </div></div>
    <div className="navigation"><nav className="shell navigation__inner" aria-label="Разделы проекта">{sites[site].nav.map(({ path, caption, icon: Icon }) =>
      <a className="navigation__link" href={'#' + path} aria-current={active === path ? 'page' : undefined} key={path}><Icon size={18}/>{caption}</a>)}</nav></div>
    </header>
    <main className={isCheckout ? 'workspace checkout-workspace' : 'workspace'} id="content" tabIndex={-1}><section className="workspace__page"><div className="shell wrap">
      <ErrorMessage error={catalog.error}/>
      {mode === 'checking' ? <Empty>Проверяем подключение к серверу…</Empty> : page}
    </div></section></main>
  </>;
}
function decodeOrderId(encoded: string) {
  try { return decodeURIComponent(encoded); } catch { return ''; }
}
createRoot(document.getElementById('root')!).render(<App/>);
