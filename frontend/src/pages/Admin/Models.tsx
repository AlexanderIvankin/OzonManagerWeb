import { useEffect, useState } from "react";
import {
  adminApi,
  getBlobErrorMessage,
  getDownloadFileName,
  OfferModelRow,
} from "../../api/admin";
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

// Размер zip в человекочитаемом виде
const formatSize = (bytes: number | null | undefined) => {
  if (!bytes) return "—";
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} МБ` : `${(bytes / 1024).toFixed(0)} КБ`;
};

const formatDateTime = (ts: number | null) =>
  ts ? new Date(ts).toLocaleString("ru-RU") : "—";

// Короткий хеш для таблицы: первые 12 символов sha256
const shortHash = (hash: string | null) => (hash ? hash.slice(0, 12) : "—");

export const Models = () => {
  const [models, setModels] = useState<OfferModelRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [downloadingOffer, setDownloadingOffer] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [offerId, setOfferId] = useState("");

  const loadModels = async () => {
    setLoading(true);
    try {
      const data = await adminApi.getModels();
      setModels(data);
    } catch (err: any) {
      toast.error(err.message || "Не удалось загрузить список моделей");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadModels();
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setFile(e.target.files[0]);
      // Артикул по умолчанию — из имени файла ({offer_id}.zip)
      const fromName = e.target.files[0].name.replace(/\.zip$/i, "");
      setOfferId((prev) => prev || fromName);
    }
  };

  const handleUpload = async () => {
    if (!file) {
      toast.error("Выберите zip-архив");
      return;
    }
    if (!/\.zip$/i.test(file.name)) {
      toast.error("Модели загружаются одним zip-архивом (.zip)");
      return;
    }
    const target = offerId.trim().replace(/\.zip$/i, "");
    if (!target) {
      toast.error("Укажите артикул (offer_id) или назовите файл {offer_id}.zip");
      return;
    }
    setUploading(true);
    try {
      const result = await adminApi.uploadModel(file, target);
      toast.success(result.message || `Модель ${target} загружена`);
      setFile(null);
      setOfferId("");
      const input = document.getElementById("model-file-upload") as HTMLInputElement;
      if (input) input.value = "";
      loadModels();
    } catch (err: any) {
      toast.error(
        err.response?.data?.error || err.message || "Ошибка загрузки модели",
      );
    } finally {
      setUploading(false);
    }
  };

  const handleDownload = async (offerId: string) => {
    setDownloadingOffer(offerId);
    try {
      const res = await adminApi.downloadModel(offerId);
      const fileName = getDownloadFileName(res, `${offerId}.zip`);
      const url = window.URL.createObjectURL(res.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (err: any) {
      toast.error(
        await getBlobErrorMessage(err, "Не удалось скачать модель"),
      );
    } finally {
      setDownloadingOffer(null);
    }
  };

  const handleDelete = async (offerId: string) => {
    if (
      !confirm(
        `Удалить модель ${offerId}? Zip-архив будет удалён из S3, а сотрудники потеряют кнопку скачивания.`,
      )
    )
      return;
    setDeleting(offerId);
    try {
      await adminApi.deleteModel(offerId);
      toast.success(`Модель ${offerId} удалена`);
      loadModels();
    } catch (err: any) {
      toast.error(err.message || "Не удалось удалить модель");
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="container mx-auto space-y-6 py-6">
      <h1 className="text-2xl font-bold">🧊 3D-модели (zip в S3)</h1>

      {/* Загрузка новой/обновлённой модели */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            📤 Загрузить модель (zip)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Модель на артикул — один zip-архив с файлами (.stl, .3mf, .step,
            .obj, .zip). При обновлении файлов просто залейте новый архив —
            старый перезапишется, кэш сбросится, сотрудники получат оповещение.
            Артикул можно не указывать, если файл назван{" "}
            <code>{"{offer_id}.zip"}</code> (например,{" "}
            <code>ARD000003-N.zip</code>).
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="model-offer-id">Артикул (offer_id)</Label>
              <Input
                id="model-offer-id"
                placeholder="ARD000003-N"
                value={offerId}
                onChange={(e) => setOfferId(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="model-file-upload">Zip-архив</Label>
              <Input
                id="model-file-upload"
                type="file"
                accept=".zip,application/zip"
                onChange={handleFileChange}
              />
            </div>
          </div>
          <Button onClick={handleUpload} disabled={uploading || !file}>
            {uploading ? "⏳ Загрузка…" : "📤 Загрузить в S3"}
          </Button>
        </CardContent>
      </Card>

      {/* Список моделей */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            🗃️ Загруженные модели{" "}
            {models.length > 0 && (
              <Badge variant="outline">{models.length}</Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="py-6 text-center text-muted-foreground">
              Загрузка…
            </div>
          ) : models.length === 0 ? (
            <div className="py-6 text-center text-muted-foreground">
              Моделей пока нет — загрузите первый zip-архив
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Артикул</TableHead>
                  <TableHead>Размер</TableHead>
                  <TableHead className="hidden md:table-cell">
                    SHA-256
                  </TableHead>
                  <TableHead className="hidden lg:table-cell">
                    Загружена
                  </TableHead>
                  <TableHead className="hidden lg:table-cell">Кем</TableHead>
                  <TableHead className="text-right">Действия</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {models.map((m) => (
                  <TableRow key={m.offer_id}>
                    <TableCell>
                      <code className="font-bold">{m.offer_id}</code>
                      <div className="text-xs text-muted-foreground">
                        {m.file_name || `${m.offer_id}.zip`}
                      </div>
                    </TableCell>
                    <TableCell>{formatSize(m.file_size)}</TableCell>
                    <TableCell className="hidden md:table-cell">
                      <code className="text-xs text-muted-foreground">
                        {shortHash(m.file_hash)}
                      </code>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell text-xs text-muted-foreground">
                      {formatDateTime(m.uploaded_at)}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell text-xs text-muted-foreground">
                      {m.uploaded_by_name || m.uploaded_by || "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={downloadingOffer === m.offer_id}
                          onClick={() => handleDownload(m.offer_id)}
                          title="Скачать zip себе"
                        >
                          {downloadingOffer === m.offer_id ? "⏳" : "⬇️"}
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          disabled={deleting === m.offer_id}
                          onClick={() => handleDelete(m.offer_id)}
                          title="Удалить модель"
                        >
                          {deleting === m.offer_id ? "⏳" : "🗑"}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
};
