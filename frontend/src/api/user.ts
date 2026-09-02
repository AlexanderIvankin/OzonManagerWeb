import api from ".";

export const userApi = {
  // Получить активный заработок
  getActiveEarnings: () =>
    api.get("/user/earnings/active").then((res) => res.data),

  // Получить заработок за месяц
  getMonthlyEarnings: (month?: string) =>
    api
      .get("/user/earnings/monthly", { params: { month } })
      .then((res) => res.data),

  // Переключить приём заказов
  toggleTakingOrders: () =>
    api.post("/user/toggle-orders").then((res) => res.data),
};
