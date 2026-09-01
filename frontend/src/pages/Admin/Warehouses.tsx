import { useEffect, useState } from "react";
import { adminApi, Warehouse } from "../../api/admin";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

export const Warehouses = () => {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const loadWarehouses = async () => {
    setLoading(true);
    try {
      const data = await adminApi.getWarehouses();
      setWarehouses(data);
    } catch (err: any) {
      toast.error(err.message || "Не удалось загрузить склады");
    } finally {
      setLoading(false);
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      const result = await adminApi.syncWarehouses();
      toast.success(`Склады синхронизированы: ${result.count} складов`);
      loadWarehouses();
    } catch (err: any) {
      toast.error(err.message || "Ошибка синхронизации");
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    loadWarehouses();
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Склады</h1>
        <div className="flex gap-2">
          <Button onClick={handleSync} disabled={syncing || loading}>
            {syncing ? "Синхронизация..." : "🔄 Синхронизировать"}
          </Button>
          <Button onClick={loadWarehouses} disabled={loading}>
            Обновить
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>Название</TableHead>
                <TableHead>Адрес</TableHead>
                <TableHead>Тип</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center">
                    Загрузка...
                  </TableCell>
                </TableRow>
              ) : warehouses.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center">
                    Нет складов
                  </TableCell>
                </TableRow>
              ) : (
                warehouses.map((wh) => (
                  <TableRow key={wh.warehouse_id}>
                    <TableCell className="font-mono text-sm">
                      {wh.warehouse_id}
                    </TableCell>
                    <TableCell>{wh.name}</TableCell>
                    <TableCell>{wh.address || "—"}</TableCell>
                    <TableCell>
                      <Badge variant={wh.is_rfbs ? "default" : "secondary"}>
                        {wh.is_rfbs ? "realFBS" : "FBS"}
                      </Badge>
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
