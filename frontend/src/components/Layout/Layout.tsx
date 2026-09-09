import { useEffect, useState } from "react";
import { Outlet, Link, useNavigate } from "react-router-dom";
import { useSelector, useDispatch } from "react-redux";
import { RootState } from "../../store";
import { logout } from "../../store/authSlice";
import { AppDispatch } from "../../store";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Toaster, toast } from "sonner";
import { notificationsApi } from "../../api/notifications";
import {
  getStoredTheme,
  toggleTheme,
  Theme,
} from "../../lib/theme";
import {
  disconnectSocket,
  onNotificationNew,
  onNotificationsChanged,
} from "../../lib/socket";

export const Layout = () => {
  const user = useSelector((state: RootState) => state.auth.user);
  const dispatch = useDispatch<AppDispatch>();
  const navigate = useNavigate();

  // Непрочитанные личные оповещения для бейджа в сайдбаре
  const [unreadCount, setUnreadCount] = useState(0);

  // Тема: значение уже применено к <html> (inline-скрипт в index.html)
  const [theme, setTheme] = useState<Theme>(
    () => getStoredTheme() ?? "light",
  );

  const handleToggleTheme = () => {
    setTheme(toggleTheme(theme));
  };

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const data = await notificationsApi.unreadCount("mine");
        if (!cancelled) setUnreadCount(data.count);
      } catch {
        // счётчик некритичен
      }
    };
    load();

    // Живое обновление бейджа: новое оповещение или изменение (прочитано/удалено)
    const offNew = onNotificationNew((n) => {
      // Live-тост о новом оповещении ГЛОБАЛЬНО (на любой странице,
      // не только во вкладке «Оповещения»). События журнала персонала
      // сервер шлёт только модераторам, но дополнительно проверяем роль.
      const isStaff = ["moderator", "admin", "god"].includes(
        user?.role || "",
      );
      if (n.audience === "staff" && !isStaff) return;
      toast(n.title, { description: n.message || undefined });

      load();
    });
    const offChanged = onNotificationsChanged(load);

    return () => {
      cancelled = true;
      offNew();
      offChanged();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.role]);

  const handleLogout = async () => {
    disconnectSocket();
    await dispatch(logout());
    navigate("/login");
  };

  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <aside className="w-64 border-r bg-card p-4 flex flex-col">
        <div className="mb-20 flex flex-col text-center">
          <h1 className="text-xl font-bold">Ozon Manager</h1>
          <p className="text-sm text-muted-foreground mb-[5px]">{user?.name}</p>
          <p className="text-xs text-muted-foreground">
            Роль: <span className="font-bold">{user?.role}</span>
          </p>
        </div>
        <nav className="flex-1 space-y-1">
          <Link
            to="/profile"
            className="block px-3 py-2 rounded-md hover:bg-accent"
          >
            <span className="inline-block align-middle -translate-y-[3px]">
              🪪
            </span>{" "}
            Профиль
          </Link>
          {["employee", "moderator", "admin", "god"].includes(
            user?.role || "",
          ) && (
            <Link
              to="/orders"
              className="block px-3 py-2 rounded-md hover:bg-accent"
            >
              📦 Заказы
            </Link>
          )}
          <Link
            to="/notifications"
            className="flex items-center justify-between px-3 py-2 rounded-md hover:bg-accent"
          >
            <span>🔔 Оповещения</span>
            {unreadCount > 0 && (
              <Badge className="ml-2">
                {unreadCount > 99 ? "99+" : unreadCount}
              </Badge>
            )}
          </Link>
          {/* Модератор = Администратор: все разделы админки доступны
              также модератору и Создателю */}
          {["moderator", "admin", "god"].includes(user?.role || "") && (
            <Link
              to="/admin"
              className="block px-3 py-2 rounded-md hover:bg-accent"
            >
              ⚙️ Админка
            </Link>
          )}
          {["moderator", "admin", "god"].includes(user?.role || "") && (
            <>
              <Link
                to="/admin/users"
                className="block px-3 py-2 rounded-md hover:bg-accent"
              >
                <span className="inline-block align-middle -translate-y-[2px]">
                  👥
                </span>{" "}
                Пользователи
              </Link>
              <Link
                to="/admin/warehouses"
                className="block px-3 py-2 rounded-md hover:bg-accent"
              >
                🏭 Склады
              </Link>
              <Link
                to="/admin/orders"
                className="block px-3 py-2 rounded-md hover:bg-accent"
              >
                📦 Очередь заказов
              </Link>
              <Link
                to="/admin/active-orders"
                className="block px-3 py-2 rounded-md hover:bg-accent"
              >
                📋 Активные заказы
              </Link>
              <Link
                to="/admin/materials"
                className="block px-3 py-2 rounded-md hover:bg-accent"
              >
                📁 Материалы
              </Link>
              <Link
                to="/admin/export"
                className="block px-3 py-2 rounded-md hover:bg-accent"
              >
                📤 Экспорт данных
              </Link>
              <Link
                to="/admin/earnings"
                className="block px-3 py-2 rounded-md hover:bg-accent"
              >
                💰 Заработок
              </Link>
              <Link
                to="/admin/stats"
                className="block px-3 py-2 rounded-md hover:bg-accent"
              >
                📊 Статистика
              </Link>
            </>
          )}
        </nav>
        <div className="border-t pt-4 space-y-2">
          <Button
            variant="outline"
            className="w-full"
            onClick={handleToggleTheme}
            title="Переключить тему"
          >
            {theme === "dark" ? "☀️ Светлая тема" : "🌙 Тёмная тема"}
          </Button>
          <Button
            variant="destructive"
            className="w-full"
            onClick={handleLogout}
          >
            Выйти
          </Button>
        </div>
      </aside>

      {/* Main content – здесь рендерятся вложенные маршруты */}
      <main className="flex-1 overflow-auto p-6">
        <Outlet />
      </main>

      {/* Toaster для уведомлений (стиль подстраивается под тему) */}
      <Toaster position="top-right" theme={theme} />
    </div>
  );
};
