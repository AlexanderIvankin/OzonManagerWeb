import { useState } from "react";
import { adminApi } from "../../api/admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

export const EarningsManagement = () => {
  const [userId, setUserId] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [month, setMonth] = useState("");
  const [loading, setLoading] = useState(false);

  const handleAddAdjustment = async () => {
    if (!userId || !amount) {
      toast.error("Введите ID сотрудника и сумму");
      return;
    }
    setLoading(true);
    try {
      await adminApi.addEarningsAdjustment(
        parseInt(userId),
        parseFloat(amount),
        reason,
      );
      toast.success("Корректировка добавлена");
      setAmount("");
      setReason("");
    } catch (err: any) {
      toast.error(err.message || "Ошибка добавления корректировки");
    } finally {
      setLoading(false);
    }
  };

  const handleSettle = async () => {
    if (!userId) {
      toast.error("Введите ID сотрудника");
      return;
    }
    if (!confirm(`Обнулить активный заработок сотрудника ${userId}?`)) return;
    setLoading(true);
    try {
      const result = await adminApi.settleEarnings(parseInt(userId));
      toast.success(
        `Активный заработок обнулён. Сумма: ${result.clearedAmount} руб.`,
      );
    } catch (err: any) {
      toast.error(err.message || "Ошибка обнуления");
    } finally {
      setLoading(false);
    }
  };

  const handleExport = async () => {
    if (!month) {
      toast.error("Выберите месяц");
      return;
    }
    try {
      const blob = await adminApi.exportMonthlyEarnings(month);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `monthly_earnings_${month}.xlsx`;
      a.click();
      window.URL.revokeObjectURL(url);
      toast.success("Файл скачан");
    } catch (err: any) {
      toast.error(err.message || "Ошибка экспорта");
    }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Управление заработком</h1>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>➕ Добавить корректировку</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>ID сотрудника</Label>
              <Input
                type="number"
                placeholder="Например: 1"
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Сумма (может быть отрицательной)</Label>
              <Input
                type="number"
                placeholder="Например: 100 или -50"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Причина (опционально)</Label>
              <Input
                placeholder="Премия, штраф, ..."
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
            <Button
              onClick={handleAddAdjustment}
              disabled={loading || !userId || !amount}
            >
              Добавить корректировку
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>🧹 Обнулить активный заработок</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>ID сотрудника</Label>
              <Input
                type="number"
                placeholder="Например: 1"
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
              />
            </div>
            <Button
              variant="destructive"
              onClick={handleSettle}
              disabled={loading || !userId}
            >
              Обнулить заработок
            </Button>
          </CardContent>
        </Card>

        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle>📊 Экспорт заработка</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-end gap-4">
              <div className="flex-1 space-y-2">
                <Label>Месяц (YYYY-MM)</Label>
                <Input
                  type="month"
                  value={month}
                  onChange={(e) => setMonth(e.target.value)}
                />
              </div>
              <Button onClick={handleExport} disabled={!month}>
                📥 Скачать Excel
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};
