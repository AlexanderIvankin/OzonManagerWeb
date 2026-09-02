import { useSelector, useDispatch } from "react-redux";
import { RootState, AppDispatch } from "../../store";
import { logout } from "../../store/authSlice";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const Profile = () => {
  const user = useSelector((state: RootState) => state.auth.user);
  const dispatch = useDispatch<AppDispatch>();

  const handleLogout = async () => {
    await dispatch(logout());
    window.location.href = "/login";
  };

  if (!user) {
    return <div className="text-center py-10">Загрузка...</div>;
  }

  const isEmployee = ["employee", "moderator", "admin"].includes(user.role);
  const isAdminOrModerator = ["moderator", "admin"].includes(user.role);

  return (
    <div className="container mx-auto py-10">
      <Card className="max-w-2xl mx-auto">
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>Добро пожаловать, {user.name}!</span>
            <Badge variant={isEmployee ? "default" : "secondary"}>
              {user.role === "admin" && "🧑‍💻 Администратор"}
              {user.role === "moderator" && "🕵️ Модератор"}
              {user.role === "employee" && "👷 Сотрудник"}
              {user.role === "user" && "👤 Пользователь"}
            </Badge>
          </CardTitle>
          <CardDescription>Управление заказами и заработком</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-sm text-muted-foreground">Логин</p>
              <p className="font-medium">{user.username}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Email</p>
              <p className="font-medium">{user.email}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Телефон</p>
              <p className="font-medium">{user.phone || "—"}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Принтеров</p>
              <p className="font-medium">{user.capacity || "1"}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">
                Коэффициент заработка
              </p>
              <p className="font-medium">{user.earnings_factor || "1.0"}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Telegram ID</p>
              <p className="font-medium">{user.tg_user_id || "—"}</p>
            </div>
          </div>
          <div className="border-t pt-4">
            <p className="text-sm text-muted-foreground">Статус:</p>
            <Badge variant={user.is_fired ? "destructive" : "outline"}>
              {user.is_fired ? "Уволен" : "Активен"}
            </Badge>
            {user.taking_orders && (
              <Badge variant="default" className="ml-2">
                Принимает заказы
              </Badge>
            )}
          </div>

          {user.role === "user" && (
            <div className="border-t pt-4 text-amber-600 bg-amber-50 p-3 rounded-md">
              ⚠️ Ваш аккаунт ещё не подтверждён сотрудником. Обратитесь к
              администратору или модератору для активации доступа к заказам.
            </div>
          )}

          {isEmployee && (
            <>
              {user.stats && (
                <div className="border-t pt-4">
                  <p className="text-sm text-muted-foreground">Статистика:</p>
                  <div className="grid grid-cols-3 gap-4 mt-2">
                    <div>
                      <p className="text-sm text-muted-foreground">
                        Завершённых заказов
                      </p>
                      <p className="font-medium">{user.stats.total_orders}</p>
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">
                        Отменённых
                      </p>
                      <p className="font-medium">
                        {user.stats.canceled_orders}
                      </p>
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">
                        Общая сумма
                      </p>
                      <p className="font-medium">
                        {user.stats.total_amount.toFixed(2)} руб.
                      </p>
                    </div>
                  </div>
                </div>
              )}
              {user.activeOrders && user.activeOrders.length > 0 && (
                <div className="border-t pt-4">
                  <p className="text-sm text-muted-foreground">
                    Активные заказы:
                  </p>
                  <ul className="text-sm space-y-1 mt-2">
                    {user.activeOrders.map((order) => (
                      <li key={order.order_id}>
                        Заказ {order.order_id} (с{" "}
                        {new Date(order.assigned_at).toLocaleDateString()})
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}

          <Button
            onClick={handleLogout}
            variant="destructive"
            className="w-full mt-4"
          >
            Выйти
          </Button>
        </CardContent>
      </Card>
    </div>
  );
};
