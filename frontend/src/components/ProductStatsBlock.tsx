import type { ProductStats } from "../api/orders";

interface ProductStatsBlockProps {
  stats?: ProductStats | null;
}

/**
 * Материал, цвет и вес товара (product_stats) — как в карточке заказа
 * Telegram-бота (bot.js: «Материал: …, Цвет: …»). Если статистика не
 * заполнена (stats = null), блок не рендерится.
 */
export const ProductStatsBlock = ({ stats }: ProductStatsBlockProps) => {
  if (!stats) return null;
  return (
    <div className="flex flex-wrap text-sm text-muted-foreground text-center justify-center lg:text-start lg:justify-start">
      Материал: <b>{stats.material}</b>, Цвет: <b>{stats.color}</b>, Вес:{" "}
      <b>{stats.weight_grams} г</b>
    </div>
  );
};