import { useEffect, useState } from "react";
import { adminApi, User } from "../../api/admin";
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const Users = () => {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [showFired, setShowFired] = useState(false);

  const loadUsers = async () => {
    setLoading(true);
    try {
      const data = await adminApi.getUsers({
        includeFired: showFired,
        includeAll: true,
      });
      setUsers(data);
    } catch (err: any) {
      toast.error(err.message || "Не удалось загрузить пользователей");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadUsers();
  }, [showFired]);

  const handleUpdateUser = async (user: User) => {
    try {
      await adminApi.updateUser(user.id, user);
      toast.success(`Пользователь ${user.name} обновлён`);
      loadUsers();
      setEditingUser(null);
    } catch (err: any) {
      toast.error(err.message || "Ошибка обновления");
    }
  };

  const handleFireUser = async (id: number) => {
    if (!confirm("Уволить пользователя?")) return;
    try {
      await adminApi.deleteUser(id);
      toast.success("Пользователь уволен");
      loadUsers();
    } catch (err: any) {
      toast.error(err.message || "Ошибка увольнения");
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Пользователи</h1>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-sm">
            <input
              type="checkbox"
              checked={showFired}
              onChange={(e) => setShowFired(e.target.checked)}
            />
            Показывать уволенных
          </label>
          <Button onClick={loadUsers} disabled={loading}>
            🔄 Обновить
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-center">ID</TableHead>
                <TableHead className="text-center">Имя</TableHead>
                <TableHead className="text-center">Логин</TableHead>
                <TableHead className="text-center">Email</TableHead>
                <TableHead className="text-center">Роль</TableHead>
                <TableHead className="text-center">Принтеры</TableHead>
                <TableHead className="text-center">Коэф.</TableHead>
                <TableHead className="text-center">Статус</TableHead>
                <TableHead className="text-center">Действия</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center">
                    Загрузка...
                  </TableCell>
                </TableRow>
              ) : users.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center">
                    Нет пользователей
                  </TableCell>
                </TableRow>
              ) : (
                users.map((user) => (
                  <TableRow
                    key={user.id}
                    className={user.is_fired ? "opacity-50" : ""}
                  >
                    <TableCell className="text-center">{user.id}</TableCell>
                    <TableCell className="text-center">{user.name}</TableCell>
                    <TableCell className="text-center">
                      {user.username}
                    </TableCell>
                    <TableCell className="text-center">{user.email}</TableCell>
                    <TableCell className="text-center">
                      <Badge
                        variant="outline"
                        className={`font-normal ${user.role === "admin" || user.role === "moderator" ? "font-bold" : ""}`}
                      >
                        {user.role}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-center">
                      {user.capacity}
                    </TableCell>
                    <TableCell className="text-center">
                      {user.earnings_factor}
                    </TableCell>
                    <TableCell className="text-center">
                      {user.is_fired ? (
                        <Badge variant="destructive">Уволен</Badge>
                      ) : user.taking_orders ? (
                        <Badge variant="default">Принимает</Badge>
                      ) : (
                        <Badge variant="secondary">Не принимает</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-center space-x-1">
                      <Dialog
                        open={editingUser?.id === user.id}
                        onOpenChange={(open) => {
                          if (!open) setEditingUser(null);
                        }}
                      >
                        <DialogTrigger
                          render={
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setEditingUser(user)}
                            />
                          }
                        >
                          ✏️
                        </DialogTrigger>
                        <DialogContent>
                          <DialogHeader>
                            <DialogTitle>
                              Редактировать пользователя
                            </DialogTitle>
                          </DialogHeader>
                          {editingUser && (
                            <div className="space-y-4 py-4">
                              <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-2">
                                  <Label>Имя</Label>
                                  <Input
                                    value={editingUser.name}
                                    onChange={(e) =>
                                      setEditingUser({
                                        ...editingUser,
                                        name: e.target.value,
                                      })
                                    }
                                  />
                                </div>
                                <div className="space-y-2">
                                  <Label>Телефон</Label>
                                  <Input
                                    value={editingUser.phone || ""}
                                    onChange={(e) =>
                                      setEditingUser({
                                        ...editingUser,
                                        phone: e.target.value,
                                      })
                                    }
                                  />
                                </div>
                              </div>
                              <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-2">
                                  <Label>Принтеры</Label>
                                  <Input
                                    type="number"
                                    value={editingUser.capacity}
                                    onChange={(e) =>
                                      setEditingUser({
                                        ...editingUser,
                                        capacity: parseInt(e.target.value),
                                      })
                                    }
                                  />
                                </div>
                                <div className="space-y-2">
                                  <Label>Коэффициент</Label>
                                  <Input
                                    type="number"
                                    step="0.1"
                                    value={editingUser.earnings_factor}
                                    onChange={(e) =>
                                      setEditingUser({
                                        ...editingUser,
                                        earnings_factor: parseFloat(
                                          e.target.value,
                                        ),
                                      })
                                    }
                                  />
                                </div>
                              </div>
                              <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-2">
                                  <Label>Роль</Label>
                                  <Select
                                    value={editingUser.role}
                                    onValueChange={(val) =>
                                      setEditingUser({
                                        ...editingUser,
                                        role: val as any,
                                      })
                                    }
                                  >
                                    <SelectTrigger>
                                      <SelectValue>
                                        {(val) =>
                                          (
                                            ({
                                              user: "Пользователь",
                                              employee: "Сотрудник",
                                              moderator: "Модератор",
                                              admin: "Администратор",
                                            }) as Record<string, string>
                                          )[String(val)] ?? String(val)
                                        }
                                      </SelectValue>
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="user">
                                        Пользователь
                                      </SelectItem>
                                      <SelectItem value="employee">
                                        Сотрудник
                                      </SelectItem>
                                      <SelectItem value="moderator">
                                        Модератор
                                      </SelectItem>
                                      <SelectItem value="admin">
                                        Администратор
                                      </SelectItem>
                                    </SelectContent>
                                  </Select>
                                </div>
                                <div className="space-y-2">
                                  <Label>Приём заказов</Label>
                                  <Select
                                    value={
                                      editingUser.taking_orders
                                        ? "true"
                                        : "false"
                                    }
                                    onValueChange={(val) =>
                                      setEditingUser({
                                        ...editingUser,
                                        taking_orders: val === "true",
                                      })
                                    }
                                  >
                                    <SelectTrigger>
                                      <SelectValue>
                                        {(val) =>
                                          String(val) === "true"
                                            ? "Принимает"
                                            : "Не принимает"
                                        }
                                      </SelectValue>
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="true">
                                        Принимает
                                      </SelectItem>
                                      <SelectItem value="false">
                                        Не принимает
                                      </SelectItem>
                                    </SelectContent>
                                  </Select>
                                </div>
                              </div>
                              <div className="flex justify-end gap-2 pt-4">
                                <Button
                                  variant="outline"
                                  onClick={() => setEditingUser(null)}
                                >
                                  Отмена
                                </Button>
                                <Button
                                  onClick={() => handleUpdateUser(editingUser)}
                                >
                                  Сохранить
                                </Button>
                              </div>
                            </div>
                          )}
                        </DialogContent>
                      </Dialog>
                      {!user.is_fired && (
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => handleFireUser(user.id)}
                        >
                          🗑️
                        </Button>
                      )}
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
