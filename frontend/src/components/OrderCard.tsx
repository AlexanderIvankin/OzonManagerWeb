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

// Размер файла в человекочитаемом виде (МБ)
const formatSize = (bytes: number | null | undefined) => {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  return ` · ${mb >= 1 ? `${mb.toFixed(1)} МБ` : `${(bytes / 1024).toFixed(0)} КБ`}`;
};

interface OrderCardProps {
  order: Order;
  onOrderUpdated: () => void;
}

export const OrderCard = ({ order, onOrderUpdated }: OrderCardProps) => {
  const [loading, setLoading] = useState(false);
  // Скачивание моделей: индикаторы по offer_id (одноразовый токен + скачивание)
  const [modelLoading, setModelLoading] = useState<Record<string, boolean>>({});

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

  // Скачивание 3D-модели товара: токен -> zip (прямых ссылок на S3 нет)
  const handleDownloadModel = async (offerId: string, fileName: string) => {
    setModelLoading((prev) => ({ ...prev, [offerId]: true }));
    try {
      const grant = await ordersApi.requestModelToken(offerId);
      const blob = await ordersApi.downloadModelByToken(grant.token);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = grant.fileName || fileName;
      a.click();
      window.URL.revokeObjectURL(url);
      toast.success(`Модель ${grant.fileName} скачана`);
    } catch (err: any) {
      const message =
        err.response?.data?.error || err.message || "Не удалось скачать модель";
      toast.error(message);
    } finally {
      setModelLoading((prev) => ({ ...prev, [offerId]: false }));
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
                    {p.offer_id && p.model && (
                      <div className="mt-1">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!!modelLoading[p.offer_id]}
                          onClick={() =>
                            handleDownloadModel(p.offer_id!, p.model!.fileName)
                          }
                          title={`Скачать 3D-модель: ${p.model.fileName}${formatSize(p.model.fileSize)}`}
                        >
                          {modelLoading[p.offer_id]
                            ? "⏳ Скачивание…"
                            : "⬇️ Скачать модель"}{" "}
                          <span className="text-muted-foreground">
                            ({p.model.fileName}
                            {formatSize(p.model.fileSize)})
                          </span>
                        </Button>
                        {/* Модель взята у родительского артикула: показываем, по
                            какому именно артикулу лежит zip (для идентификации) */}
                        {p.model.offerId !== p.offer_id && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            🧩 Модель родительского артикула{" "}
                            <code>{p.model.offerId}</code>
                          </p>
                        )}
                      </div>
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
      <CardFooter className="flex flex-col gap-2 items-stretch sm:flex-row md:flex-col xl:flex-row xl:items-center">
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
          className="ml-0 sm:ml-auto md:ml-0 xl:ml-auto"
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
