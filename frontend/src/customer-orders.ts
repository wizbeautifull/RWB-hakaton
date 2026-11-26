const storageKey = 'wildberries-mesh.customer-orders';
let currentOrders: string[] = [];

export function customerOrderIds(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
    if (Array.isArray(saved)) {
      return [...new Set([...currentOrders, ...saved.filter((id): id is string => typeof id === 'string')])];
    }
  } catch {
    // Keep using the order list from this tab if browser storage is unavailable.
  }
  return currentOrders;
}

export function rememberCustomerOrder(id: string) {
  currentOrders = [id, ...customerOrderIds().filter(existing => existing !== id)];
  try {
    localStorage.setItem(storageKey, JSON.stringify(currentOrders));
  } catch {
    // The order is already saved on the server and its link remains available.
  }
}
