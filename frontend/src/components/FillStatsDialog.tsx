import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import api from "../api";

interface FillStatsDialogProps {
  offerId: string;
  onSuccess: () => void;
  children: React.ReactNode;
}

export const FillStatsDialog = ({
  offerId,
  onSuccess,
  children,
}: FillStatsDialogProps) => {
  const [open, setOpen] = useState(false);
  const [material, setMaterial] = useState("");
  const [color, setColor] = useState("");
  const [weight, setWeight] = useState("");
  const [loading, setLoading] = useState(false);
  const [materialsList, setMaterialsList] = useState<string[]>([]);
  const [colorsList, setColorsList] = useState<string[]>([]);

  // Загружаем список материалов и цветов при открытии
  useEffect(() => {
    if (open) {
      api
        .get("/admin/materials")
        .then((res) => {
          setMaterialsList(
            res.data.materials ? Object.keys(res.data.materials) : [],
          );
          setColorsList(res.data.colors || []);
        })
        .catch(() => {
          // Если не загрузилось, используем дефолтные
          setMaterialsList([
            "Pet-G",
            "ABS",
            "Нейлон Pa-6",
            "Нейлон Pa-12",
            "НейлонАрмир",
            "ASA",
          ]);
          setColorsList([
            "Черный",
            "Белый",
            "Серый",
            "Прозрачный",
            "Красный",
            "Желтый",
            "Зеленый",
          ]);
        });
    }
  }, [open]);

  const handleSubmit = async () => {
    if (!material || !color || !weight || parseFloat(weight) <= 0) {
      toast.error("Заполните все поля корректно");
      return;
    }
    setLoading(true);
    try {
      await api.post("/user/fill-stats", {
        offerId,
        material,
        color,
        weight: parseFloat(weight),
      });
      toast.success("Статистика сохранена");
      setOpen(false);
      onSuccess();
    } catch (err: any) {
      toast.error(err.message || "Ошибка сохранения статистики");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger>{children}</DialogTrigger>
      <DialogContent>
        <DialogHeader className="pt-10">
          <DialogTitle className="text-center">
            <div>Заполнение статистики для</div>
            <code className="mt-1 block text-center">{offerId}</code>
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label>Материал</Label>
            <Select value={material} onValueChange={(value) => setMaterial(value ?? "")}>
              <SelectTrigger>
                <SelectValue placeholder="Выберите материал" />
              </SelectTrigger>
              <SelectContent>
                {materialsList.map((mat) => (
                  <SelectItem key={mat} value={mat}>
                    {mat}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Цвет</Label>
            <Select value={color} onValueChange={(value) => setColor(value ?? "")}>
              <SelectTrigger>
                <SelectValue placeholder="Выберите цвет" />
              </SelectTrigger>
              <SelectContent>
                {colorsList.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Вес (граммы)</Label>
            <Input
              type="number"
              placeholder="150"
              value={weight}
              onChange={(e) => setWeight(e.target.value)}
            />
          </div>
          <Button onClick={handleSubmit} disabled={loading} className="w-full">
            {loading ? "Сохранение..." : "Сохранить статистику"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
