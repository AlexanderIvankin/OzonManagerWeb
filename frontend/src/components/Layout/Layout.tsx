import { Outlet, Link, useNavigate } from "react-router-dom";
import { useSelector, useDispatch } from "react-redux";
import { RootState } from "../../store";
import { logout } from "../../store/authSlice";
import { AppDispatch } from "../../store";
import { Button } from "@/components/ui/button";

export const Layout = () => {
  const user = useSelector((state: RootState) => state.auth.user);
  const dispatch = useDispatch<AppDispatch>();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await dispatch(logout());
    navigate("/login");
  };

  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <aside className="w-64 border-r bg-card p-4 flex flex-col">
        <div className="mb-8">
          <h1 className="text-xl font-bold">Ozon Manager</h1>
          <p className="text-sm text-muted-foreground">{user?.name}</p>
          <p className="text-xs text-muted-foreground">Роль: {user?.role}</p>
        </div>
        <nav className="flex-1 space-y-1">
          <Link
            to="/dashboard"
            className="block px-3 py-2 rounded-md hover:bg-accent"
          >
            📊 Дашборд
          </Link>
          {["employee", "moderator", "admin"].includes(user?.role || "") && (
            <Link
              to="/orders"
              className="block px-3 py-2 rounded-md hover:bg-accent"
            >
              📦 Заказы
            </Link>
          )}
          {["moderator", "admin"].includes(user?.role || "") && (
            <Link
              to="/admin"
              className="block px-3 py-2 rounded-md hover:bg-accent"
            >
              ⚙️ Админка
            </Link>
          )}
          {user?.role === "admin" && (
            <Link
              to="/admin/users"
              className="block px-3 py-2 rounded-md hover:bg-accent"
            >
              👥 Пользователи
            </Link>
          )}
        </nav>
        <div className="border-t pt-4">
          <Button variant="outline" className="w-full" onClick={handleLogout}>
            Выйти
          </Button>
        </div>
      </aside>

      {/* Main content – здесь рендерятся вложенные маршруты */}
      <main className="flex-1 overflow-auto p-6">
        <Outlet />
      </main>
    </div>
  );
};
