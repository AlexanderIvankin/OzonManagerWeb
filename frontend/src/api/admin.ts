import api from ".";
import type { AxiosResponse } from "axios";

export interface User {
  id: number;
  username: string;
  email: string;
  name: string;
  phone: string;
  capacity: number;
  earnings_factor: number;
  role: "guest" | "user" | "employee" | "moderator" | "admin" | "god";
  is_fired: boolean;
  taking_orders: boolean;
  tg_user_id: string | null;
  created_at: number;
  updated_at: number;
  stats?: {
    total_orders: number;
    total_amount: number;
    canceled_orders: number;
  };
  activeOrders?: Array<{ order_id: string; assigned_at: number }>;
  warehouses?: Array<{
    warehouse_id: string;
    name: string;
    address: string;
    is_rfbs: boolean;
  }>;
  // Заполняется только при withWarehouses=true в getUsers
  active_count?: number;
}

export interface Warehouse {
  warehouse_id: string;
  name: string;
  address: string | null;
  is_rfbs: boolean;
}

export interface AdminActiveOrder {
  orderId: string;
  userId: number;
  userName: string;
  assignedAt: number;
  warehouseName?: string | null;
  warehouseId?: string | null;
  statsStatus: "filled" | "missing";
  missingStats: string[];
  products: Array<{
    name: string;
    quantity: number;
    offer_id?: string;
    sku?: string;
    images?: Array<{ url: string; name: string }>;
  }>;
}

export const adminApi = {
  // === Пользователи ===
  getUsers: (params?: {
    includeFired?: boolean;
    includeAll?: boolean;
    role?: string;
    // Добавить к каждому пользователю склады (приоритеты) и active_count
    withWarehouses?: boolean;
  }) => api.get<User[]>("/admin/users", { params }).then((res) => res.data),

  getUserById: (id: number) =>
    api.get<User>(`/admin/users/${id}`).then((res) => res.data),

  updateUser: (id: number, data: Partial<User>) =>
    api.put<User>(`/admin/users/${id}`, data).then((res) => res.data),

  deleteUser: (id: number) =>
    api.delete(`/admin/users/${id}`).then((res) => res.data),

  // === Склады ===
  getWarehouses: () =>
    api.get<Warehouse[]>("/admin/warehouses").then((res) => res.data),

  syncWarehouses: () =>
    api.post("/admin/warehouses/sync").then((res) => res.data),

  // === Заказы (админ) ===
  getAwaitingOrders: (warehouseId?: string) =>
    api
      .get("/admin/orders/awaiting", { params: { warehouseId } })
      .then((res) => res.data),

  getActiveOrders: () =>
    api.get<AdminActiveOrder[]>("/admin/orders/active").then((res) => res.data),

  getOrderDetails: (orderId: string) =>
    api.get(`/admin/orders/${orderId}/details`).then((res) => res.data),

  assignOrder: (orderId: string, userId: number) =>
    api
      .post(`/admin/orders/${orderId}/assign`, { userId })
      .then((res) => res.data),

  unassignOrder: (orderId: string) =>
    api.post(`/admin/orders/${orderId}/unassign`).then((res) => res.data),

  // === Заработок ===
  // Blob-методы возвращают полный ответ axios, чтобы страница могла
  // взять версионированное имя файла из Content-Disposition.
  exportMonthlyEarnings: (month: string): Promise<AxiosResponse<Blob>> =>
    api.get("/admin/earnings/monthly", {
      params: { month },
      responseType: "blob",
    }),

  getActiveEarningsAll: () =>
    api.get("/admin/earnings/active").then((res) => res.data),

  addEarningsAdjustment: (userId: number, amount: number, reason?: string) =>
    api
      .post("/admin/earnings/adjust", { userId, amount, reason })
      .then((res) => res.data),

  settleEarnings: (userId: number) =>
    api.post(`/admin/earnings/settle/${userId}`).then((res) => res.data),

  resetAllEarnings: () =>
    api.post("/admin/earnings/reset").then((res) => res.data),

  // === Материалы ===
  getMaterials: () => api.get("/admin/materials").then((res) => res.data),

  uploadMaterials: (file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    return api
      .post("/admin/materials/upload", formData, {
        headers: { "Content-Type": "multipart/form-data" },
      })
      .then((res) => res.data);
  },

  // === Экспорт team-info ===
  exportTeamInfo: (includeFired = false): Promise<AxiosResponse<Blob>> =>
    api.get("/admin/export/team-info", {
      params: { includeFired },
      responseType: "blob",
    }),

  // === Экспорт статистики товаров (Excel) ===
  exportProductStats: (): Promise<AxiosResponse<Blob>> =>
    api.get("/admin/export/product-stats", { responseType: "blob" }),

  // === Скачивание файла базы данных (только админ) ===
  downloadDatabase: (): Promise<AxiosResponse<Blob>> =>
    api.get("/admin/export/database", { responseType: "blob" }),

  // === Создание бэкапа БД на сервере (только админ) ===
  createDbBackup: () => api.post("/admin/backup").then((res) => res.data),

  // === Скачивание текущих настроек materials-prices.json ===
  downloadMaterials: (): Promise<AxiosResponse<Blob>> =>
    api.get("/admin/materials/download", { responseType: "blob" }),
};

/**
 * Извлекает имя файла из заголовка Content-Disposition.
 * Сервер отдаёт версионированные имена (materials-prices-1.json,
 * bot_web-1.db, team-info-1.xlsx и т.п.). Поддерживаются RFC 5987
 * (filename*=UTF-8'') и обычный filename="...".
 */
export const getDownloadFileName = (
  res: AxiosResponse,
  fallback: string,
): string => {
  const contentDisposition =
    (res.headers?.["content-disposition"] as string) || "";
  const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1].replace(/"/g, "").trim());
    } catch {
      // некорректный URL-encoding — пробуем обычный filename
    }
  }
  const plainMatch = contentDisposition.match(/filename="?([^";]+)"?/i);
  if (plainMatch?.[1]) return plainMatch[1].trim();
  return fallback;
};

/**
 * Извлекает текст ошибки из Blob-ответа (при responseType: "blob"
 * серверные ошибки приходят как Blob в err.response.data).
 */
export const getBlobErrorMessage = async (err: any, fallback: string) => {
  if (err.response?.data instanceof Blob) {
    try {
      const text = await err.response.data.text();
      const parsed = JSON.parse(text);
      if (parsed?.error) return parsed.error;
    } catch {
      // не JSON — используем fallback
    }
  }
  return err.message || fallback;
};
