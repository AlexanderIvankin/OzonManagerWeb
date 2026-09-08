import { useEffect, useState } from "react";
import { adminApi, getDownloadFileName } from "../../api/admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

interface EmployeeEarnings {
  id: number;
  name: string;
  username: string;
  email: string;
  activeEarningsBase: number;
  activeEarningsAdjustments: number;
  activeEarningsTotal: number;
  role: string;
  is_fired: boolean;
}

export const EarningsManagement = () => {
  const [data, setData] = useState<EmployeeEarnings[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedUser, setSelectedUser] = useState<EmployeeEarnings | null>(
    null,
  );
  const [adjustAmount, setAdjustAmount] = useState("");
  const [adjustReason, setAdjustReason] = useState("");
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  });

  const loadData = async () => {
    setLoading(true);
    try {
      const result = await adminApi.getActiveEarningsAll();
      setData(result);
    } catch (err: any) {
      toast.error(err.message || "Не удалось загрузить данные");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleSettle = async (userId: number) => {
    if (!confirm("Обнулить активный заработок сотрудника?")) return;
    try {
      await adminApi.settleEarnings(userId);
      toast.success("Активный заработок обнулён");
      loadData();
    } catch (err: any) {
      toast.error(err.message || "Ошибка");
    }
  };

  const handleAddAdjustment = async (userId: number) => {
    const amount = parseFloat(adjustAmount);
    if (isNaN(amount)) {
      toast.error("Введите корректную сумму");
      return;
    }
    try {
      await adminApi.addEarningsAdjustment(userId, amount, adjustReason);
      toast.success("Корректировка добавлена");
      setAdjustAmount("");
      setAdjustReason("");
      setSelectedUser(null);
      loadData();
    } catch (err: any) {
      toast.error(err.message || "Ошибка");
    }
  };

  const handleExport = async () => {
    if (!month) return;
    try {
      const res = await adminApi.exportMonthlyEarnings(month);
      const url = window.URL.createObjectURL(res.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = getDownloadFileName(res, `monthly_earnings_${month}.xlsx`);
      a.click();
      window.URL.revokeObjectURL(url);
      toast.success("Файл скачан");
    } catch (err: any) {
      // При responseType: "blob" ответы об ошибках тоже приходят как Blob,
      // поэтому err.message — только "Request failed with status code 404",
      // а нормальный текст сервера лежит внутри err.response.data (Blob).
      if (err.response?.status === 404) {
        let message = "Нет данных для экспорта за выбранный месяц";
        if (err.response.data instanceof Blob) {
          try {
            const parsed = JSON.parse(await err.response.data.text());
            if (parsed?.error) message = parsed.error;
          } catch {
            // тело не JSON — оставляем сообщение по умолчанию
          }
        }
        toast.error(message);
      } else {
        toast.error(err.message || "Ошибка экспорта");
      }
    }
  };

  const handleResetAll = async () => {
    if (!confirm("Сбросить ВСЕ заработки (необратимо)?")) return;
    try {
      await adminApi.resetAllEarnings();
      toast.success("Все заработки сброшены");
      loadData();
    } catch (err: any) {
      toast.error(err.message || "Ошибка");
    }
  };

  if (loading) {
    return (
      <div className="text-center py-10 text-muted-foreground">Загрузка...</div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Управление заработком</h1>
        <Button onClick={loadData} disabled={loading}>
          🔄 Обновить
        </Button>
      </div>

      {/* Экспорт и сброс */}
      <Card>
        <CardHeader className="flex justify-center">
          <CardTitle>Экспорт и действия</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-4">
          <div>
            <Label className="mb-[15px] justify-center">Месяц</Label>
            <Input
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="w-40"
            />
          </div>
          <Button onClick={handleExport}>📥 Скачать отчёт</Button>
          <Button
            className="ml-auto"
            variant="destructive"
            onClick={handleResetAll}
          >
            ⚠️ Сбросить все заработки
          </Button>
        </CardContent>
      </Card>

      {/* Таблица сотрудников */}
      <Card>
        <CardHeader className="text-center">
          <CardTitle>Активный заработок сотрудников</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-center">Сотрудник</TableHead>
                <TableHead className="text-center">Роль</TableHead>
                <TableHead className="text-center">Базовый</TableHead>
                <TableHead className="text-center">Корректировки</TableHead>
                <TableHead className="text-center">Итого</TableHead>
                <TableHead className="text-center">Действия</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center">
                    Нет данных
                  </TableCell>
                </TableRow>
              ) : (
                data.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell className="text-center">
                      <b>{user.name}</b>
                    </TableCell>
                    <TableCell className="text-center">
                      <Badge
                        className={
                          ["admin", "moderator", "god"].includes(user.role)
                            ? "font-bold"
                            : ""
                        }
                        variant="outline"
                      >
                        {user.role}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-center">
                      {user.activeEarningsBase.toFixed(2)}
                    </TableCell>
                    <TableCell
                      className={
                        "text-center" +
                        (user.activeEarningsAdjustments !== 0
                          ? " text-blue-600"
                          : "")
                      }
                    >
                      {user.activeEarningsAdjustments.toFixed(2)}
                    </TableCell>
                    <TableCell className="text-center font-bold">
                      {user.activeEarningsTotal.toFixed(2)}
                    </TableCell>
                    <TableCell className="text-center space-x-1">
                      <Dialog>
                        <DialogTrigger
                          render={
                            <Button
                              variant="outline"
                              size="sm"
                              className="leading-none"
                              onClick={() => setSelectedUser(user)}
                            />
                          }
                        >
                          ✏️ Корректировка
                        </DialogTrigger>
                        {selectedUser && selectedUser.id === user.id && (
                          <DialogContent>
                            <DialogHeader>
                              <DialogTitle>
                                Корректировка для {selectedUser.name}
                              </DialogTitle>
                            </DialogHeader>
                            <div className="space-y-4 py-4">
                              <div>
                                <Label>Сумма (отрицательная — штраф)</Label>
                                <Input
                                  type="number"
                                  placeholder="200"
                                  value={adjustAmount}
                                  onChange={(e) =>
                                    setAdjustAmount(e.target.value)
                                  }
                                />
                              </div>
                              <div>
                                <Label>Причина</Label>
                                <Input
                                  placeholder="Премия за перевыполнение"
                                  value={adjustReason}
                                  onChange={(e) =>
                                    setAdjustReason(e.target.value)
                                  }
                                />
                              </div>
                              <Button
                                onClick={() =>
                                  handleAddAdjustment(selectedUser.id)
                                }
                              >
                                Добавить корректировку
                              </Button>
                            </div>
                          </DialogContent>
                        )}
                      </Dialog>
                      <Button
                        variant="destructive"
                        size="sm"
                        className="leading-none"
                        onClick={() => handleSettle(user.id)}
                      >
                        Обнулить
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
};
