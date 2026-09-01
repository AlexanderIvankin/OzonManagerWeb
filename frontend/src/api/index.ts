import axios from "axios";
import { store } from "../store";
import { updateUser, logout } from "../store/authSlice";

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || "http://localhost:5000/api",
  headers: { "Content-Type": "application/json" },
  withCredentials: true,
});

// Добавляем токен в заголовки
api.interceptors.request.use((config) => {
  const token = localStorage.getItem("accessToken");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Обработка 401 – рефреш токена
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;
      try {
        const refreshToken = localStorage.getItem("refreshToken");
        if (!refreshToken) throw new Error("No refresh token");
        const { data } = await axios.post(
          `${import.meta.env.VITE_API_URL || "http://localhost:5000/api"}/auth/refresh`,
          { refreshToken },
        );
        localStorage.setItem("accessToken", data.accessToken);
        originalRequest.headers.Authorization = `Bearer ${data.accessToken}`;

        // Обновляем пользователя в store
        const userResponse = await axios.get(
          `${import.meta.env.VITE_API_URL || "http://localhost:5000/api"}/auth/me`,
          {
            headers: { Authorization: `Bearer ${data.accessToken}` },
          },
        );
        store.dispatch(updateUser(userResponse.data));

        return api(originalRequest);
      } catch (refreshError) {
        // Если рефреш не удался – логин заново
        localStorage.removeItem("accessToken");
        localStorage.removeItem("refreshToken");
        store.dispatch(logout());
        window.location.href = "/login";
        return Promise.reject(refreshError);
      }
    }
    return Promise.reject(error);
  },
);

export default api;
