import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
export const AdminDashboard = () => {
  const navigate = useNavigate();

  const cards = [
    {
      title: "👥 Пользователи",
      description: "Управление сотрудниками и их правами",
      path: "/admin/users",
    },
    {
      title: "🏭 Склады",
      description: "Синхронизация и просмотр складов",
      path: "/admin/warehouses",
    },
    {
      title: "📦 Очередь заказов",
      description: "Просмотр и назначение заказов",
      path: "/admin/orders",
    },
    {
      title: "💰 Заработок",
      description: "Корректировки, экспорт, расчёт",
      path: "/admin/earnings",
    },
    {
      title: "📁 Материалы",
      description: "Управление ценами материалов и спецпредложениями",
      path: "/admin/materials",
    },
    {
      title: "📤 Экспорт данных",
      description: "Статистика товаров, сотрудники, файл БД",
      path: "/admin/export",
    },
  ];

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-2 text-center">
      {cards.map((card) => (
        <Card
          key={card.path}
          className="cursor-pointer hover:shadow-lg transition-shadow"
          onClick={() => navigate(card.path)}
        >
          <CardHeader>
            <CardTitle>{card.title}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">{card.description}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
};
