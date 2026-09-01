import { useEffect, useState } from "react";
import { adminApi } from "../../api/admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";

interface AwaitingOrder {
  posting_number: string;
  products: Array<{
    name: string;
    quantity: number;
    offer_id?: string;
    sku?: string;
  }>;
  warehouse_id?: string;
  analytics_data?: { warehouse?: string };
}

export const OrdersManagement = () => {
  const [orders, setOrders] = useState<AwaitingOrder[]>([]);
  const [employees, setEmployees] = useState<
    Array<{ id: number; name: string }>
  >([]);
  const [loading, setLoading] = useState(true);
  const [assigning, setAssigning] = useState<{ [key: string]: boolean }>({});
  const [selectedEmployee, setSelectedEmployee] = useState<{
    [key: string]: string | null;
  }>({});

  const loadOrders = async () => {
    setLoading(true);
    try {
      const data = await adminApi.getAwaitingOrders();
      setOrders(data);
    } catch (err: any) {
      toast.error(err.message || "Не удалось загрузить заказы");
    } finally {
      setLoading(false);
    }
  };

  const loadEmployees = async () => {
    try {
      // Получаем активных сотрудников (всех, кто не уволен и принимает заказы)
      const users = await adminApi.getUsers({
        includeAll: true,
        includeFired: false,
      });
      const emp = users
        .filter((u) => u.role !== "user" && u.taking_orders)
        .map((u) => ({ id: u.id, name: u.name }));
      setEmployees(emp);
    } catch (err: any) {
      toast.error("Не удалось загрузить сотрудников");
    }
  };

  useEffect(() => {
    loadOrders();
    loadEmployees();
  }, []);

  const handleAssign = async (orderId: string, employeeId: string) => {
    if (!employeeId) {
      toast.error("Выберите сотрудника");
      return;
    }
    setAssigning((prev) => ({ ...prev, [orderId]: true }));
    try {
      await adminApi.assignOrder(orderId, parseInt(employeeId));
      toast.success(`Заказ ${orderId} назначен`);
      // Обновляем список заказов
      loadOrders();
    } catch (err: any) {
      toast.error(err.message || "Ошибка назначения");
    } finally {
      setAssigning((prev) => ({ ...prev, [orderId]: false }));
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">
          Очередь заказов (awaiting_packaging)
        </h1>
        <Button onClick={loadOrders} disabled={loading}>
          🔄 Обновить
        </Button>
      </div>

      {loading ? (
        <div className="text-center py-10 text-muted-foreground">
          Загрузка заказов...
        </div>
      ) : orders.length === 0 ? (
        <div className="text-center py-10 text-muted-foreground">
          Нет заказов в очереди
        </div>
      ) : (
        <div className="grid gap-4">
          {orders.map((order) => (
            <Card key={order.posting_number}>
              <CardHeader>
                <CardTitle className="flex items-center justify-between">
                  <span>Заказ {order.posting_number}</span>
                  <Badge variant="outline">
                    Склад:{" "}
                    {order.analytics_data?.warehouse ||
                      order.warehouse_id ||
                      "не указан"}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <div className="font-semibold">Состав:</div>
                  <ul className="text-sm space-y-1">
                    {order.products?.map((p, idx) => (
                      <li key={idx}>
                        {p.name} — {p.quantity} шт.
                        {p.offer_id && (
                          <span className="text-xs text-muted-foreground">
                            {" "}
                            (offer_id: {p.offer_id})
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="flex items-center gap-4">
                  <div className="flex-1">
                    <Select
                      value={selectedEmployee[order.posting_number] || ""}
                      onValueChange={(val) =>
                        setSelectedEmployee((prev) => ({
                          ...prev,
                          [order.posting_number]: val,
                        }))
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Выберите сотрудника">
                          {(val) => {
                            const emp = employees.find(
                              (e) => String(e.id) === val,
                            );
                            return emp ? emp.name : "";
                          }}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {employees.map((emp) => (
                          <SelectItem key={emp.id} value={String(emp.id)}>
                            {emp.name} (ID: {emp.id})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    onClick={() =>
                      handleAssign(
                        order.posting_number,
                        selectedEmployee[order.posting_number] || "",
                      )
                    }
                    disabled={
                      assigning[order.posting_number] ||
                      !selectedEmployee[order.posting_number]
                    }
                  >
                    {assigning[order.posting_number]
                      ? "Назначение..."
                      : "Назначить"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
};
