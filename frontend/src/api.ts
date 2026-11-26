export type Point = { id: string; name: string; capacity_cm3: number; usable_capacity_cm3: number; occupied_volume_cm3: number; free_volume_cm3: number };
export type Product = { sku: string; seller_id: string; unit_volume_cm3: number };
export type Stock = Product & {
  batch_id: string; point_id: string; delivered_at: string; storage_days: number; slow_stock: boolean;
  available: number; reserved: number; in_transit: number; ready: number; blocked: number; damaged: number;
};
export type RouteType = 'shelf' | 'direct' | 'hub';
export type Option = { route_type: RouteType; source_point_id: string | null; ready_at: string | null; estimated_unit_cost_kopecks: number };
export type Evaluation = {
  route_type: RouteType; source_id: string | null; trip_id: string | null; status: string; reason_code: string; reason: string;
  quote: { cost_kopecks: number; ready_at: string } | null;
};
export type Route = Option & {
  pickup_point_id: string; reason: string; reason_code: string | null; trip_id: string | null; hub_source_id: string | null;
  alternatives: Option[]; evaluations: Evaluation[];
  milestones: { stage: string; starts_at: string; ends_at: string; pvz_id: string | null; window_id: string | null }[];
};
export type CheckoutDraft = {
  sku: string; quantity: number; wb_club: boolean; pickup_point_id: string; promised_by: string;
};
export type CheckoutOptions = {
  delivery: Route | null; delivery_failure: string | null; shelf_today: Route[]; shelf_date: string;
};
export type ActionType = 'pack' | 'handoff' | 'receive' | 'confirm_hub_delivery' | 'issue' | 'cancel' | 'shortage' | 'replan' | 'update_transit' | 'return_good' | 'return_damaged';
export type NextAction = { type: ActionType; point_id: string };
export type Operation = { event_id: string; type: string; point_id: string; occurred_at: string; quantity: number; order_id: string | null; batch_id: string | null; details: Record<string, unknown> };
export type Accrual = { event_id: string; point_id: string; amount_kopecks: number; reason: string; quantity: number; unit_rate_kopecks: number };
export type Ledger = { items: Accrual[]; total_kopecks: number };
export type PointMargin = { revenue_kopecks: number; costs_kopecks: number; profit_kopecks: number };
export type SellerMargin = {
  order_id: string; sku: string; status: string; point_id: string; revenue_kopecks: number;
  goods_kopecks: number; commission_kopecks: number; logistics_kopecks: number; storage_kopecks: number;
  return_kopecks: number; profit_kopecks: number; buyer_acceleration_fee_kopecks: number;
};
export type Comparison = {
  trip_orders: number; direct_kopecks: number; shelf_kopecks: number; hub_kopecks: number;
  direct_storage_extra_kopecks: number; expected_return_kopecks: number; selected_route: 'direct' | 'hub';
  cohort_orders: number; baseline_kopecks: number; mesh_kopecks: number; savings_kopecks: number;
  savings_percent: number; distribution: Record<RouteType, number>;
};
export type Order = {
  id: string; scan_code: string; sku: string; quantity: number; wb_club: boolean;
  pickup_point_id: string; source_point_id: string | null; actual_position: string | null;
  promised_by: string; created_at: string; status: string; route: Route | null; route_failure: string | null;
  next_actions: NextAction[]; allocations: { batch_id: string; quantity: number }[];
  operations: Operation[]; accruals: Accrual[]; accrual_total_kopecks: number;
  buyer_acceleration_fee_kopecks?: number;
};
type Payload = Record<string, string | number | boolean | null>;
export class ApiError extends Error {
  constructor(message: string, readonly code?: string, readonly reason?: string, readonly retryable = false) { super(message); }
}
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch('/api' + path, { signal: AbortSignal.timeout(12000), ...init });
  } catch {
    throw new ApiError('Сервер недоступен. Повторите запрос после восстановления связи.', undefined, undefined, true);
  }
  const data = await response.json().catch(() => null);
  if (!response.ok || data === null) {
    const detail = data?.detail;
    if (Array.isArray(detail)) {
      const fields = detail.map(item => item.loc?.at(-1)).filter(Boolean);
      throw new ApiError('Проверьте поля запроса' + (fields.length ? ' — ' + fields.join(', ') : '.'));
    }
    const fallback = response.status >= 500 || data === null
      ? 'Сервер не ответил. Проверьте, запущен ли FastAPI.'
      : 'Запрос отклонён (' + response.status + ').';
    throw new ApiError(detail?.message ?? fallback, detail?.code, detail?.reason_code, response.status >= 500 || data === null);
  }
  return data as T;
}

const pending = new Map<string, string>();
export async function post<T>(path: string, payload: Payload): Promise<T> {
  const key = path + JSON.stringify(payload, Object.keys(payload).sort());
  const requestId = pending.get(key) ?? crypto.randomUUID();
  pending.set(key, requestId);
  try {
    const result = await request<T>(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, request_id: requestId }),
    });
    pending.delete(key);
    return result;
  } catch (error) {
    if (error instanceof ApiError && !error.retryable) pending.delete(key);
    throw error;
  }
}
const encode = encodeURIComponent;
const query = (path: string, params: Record<string, string>) => path + '?' + new URLSearchParams(params);
export const api = {
  health: () => request<{status: string}>('/health', { signal: AbortSignal.timeout(1800) }),
  points: () => request<Point[]>('/points'),
  products: () => request<Product[]>('/products'),
  orders: (point?: string, actionable = false) => request<Order[]>(query('/orders', { ...(point ? { point_id: point } : {}), actionable: String(actionable) })),
  order: (id: string) => request<Order>('/orders/' + encode(id)),
  inventory: (filter: Record<string, string> = {}) => request<Stock[]>(query('/inventory', filter)),
  operations: (filter: Record<string, string>) => request<Operation[]>(query('/operations', filter)),
  accruals: (filter: Record<string, string>) => request<Ledger>(query('/accruals', filter)),
  pointMargin: (point: string, order: string) => request<PointMargin>(
    query('/analytics/points/' + encode(point), order ? { order_id: order } : {}),
  ),
  sellerMargin: (seller: string, point: string) => request<SellerMargin[]>(
    query('/analytics/sellers/' + encode(seller), point ? { point_id: point } : {}),
  ),
  comparison: (load: number, days: string, returns: string) => request<Comparison>(query('/analytics/comparison', {
    trip_orders: String(load), ...(days ? { storage_days: days } : {}),
    ...(returns ? { return_bps: String(Math.round(Number(returns) * 100)) } : {}),
  })),
  create: (body: Payload) => post<Order>('/orders', body),
  checkoutOptions: (body: CheckoutDraft) => request<CheckoutOptions>('/orders/options', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }),
  orderAction: (id: string, body: Payload) => post<Order>('/orders/' + encode(id) + '/actions', body),
  receipt: (body: Payload) => post('/batches', body),
  stockAction: (point: string, batch: string, storage: boolean, body: Payload) => post('/inventory/' + encode(point) + '/' + encode(batch) + (storage ? '/storage' : '/actions'), body),
  putPoint: (id: string, body: Payload) => request<Point>('/points/' + encode(id), {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }),
};
