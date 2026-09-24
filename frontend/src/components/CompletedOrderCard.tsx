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
import {
  ordersApi,
  CompletedOrder,
  readApiErrorPayload,
} from "../api/orders";
import { toast } from "sonner";
import { isSocketConnected } from "../lib/socket";
import { OrderProductsList } from "./OrderProductsList";

interface CompletedOrderCardProps {
  order: CompletedOrder;
}

/**
 * Карточка завершённого заказа, ожидающего отправки (awaiting_deliver) —
 * вкладка «🗳️ Завершённые заказы». Состав и фотографии такие же, как у
 * активного заказа, но действие одно: скачать этикетку (Ozon getPackageLabel).
 */
export const CompletedOrderCard = ({ order }: CompletedOrderCardProps) => {
  // Формирование этикетки в Ozon — задача с опросом готовности (до ~2 минут),
  // поэтому кнопку блокируем до ответа сервера.
  const [downloading, setDownloading] = useState(false);

  const handleDownloadLabel = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const blob = await ordersApi.getLabel(order.orderId);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `label_${order.orderId}.pdf`;
      a.click();
      window.URL.revokeObjectURL(url);
      toast.success(`Этикетка заказа ${order.orderId} скачана`);
    } catch (err: unknown) {
      // Кулдаун: при подключённом сокете live-тост уже ушёл по WebSocket —
      // локальный не дублируем; сокет отключён -> показываем локально (fallback)
      const payload = await readApiErrorPayload(err);
      if (payload?.cooldown && isSocketConnected()) return;
      toast.error(
        payload?.error ||
          (err as Error)?.message ||
          "Не удалось скачать этикетку",
      );
    } finally {
      setDownloading(false);
    }
  };

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
          <Badge variant="secondary">🗳️ Ожидает отправки</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="text-sm text-muted-foreground">
          Завершён: {new Date(order.completedAt).toLocaleString()}
        </div>
        <OrderProductsList products={order.products} />
      </CardContent>
      <CardFooter className="justify-center">
        <Button
          variant="secondary"
          onClick={handleDownloadLabel}
          disabled={downloading}
        >
          {downloading ? "⏳ Формируем этикетку..." : "📄 Скачать этикетку"}
        </Button>
      </CardFooter>
    </Card>
  );
};
