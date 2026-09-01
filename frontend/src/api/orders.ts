import api from ".";

export interface Order {
  orderId: string;
  assignedAt: number;
  statsStatus: "filled" | "missing";
  missingStats: string[];
  products: Array<{
    name: string;
    quantity: number;
    offer_id?: string;
    sku?: string;
    price?: number;
  }>;
}

export interface FinishOrderResponse {
  message: string;
  earnings: number;
  label: "available" | "not available";
}

export const ordersApi = {
  // Получить активные заказы текущего пользователя
  getActiveOrders: () =>
    api.get<Order[]>("/user/orders/active").then((res) => res.data),

  // Завершить заказ
  finishOrder: (orderId: string) =>
    api
      .post<FinishOrderResponse>(`/user/orders/${orderId}/finish`)
      .then((res) => res.data),

  // Отменить заказ
  cancelOrder: (orderId: string) =>
    api.post(`/user/orders/${orderId}/cancel`).then((res) => res.data),

  // Скачать этикетку (возвращает Blob)
  getLabel: (orderId: string) =>
    api
      .get(`/user/orders/${orderId}/label`, { responseType: "blob" })
      .then((res) => res.data),

  // Скачать все этикетки
  getAllLabels: () =>
    api
      .get("/user/orders/labels/all", { responseType: "blob" })
      .then((res) => res.data),
};
