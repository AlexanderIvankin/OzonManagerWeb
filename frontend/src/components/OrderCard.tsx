import { useState } from "react";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ordersApi, Order } from "../api/orders";
import { toast } from "sonner";
import { FillStatsDialog } from "./FillStatsDialog";
import { ProductImages } from "./ProductImages";

interface OrderCardProps {
  order: Order;
  onOrderUpdated: () => void;
}

export const OrderCard = ({ order, onOrderUpdated }: OrderCardProps) => {
  const [loading, setLoading] = useState(false);

  const handleFinish = async () => {
    if (!confirm(`Завершить заказ ${order.orderId}?`)) return;
    setLoading(true);
    try {
      const result = await ordersApi.finishOrder(order.orderId);
      toast.success(
        `Заказ ${order.orderId} завершён! Заработок: ${result.earnings} руб.`,
      );
      onOrderUpdated();
    } catch (err: any) {
      toast.error(err.message || "Ошибка завершения заказа");
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = async () => {
    if (!confirm(`Отменить заказ ${order.orderId}?`)) return;
    setLoading(true);
    try {
      await ordersApi.cancelOrder(order.orderId);
      toast.success(`Заказ ${order.orderId} отменён`);
      onOrderUpdated();
    } catch (err: any) {
      toast.error(err.message || "Ошибка отмены заказа");
    } finally {
      setLoading(false);
    }
  };

  const handleDownloadLabel = async () => {
    try {
      const blob = await ordersApi.getLabel(order.orderId);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `label_${order.orderId}.pdf`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (err: any) {
      toast.error(err.message || "Не удалось скачать этикетку");
    }
  };

  const missingOfferIds = order.missingStats || [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-2">
          <span>
            Заказ{" "}
            <span className="font-bold">
              <code>{order.orderId}</code>
            </span>
          </span>
          <Badge
            variant={order.statsStatus === "filled" ? "default" : "destructive"}
          >
            {order.statsStatus === "filled"
              ? "✅ Статистика заполнена"
              : "⚠️ Нужна статистика"}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="text-sm text-muted-foreground">
          Назначен: {new Date(order.assignedAt).toLocaleString()}
        </div>
        {missingOfferIds.length > 0 && (
          <div className="text-sm text-red-500 space-y-1">
            <div>Отсутствует статистика для:</div>
            <div className="flex flex-wrap gap-1">
              {missingOfferIds.map((id) => (
                <Badge key={id} variant="outline" className="cursor-pointer">
                  <code>{id}</code>
                </Badge>
              ))}
            </div>
          </div>
        )}
        {order.products.length > 0 && (
          <div className="mt-2">
            <div className="font-semibold text-l mb-[5px]">Состав:</div>
            <ul className="text-sm space-y-3">
              {order.products.map((p, idx) => (
                <li key={idx}>
                  <div className="mb-[5px]">
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
                    <ProductImages productName={p.name} images={p.images} />
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        <Button
          onClick={handleFinish}
          disabled={loading || order.statsStatus === "missing"}
        >
          ✅ Завершить
        </Button>
        <Button variant="outline" onClick={handleCancel} disabled={loading}>
          ❌ Отменить
        </Button>
        <Button
          variant="secondary"
          className="ml-auto"
          onClick={handleDownloadLabel}
          disabled={loading}
        >
          📄 Скачать этикетку
        </Button>
      </CardFooter>
      {missingOfferIds.length > 0 && (
        <div className="flex justify-center px-6 pb-4">
          <FillStatsDialog
            offerId={missingOfferIds[0]}
            onSuccess={onOrderUpdated}
          >
            <Button variant="outline" size="sm">
              📝 Заполнить статистику
            </Button>
          </FillStatsDialog>
          {missingOfferIds.length > 1 && (
            <span className="text-xs text-muted-foreground ml-2">
              + ещё {missingOfferIds.length - 1} товаров без статистики
            </span>
          )}
        </div>
      )}
    </Card>
  );
};
