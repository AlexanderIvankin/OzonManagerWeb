import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { adminApi } from "../../api/admin";
import { toast } from "sonner";

export const ExportTeamInfo = () => {
  const [loading, setLoading] = useState(false);

  const handleExport = async (includeFired: boolean) => {
    setLoading(true);
    try {
      const blob = await adminApi.exportTeamInfo(includeFired);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = includeFired ? "employees-db.xlsx" : "team-info.xlsx";
      a.click();
      window.URL.revokeObjectURL(url);
      toast.success("Файл скачан");
    } catch (err: any) {
      toast.error(err.message || "Ошибка экспорта");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Экспорт team-info</h1>
      <Card>
        <CardHeader>
          <CardTitle>Выгрузка данных сотрудников</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Скачайте файл Excel со списком сотрудников, их складами и
            настройками.
          </p>
          <div className="flex gap-4">
            <Button onClick={() => handleExport(false)} disabled={loading}>
              📥 Скачать (активные)
            </Button>
            <Button
              onClick={() => handleExport(true)}
              disabled={loading}
              variant="outline"
            >
              📥 Скачать (включая уволенных)
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};
