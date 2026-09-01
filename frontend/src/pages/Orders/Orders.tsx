import { useEffect, useState } from "react";
import { useSelector } from "react-redux";
import { RootState } from "../../store";
import { ordersApi, Order } from "../../api/orders";
import { OrderCard } from "../../components/OrderCard";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

export const Orders = () => {
  const user = useSelector((state: RootState) => state.auth.user);
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadOrders();
  }, []);

  const loadOrders = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await ordersApi.getActiveOrders();
      setOrders(data);
    } catch (err: any) {
      setError(err.message || "Не удалось загрузить заказы");
    } finally {
      setLoading(false);
    }
  };

  const handleDownloadAllLabels = async () => {
    try {
      const blob = await ordersApi.getAllLabels();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "all_labels.pdf";
      a.click();
      window.URL.revokeObjectURL(url);
      toast.success("Все этикетки скачаны");
    } catch (err: any) {
      toast.error(err.message || "Не удалось скачать этикетки");
    }
  };

  const isAdminOrModerator = ["admin", "moderator"].includes(user?.role || "");

  return (
    <div className="container mx-auto py-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Мои заказы</h1>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleDownloadAllLabels}>
            📄 Скачать все этикетки
          </Button>
          <Button onClick={loadOrders} disabled={loading}>
            🔄 Обновить
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-10 text-muted-foreground">
          Загрузка заказов...
        </div>
      ) : error ? (
        <div className="text-center py-10 text-red-500">{error}</div>
      ) : orders.length === 0 ? (
        <div className="text-center py-10 text-muted-foreground">
          У вас нет активных заказов
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {orders.map((order) => (
            <OrderCard
              key={order.orderId}
              order={order}
              onOrderUpdated={loadOrders}
              showAdminActions={isAdminOrModerator}
            />
          ))}
        </div>
      )}
    </div>
  );
};
