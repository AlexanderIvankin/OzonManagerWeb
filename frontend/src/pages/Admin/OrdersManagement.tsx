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
import { ProductImages } from "../../components/ProductImages";

interface AwaitingOrder {
  posting_number: string;
  products: Array<{
    name: string;
    quantity: number;
    offer_id?: string;
    sku?: string;
    images?: Array<{ url: string; name: string }>;
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
          Очередь заказов (awaiting_packaging)<br></br>
          <span className="flex text-muted-foreground justify-center">
            Число заказов в очереди:{" "}
            <span className="text-blue-600">&nbsp;{orders.length}</span>
          </span>
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
                <CardTitle>
                  <span className="text-xl">
                    Заказ <code>{order.posting_number}</code>
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <div className="font-semibold mb-1">Склад:</div>
                  <div>
                    {order.analytics_data?.warehouse || "не указан"}
                    {order.warehouse_id && (
                      <span className="text-sm text-muted-foreground">
                        {" "}
                        (ID: <code>{order.warehouse_id}</code>)
                      </span>
                    )}
                  </div>
                </div>
                <div>
                  <div className="font-semibold text-xl mb-[10px]">Состав:</div>
                  <ul className="text-sm space-y-5">
                    {order.products?.map((p, idx) => (
                      <li key={idx}>
                        <div>
                          <span className="font-bold">
                            {idx + 1}
                            {". "}
                          </span>
                          {p.name} — {p.quantity} шт.
                          {p.offer_id && (
                            <span className="text-l text-muted-foreground">
                              {" "}
                              <br></br>(offer_id:{" "}
                              <span className="font-bold">
                                <code>{p.offer_id}</code>
                              </span>
                              )
                            </span>
                          )}
                        </div>
                        {p.images && p.images.length > 0 && (
                          <ProductImages
                            productName={p.name}
                            images={p.images}
                          />
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
                      <SelectTrigger className="w-full h-10 text-base">
                        <SelectValue
                          className="text-base font-medium"
                          placeholder="Выберите сотрудника"
                        >
                          {(val) => {
                            if (!val) return "Выберите сотрудника";
                            const emp = employees.find(
                              (e) => String(e.id) === String(val),
                            );
                            return emp ? (
                              <>
                                <b>{emp.name}</b> (ID: <code>{emp.id}</code>)
                              </>
                            ) : (
                              String(val)
                            );
                          }}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {employees.map((emp) => (
                          <SelectItem key={emp.id} value={String(emp.id)}>
                            <b>{emp.name}</b> (ID: <code>{emp.id}</code>)
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    size="lg"
                    className="h-10 px-5 text-base"
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
