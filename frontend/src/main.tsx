import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BarChart3, Boxes, ClipboardList, GitFork, MapPin, RefreshCw, ShoppingBag, Store } from 'lucide-react';
import { api } from './api';
import type { Point, Product } from './api';
import { Checkout } from './checkout';
import { demoPoints, demoProducts } from './demo';
import { OrderDetail, Orders } from './orders';
import { Pvz } from './pvz';
import { Jury, Seller } from './reports';
import { Empty, ErrorMessage } from './ui';
import type { Mode } from './ui';
import './styles.css';

const nav = [
  { path: '/', caption: 'Оформление', icon: ShoppingBag },
  { path: '/orders', caption: 'Заказы', icon: ClipboardList },
  { path: '/pvz', caption: 'ПВЗ', icon: MapPin },
  { path: '/seller', caption: 'Продавец', icon: Store },
  { path: '/jury', caption: 'Для жюри', icon: BarChart3 },
];
const readPath = () => location.hash.startsWith('#/') ? location.hash.slice(1) : '/';
function App() {
  const [path, setPath] = useState(readPath);
  const [mode, setMode] = useState<Mode>('checking');
  const [revision, setRevision] = useState(0);
  const [catalog, setCatalog] = useState<[Point[], Product[]]>([[], []]);
  const [catalogError, setCatalogError] = useState<unknown>();
  const [pathname, query = ''] = path.split('?');
  const params = new URLSearchParams(query);
  const orderId = pathname.startsWith('/orders/') ? decodeOrderId(pathname.slice(8)) : '';
  useEffect(() => {
    function navigate() {
      if (!location.hash.startsWith('#/')) return;
      setPath(readPath()); window.scrollTo(0, 0);
    }
    window.addEventListener('hashchange', navigate);
    return () => window.removeEventListener('hashchange', navigate);
  }, []);
  async function connect() {
    setMode('checking');
    setCatalog([[], []]);
    setCatalogError(undefined);
    try {
      const health = await api.health();
      setMode(health.status === 'ok' ? 'live' : 'demo');
    } catch { setMode('demo'); }
  }
  useEffect(() => { void connect(); }, []);
  useEffect(() => {
    if (mode !== 'live') return;
    let current = true;
    Promise.all([api.points(), api.products()]).then(data => {
      if (current) { setCatalog(data); setCatalogError(undefined); }
    }, error => { if (current) setCatalogError(error); });
    return () => { current = false; };
  }, [mode, revision]);
  const [points, products] = mode === 'demo' ? [demoPoints, demoProducts] : catalog;
  const reload = () => setRevision(value => value + 1);
  const active = orderId ? '/orders' : pathname;
  let page;
  if (pathname === '/pvz') page = <Pvz key={path + mode} mode={mode} points={points} initialPoint={params.get('point') ?? ''} reload={reload}/>;
  else if (pathname === '/seller') page = <Seller key={mode} mode={mode} points={points}/>;
  else if (pathname === '/jury') page = <Jury key={path + mode} mode={mode} points={points} initialOrder={params.get('order') ?? ''}/>;
  else if (orderId) page = <OrderDetail key={path + mode} mode={mode} points={points} id={orderId} point={params.get('point') ?? ''}/>;
  else if (pathname === '/orders') page = <Orders mode={mode} points={points}/>;
  else if (pathname === '/') page = <Checkout key={mode} mode={mode} points={points} products={products}/>;
  else page = <div className="card"><h1>Страница не найдена</h1><a className="button button--primary" href="#/">К оформлению</a></div>;

  return <>
    <a className="skip-link" href="#content" onClick={event => {
      event.preventDefault();
      document.getElementById('content')?.focus();
    }}>К содержанию</a>
    <header><div className="masthead"><div className="shell masthead__inner">
      <a className="masthead__brand" href="#/"><span className="masthead__mark"><GitFork size={24} strokeWidth={2.3}/></span><span>Wildberries <small>Mesh</small></span></a>
      <div className="masthead__context"><Boxes size={17}/><span>Доставка между ПВЗ</span></div>
      <button className="connection" title="Проверить подключение FastAPI" aria-label="Проверить подключение FastAPI" onClick={connect} disabled={mode === 'checking'}>
        <span className={'connection__dot connection__dot--' + mode}/><span>{mode === 'live' ? 'API подключён' : mode === 'demo' ? 'Демо-режим' : 'Проверяем API'}</span><RefreshCw size={14}/>
      </button>
    </div></div>
    <div className="navigation"><nav className="shell navigation__inner" aria-label="Разделы проекта">{nav.map(({ path, caption, icon: Icon }) =>
      <a className="navigation__link" href={'#' + path} aria-current={active === path ? 'page' : undefined} key={path}><Icon size={18}/>{caption}</a>)}</nav></div>
    </header>
    <main className="workspace" id="content" tabIndex={-1}><section className="workspace__page"><div className="shell wrap">
      <ErrorMessage error={catalogError}/>
      {mode === 'checking' ? <Empty>Проверяем подключение к серверу…</Empty> : page}
    </div></section></main>
  </>;
}
function decodeOrderId(encoded: string) {
  try { return decodeURIComponent(encoded); } catch { return ''; }
}
createRoot(document.getElementById('root')!).render(<App/>);
