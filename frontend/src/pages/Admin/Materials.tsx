import { useEffect, useState } from "react";
import { adminApi } from "../../api/admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

export const Materials = () => {
  const [materials, setMaterials] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  const loadMaterials = async () => {
    setLoading(true);
    try {
      const data = await adminApi.getMaterials();
      setMaterials(data);
    } catch (err: any) {
      toast.error(err.message || "Не удалось загрузить настройки материалов");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadMaterials();
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
    }
  };

  const handleUpload = async () => {
    if (!file) {
      toast.error("Выберите файл");
      return;
    }
    setUploading(true);
    try {
      await adminApi.uploadMaterials(file);
      toast.success("Материалы обновлены");
      loadMaterials();
      setFile(null);
    } catch (err: any) {
      toast.error(err.message || "Ошибка загрузки");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Настройки материалов</h1>
        <Button onClick={loadMaterials} disabled={loading}>
          🔄 Обновить
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Загрузить новый файл</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-end gap-4">
            <div className="flex-1 space-y-2">
              <Label htmlFor="file">Файл materials-prices.json</Label>
              <Input
                id="file"
                type="file"
                accept=".json"
                onChange={handleFileChange}
                className="cursor-pointer"
              />
            </div>
            <Button onClick={handleUpload} disabled={!file || uploading}>
              {uploading ? "Загрузка..." : "📤 Загрузить"}
            </Button>
          </div>
          {file && (
            <p className="text-sm text-muted-foreground">
              Выбран файл: {file.name} ({(file.size / 1024).toFixed(2)} КБ)
            </p>
          )}
        </CardContent>
      </Card>

      {loading ? (
        <p>Загрузка...</p>
      ) : materials ? (
        <Card>
          <CardHeader>
            <CardTitle>Текущие настройки</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <h3 className="font-semibold">Цены материалов (за грамм):</h3>
              <pre className="mt-2 p-3 bg-muted rounded-md text-sm overflow-auto">
                {JSON.stringify(materials.materials, null, 2)}
              </pre>
            </div>
            {materials.specialOffers &&
              Object.keys(materials.specialOffers).length > 0 && (
                <div>
                  <h3 className="font-semibold">Спецпредложения:</h3>
                  <pre className="mt-2 p-3 bg-muted rounded-md text-sm overflow-auto">
                    {JSON.stringify(materials.specialOffers, null, 2)}
                  </pre>
                </div>
              )}
            <div>
              <h3 className="font-semibold">Минимальный заработок:</h3>
              <p className="mt-1">{materials.minEarnings} руб.</p>
            </div>
            <div>
              <h3 className="font-semibold">Доступные цвета:</h3>
              <div className="flex flex-wrap gap-2 mt-1">
                {materials.colors?.map((color: string) => (
                  <span
                    key={color}
                    className="px-2 py-1 bg-muted rounded-md text-sm"
                  >
                    {color}
                  </span>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      ) : (
        <p>Нет данных</p>
      )}
    </div>
  );
};
