import api from ".";

export interface User {
  id: number;
  username: string;
  email: string;
  name: string;
  phone: string;
  capacity: number;
  earnings_factor: number;
  role: "user" | "employee" | "moderator" | "admin";
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
  warehouses?: Array<{ warehouse_id: string; name: string; address: string }>;
}

export interface Warehouse {
  warehouse_id: string;
  name: string;
  address: string | null;
  is_rfbs: boolean;
}

export const adminApi = {
  // === Пользователи ===
  getUsers: (params?: {
    includeFired?: boolean;
    includeAll?: boolean;
    role?: string;
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

  getOrderDetails: (orderId: string) =>
    api.get(`/admin/orders/${orderId}/details`).then((res) => res.data),

  assignOrder: (orderId: string, userId: number) =>
    api
      .post(`/admin/orders/${orderId}/assign`, { userId })
      .then((res) => res.data),

  unassignOrder: (orderId: string) =>
    api.post(`/admin/orders/${orderId}/unassign`).then((res) => res.data),

  // === Заработок ===
  exportMonthlyEarnings: (month: string) =>
    api
      .get("/admin/earnings/monthly", {
        params: { month },
        responseType: "blob",
      })
      .then((res) => res.data),

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
  exportTeamInfo: (includeFired = false) =>
    api
      .get("/admin/export/team-info", {
        params: { includeFired },
        responseType: "blob",
      })
      .then((res) => res.data),
};
