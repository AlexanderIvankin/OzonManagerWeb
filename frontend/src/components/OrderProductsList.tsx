import type { ReactNode } from "react";
import { OrderProduct } from "../api/orders";
import { ProductImages } from "./ProductImages";

interface OrderProductsListProps {
  products: OrderProduct[];
  /**
   * Дополнительный блок под товаром (например, кнопка «Скачать модель» у
   * активных заказов). Завершённым заказам не нужен.
   */
  renderProductExtra?: (product: OrderProduct, index: number) => ReactNode;
}

/**
 * Состав заказа с фотографиями товаров — общий блок карточек страницы
 * «Мои заказы» (активные и завершённые), чтобы разметка не разъезжалась.
 */
export const OrderProductsList = ({
  products,
  renderProductExtra,
}: OrderProductsListProps) => {
  if (!products || products.length === 0) return null;

  return (
    <div className="mt-2">
      <div className="font-semibold text-l mb-[5px]">Состав:</div>
      <ul className="text-sm space-y-3">
        {products.map((p, idx) => (
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
            {renderProductExtra ? renderProductExtra(p, idx) : null}
          </li>
        ))}
      </ul>
    </div>
  );
};
