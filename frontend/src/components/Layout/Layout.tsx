import { useEffect, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useSelector, useDispatch } from "react-redux";
import { RootState } from "../../store";
import { logout } from "../../store/authSlice";
import { AppDispatch } from "../../store";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Toaster, toast } from "sonner";
import { notificationsApi } from "../../api/notifications";
import { getStoredTheme, toggleTheme, Theme } from "../../lib/theme";
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
  const [theme, setTheme] = useState<Theme>(() => getStoredTheme() ?? "light");

  const handleToggleTheme = () => {
    setTheme(toggleTheme(theme));
  };

  // Общие классы пунктов сайдбара: активная вкладка подсвечивается,
  // чтобы было видно, где находишься (end — точное совпадение пути,
  // нужно для /admin, иначе он «активен» на всех разделах админки).
  const navClass =
    ({ isActive }: { isActive: boolean }) =>
      `flex items-center justify-center md:justify-start px-2 md:px-3 py-2 rounded-md transition-colors ${
        isActive ? "bg-primary/10 font-medium text-primary" : "hover:bg-accent"
      }`;

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
      const isStaff = ["moderator", "admin", "god"].includes(user?.role || "");
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
    <div className="flex h-dvh overflow-hidden">
      {/* Sidebar: на мобилке — узкая колонка со значками, с md — полный сайдбар */}
      <aside className="w-14 md:w-64 shrink-0 border-r bg-card p-2 md:p-4 flex flex-col">
        <div className="mb-6 md:mb-20 flex flex-col items-center md:items-stretch text-center">
          {/* На мобилке логотип = значок, подписи скрыты */}
          <span
            className="md:hidden size-9 grid place-items-center rounded-lg bg-primary/10 text-lg"
            title="Ozon Manager"
          >
            {user?.role === "god"
              ? "👻"
              : user?.role === "moderator"
                ? "🕵️"
                : user?.role === "admin"
                  ? "🧑‍💻"
                  : user?.role === "employee"
                    ? "👷"
                    : "👤"}
          </span>
          <h1 className="hidden md:block text-xl font-bold">Ozon Manager</h1>
          <p className="hidden md:block text-sm text-muted-foreground mb-[5px]">
            {user?.display_name}
          </p>
          <p className="hidden md:block text-xs text-muted-foreground">
            Роль:{" "}
            <span
              className={`font-bold ${user?.role === "god" ? "text-halloween-text" : user?.role === "admin" || user?.role === "moderator" ? "text-blue-600" : ""}`}
            >
              {user?.role}
            </span>
          </p>
        </div>
        <nav className="flex-1 space-y-1">
          <NavLink to="/profile" className={navClass}>
            <span className="inline-block align-middle -translate-y-[3px]">
              🪪
            </span>
            <span className="hidden md:inline md:ml-2">Профиль</span>
          </NavLink>
          {["employee", "moderator", "admin", "god"].includes(
            user?.role || "",
          ) && (
            <NavLink to="/orders" className={navClass}>
              📦
              <span className="hidden md:inline md:ml-2">Заказы</span>
            </NavLink>
          )}
          <NavLink
            to="/notifications"
            className={({ isActive }) =>
              `relative flex items-center justify-center md:justify-between px-2 md:px-3 py-2 rounded-md transition-colors ${
                isActive
                  ? "bg-primary/10 font-medium text-primary"
                  : "hover:bg-accent"
              }`
            }
          >
            <span className="flex items-center">
              🔔
              <span className="hidden md:inline md:ml-2">Оповещения</span>
            </span>
            {unreadCount > 0 && (
              <Badge className="absolute top-0 right-0 h-4 min-w-4 px-1 text-[10px] leading-none md:static md:h-auto md:min-w-0 md:px-2 md:py-0.5 md:text-xs md:ml-2">
                {unreadCount > 99 ? "99+" : unreadCount}
              </Badge>
            )}
          </NavLink>
          {/* Модератор = Администратор: все разделы админки доступны
              также и Создателю */}
          {["moderator", "admin", "god"].includes(user?.role || "") && (
            <NavLink to="/admin" end className={navClass}>
              ⚙️
              <span className="hidden md:inline md:ml-2">Админка</span>
            </NavLink>
          )}
          {["moderator", "admin", "god"].includes(user?.role || "") && (
            <>
              <NavLink to="/admin/users" className={navClass}>
                <span className="inline-block align-middle -translate-y-[2px]">
                  👥
                </span>
                <span className="hidden md:inline md:ml-2">Пользователи</span>
              </NavLink>
              <NavLink to="/admin/warehouses" className={navClass}>
                🏭
                <span className="hidden md:inline md:ml-2">Склады</span>
              </NavLink>
              <NavLink to="/admin/orders" className={navClass}>
                ⏳
                <span className="hidden md:inline md:ml-2">
                  Очередь заказов
                </span>
              </NavLink>
              <NavLink to="/admin/active-orders" className={navClass}>
                📋
                <span className="hidden md:inline md:ml-2">
                  Активные заказы
                </span>
              </NavLink>
              <NavLink to="/admin/completed-orders" className={navClass}>
                📜
                <span className="hidden md:inline md:ml-2">
                  Завершённые заказы
                </span>
              </NavLink>
              <NavLink to="/admin/materials" className={navClass}>
                📁
                <span className="hidden md:inline md:ml-2">Материалы</span>
              </NavLink>
              <NavLink to="/admin/models" className={navClass}>
                🧊
                <span className="hidden md:inline md:ml-2">Модели</span>
              </NavLink>
              <NavLink to="/admin/export" className={navClass}>
                📤
                <span className="hidden md:inline md:ml-2">Экспорт данных</span>
              </NavLink>
              <NavLink to="/admin/earnings" className={navClass}>
                🏦
                <span className="hidden md:inline md:ml-2">Заработок</span>
              </NavLink>
              <NavLink to="/admin/stats" className={navClass}>
                📊
                <span className="hidden md:inline md:ml-2">Статистика</span>
              </NavLink>
            </>
          )}
        </nav>
        <div className="border-t pt-2 md:pt-4 space-y-2">
          <Button
            variant="outline"
            className="w-full"
            onClick={handleToggleTheme}
            title="Переключить тему"
          >
            {theme === "dark" ? "☀️" : "🌙"}
            <span className="hidden md:inline">
              {theme === "dark" ? "Светлая тема" : "Тёмная тема"}
            </span>
          </Button>
          <Button
            variant="destructive"
            className="w-full"
            onClick={handleLogout}
            title="Выйти"
          >
            ➜]
            <span className="hidden md:inline">Выйти</span>
          </Button>
        </div>
      </aside>

      {/* Main content – здесь рендерятся вложенные маршруты */}
      <main className="flex-1 min-w-0 overflow-auto p-3 md:p-6">
        <Outlet />
      </main>

      {/* Toaster для уведомлений (стиль подстраивается под тему) */}
      <Toaster position="top-right" theme={theme} />
    </div>
  );
};
