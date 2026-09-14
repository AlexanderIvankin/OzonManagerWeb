import api from ".";

export interface ProductModel {
  /** Артикул, по которому лежит zip (может отличаться: родитель -NR/-NL) */
  offerId: string;
  fileName: string;
  fileSize: number | null;
}

export interface Order {
  orderId: string;
  assignedAt: number;
  statsStatus: "filled" | "missing";
  missingStats: string[];
  products: OrderProduct[];
  // images убраны с верхнего уровня — фото теперь привязаны к каждому товару (products[].images)
}

export interface OrderProduct {
  name: string;
  quantity: number;
  offer_id?: string;
  sku?: string;
  price?: number;
  images?: Array<{ url: string; name: string }>;
  // 3D-модель (zip в S3) — если есть, клиент показывает кнопку «Скачать модель»
  model?: ProductModel | null;
}

export interface FinishOrderResponse {
  message: string;
  earnings: number;
  label: "available" | "not available";
}

export interface ModelDownloadGrant {
  token: string;
  expiresAt: number;
  offerId: string;
  fileName: string;
  fileSize: number | null;
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

  // Скачать этикетку, отправленную администратором (оповещение label_sent)
  getSentLabel: (orderId: string) =>
    api
      .get(`/user/labels/${encodeURIComponent(orderId)}/sent`, {
        responseType: "blob",
      })
      .then((res) => res.data),

  // === 3D-модели (zip, без прямых ссылок на S3) ===
  // Шаг 1: запросить одноразовый токен скачивания (TTL ~15 минут)
  requestModelToken: (offerId: string) =>
    api
      .post<ModelDownloadGrant>(
        `/models/request/${encodeURIComponent(offerId)}`,
      )
      .then((res) => res.data),

  // Шаг 2: скачать zip по токену (токен гасится при первом обращении)
  downloadModelByToken: (token: string) =>
    api
      .get(`/models/download/${token}`, { responseType: "blob" })
      .then((res) => res.data),
};

