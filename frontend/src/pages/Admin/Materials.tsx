import { useEffect, useState } from "react";
import { adminApi } from "../../api/admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

interface MaterialsData {
  materials: Record<string, number>;
  specialOffers: Record<string, number>;
  minEarnings: number;
  colors: string[];
}

export const Materials = () => {
  const [data, setData] = useState<MaterialsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [file, setFile] = useState<File | null>(null);

  const loadMaterials = async () => {
    setLoading(true);
    try {
      const result = await adminApi.getMaterials();
      setData(result);
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
    if (e.target.files && e.target.files.length > 0) {
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
      toast.success("Файл материалов загружен");
      setFile(null);
      // Сбросить input
      const input = document.getElementById("file-upload") as HTMLInputElement;
      if (input) input.value = "";
      loadMaterials(); // перезагрузить данные
    } catch (err: any) {
      toast.error(err.message || "Ошибка загрузки");
    } finally {
      setUploading(false);
    }
  };

  if (loading) {
    return (
      <div className="text-center py-10 text-muted-foreground">Загрузка...</div>
    );
  }

  if (!data) {
    return (
      <div className="text-center py-10 text-red-500">
        Не удалось загрузить данные
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Управление материалами</h1>
        <Button onClick={loadMaterials} disabled={loading}>
          🔄 Обновить
        </Button>
      </div>

      {/* Карточка с загрузкой файла */}
      <Card>
        <CardHeader>
          <CardTitle>Загрузить новый файл материалов</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="file-upload">Файл materials-prices.json</Label>
            <Input
              id="file-upload"
              type="file"
              accept=".json"
              onChange={handleFileChange}
              className="mt-1"
            />
          </div>
          <Button onClick={handleUpload} disabled={!file || uploading}>
            {uploading ? "Загрузка..." : "📤 Загрузить"}
          </Button>
        </CardContent>
      </Card>

      {/* Текущие настройки */}
      <Card>
        <CardHeader>
          <CardTitle>Текущие настройки</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <h3 className="font-semibold">
              Минимальный заработок за единицу:{" "}
              <Badge variant="outline">{data.minEarnings} руб.</Badge>
            </h3>
          </div>
          <div>
            <h3 className="font-semibold mb-2">Цвета пластика:</h3>
            <div className="flex flex-wrap gap-2">
              {data.colors.map((color) => (
                <Badge key={color} variant="secondary">
                  {color}
                </Badge>
              ))}
            </div>
          </div>
          <div>
            <h3 className="font-semibold mb-2">Цены материалов (руб/грамм):</h3>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Материал</TableHead>
                  <TableHead className="text-right">Цена за грамм</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Object.entries(data.materials).map(([name, price]) => (
                  <TableRow key={name}>
                    <TableCell>{name}</TableCell>
                    <TableCell className="text-right">
                      {price.toFixed(2)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {Object.keys(data.specialOffers).length > 0 && (
            <div>
              <h3 className="font-semibold mb-2">Специальные предложения:</h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Offer ID</TableHead>
                    <TableHead className="text-right">
                      Стоимость (руб/шт)
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {Object.entries(data.specialOffers).map(
                    ([offerId, price]) => (
                      <TableRow key={offerId}>
                        <TableCell>{offerId}</TableCell>
                        <TableCell className="text-right">
                          {price.toFixed(2)}
                        </TableCell>
                      </TableRow>
                    ),
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};
