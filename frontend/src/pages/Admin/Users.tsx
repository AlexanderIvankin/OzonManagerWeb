import { useEffect, useState } from "react";
import { useSelector } from "react-redux";
import { adminApi, User } from "../../api/admin";
import { RootState } from "../../store";
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
import {
  formatPhoneInput,
  isValidPhone,
  PHONE_FORMAT_HINT,
} from "@/lib/utils";

// Подписи ролей по-русски
const ROLE_LABELS: Record<string, string> = {
  user: "Пользователь",
  employee: "Сотрудник",
  moderator: "Модератор",
  admin: "Администратор",
  god: "👻 Создатель",
};

// Роли, доступные при создании аккаунта (god выдаётся только синхронизацией)
const CREATE_ROLES = ["employee", "user", "moderator", "admin"] as const;
type CreateRole = (typeof CREATE_ROLES)[number];

const emptyCreateForm = {
  username: "",
  email: "",
  password: "",
  name: "",
  phone: "",
  capacity: "",
  role: "employee" as CreateRole,
};

export const Users = () => {
  // Текущий пользователь: определяет, может ли он редактировать Создателя
  const viewer = useSelector((state: RootState) => state.auth.user);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [showFired, setShowFired] = useState(false);

  // === Создание аккаунта администратором (без email-подтверждения) ===
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState(emptyCreateForm);
  const [creating, setCreating] = useState(false);
  const [createErrors, setCreateErrors] = useState<Record<string, string>>({});

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
    // Валидация телефона: если указан — ровно 11 цифр
    if (user.phone && user.phone.trim() !== "" && !isValidPhone(user.phone)) {
      toast.error(
        "Телефон должен содержать ровно 11 цифр в формате +7 (999) 999-99-99",
      );
      return;
    }
    try {
      // Роль Создателя управляется только синхронизацией из Excel —
      // не отправляем её на сервер при редактировании
      const payload = { ...user };
      if (payload.role === "god") delete (payload as Partial<User>).role;
      await adminApi.updateUser(user.id, payload);
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

  const handleRestoreUser = async (user: User) => {
    if (!confirm(`Восстановить пользователя ${user.name}?`)) return;
    try {
      await adminApi.updateUser(user.id, {
        is_fired: false,
        taking_orders: true,
        role: "employee",
      });
      toast.success(`Пользователь ${user.name} восстановлен`);
      loadUsers();
    } catch (err: any) {
      toast.error(err.message || "Ошибка восстановления");
    }
  };

  const handleCreateUser = async () => {
    // Клиентская валидация (мягкие правила админ-регистрации):
    // логин/пароль от 1 символа, email — формат, capacity — целое >= 1
    const errors: Record<string, string> = {};
    if (!createForm.username.trim()) errors.username = "Укажите логин";
    if (!/^\S+@\S+\.\S+$/.test(createForm.email.trim()))
      errors.email = "Некорректный email";
    if (!createForm.password) errors.password = "Укажите пароль";
    if (createForm.capacity.trim() !== "") {
      const n = Number(createForm.capacity);
      if (!Number.isInteger(n) || n < 1)
        errors.capacity = "Целое положительное число (пусто — 1)";
    }
    setCreateErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setCreating(true);
    try {
      const result = await adminApi.createUser({
        username: createForm.username.trim(),
        email: createForm.email.trim(),
        password: createForm.password,
        name: createForm.name.trim() || undefined,
        phone: createForm.phone.trim() || undefined,
        capacity:
          createForm.capacity.trim() !== ""
            ? Number(createForm.capacity)
            : undefined,
        role: createForm.role,
      });
      toast.success(result.message || `Аккаунт ${createForm.username} создан`);
      loadUsers();
      setShowCreate(false);
      setCreateForm({ ...emptyCreateForm });
      setCreateErrors({});
    } catch (err: any) {
      // Ошибки бэкенда: 400 (валидация) / 409 (занят логин или email)
      setCreateErrors({
        _server:
          err?.response?.data?.error || err?.message || "Ошибка создания аккаунта",
      });
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Пользователи</h1>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={() => {
              setCreateErrors({});
              setShowCreate(true);
            }}
          >
            ➕ Создать аккаунт
          </Button>
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
                    <TableCell className="text-center">
                      <code>{user.id}</code>
                    </TableCell>
                    <TableCell className="text-center">
                      <b>{user.name}</b>
                    </TableCell>
                    <TableCell className="text-center">
                      {user.username}
                    </TableCell>
                    <TableCell className="text-center">{user.email}</TableCell>
                    <TableCell className="text-center">
                      <Badge
                        variant="outline"
                        className={`font-normal ${
                          ["admin", "moderator", "god"].includes(user.role)
                            ? "font-bold"
                            : ""
                        }`}
                      >
                        {ROLE_LABELS[user.role] ?? user.role}
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
                      {/* Создателя может редактировать только Создатель:
                          остальным ролям кнопки не показываются */}
                      {user.role !== "god" || viewer?.role === "god" ? (
                        <>
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
                                    placeholder="+7 (999) 999-99-99"
                                    value={formatPhoneInput(
                                      editingUser.phone || "",
                                    )}
                                    onChange={(e) =>
                                      setEditingUser({
                                        ...editingUser,
                                        phone: formatPhoneInput(e.target.value),
                                      })
                                    }
                                  />
                                  <p className="text-xs text-muted-foreground">
                                    {PHONE_FORMAT_HINT}
                                  </p>
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
                                  {/* Роль Создателя нельзя изменить вручную —
                                      только синхронизацией из Excel */}
                                  {editingUser.role === "god" ? (
                                    <Input
                                      value="👻 Создатель (изменение недоступно)"
                                      disabled
                                    />
                                  ) : (
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
                                  )}
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
                      {user.is_fired ? (
                        <Button
                          variant="default"
                          size="sm"
                          onClick={() => handleRestoreUser(user)}
                        >
                          🔄 Восстановить
                        </Button>
                      ) : (
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => handleFireUser(user.id)}
                        >
                          🗑️
                        </Button>
                      )}
                        </>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          👻 Только Создатель
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Создание аккаунта администратором (в обход email-подтверждения) */}
      <Dialog
        open={showCreate}
        onOpenChange={(open) => {
          if (!open) setShowCreate(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Создать аккаунт</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-xs text-muted-foreground">
              Аккаунт создаётся сразу подтверждённым — без письма с кодом
              подтверждения. Логин и email должны быть уникальными.
            </p>
            <div className="space-y-1">
              <Label htmlFor="create-username">Логин *</Label>
              <Input
                id="create-username"
                placeholder="Минимум 1 символ"
                value={createForm.username}
                onChange={(e) =>
                  setCreateForm({ ...createForm, username: e.target.value })
                }
              />
              {createErrors.username && (
                <p className="text-sm text-red-500">{createErrors.username}</p>
              )}
            </div>
            <div className="space-y-1">
              <Label htmlFor="create-email">Email *</Label>
              <Input
                id="create-email"
                type="email"
                placeholder="user@example.com"
                value={createForm.email}
                onChange={(e) =>
                  setCreateForm({ ...createForm, email: e.target.value })
                }
              />
              {createErrors.email && (
                <p className="text-sm text-red-500">{createErrors.email}</p>
              )}
            </div>
            <div className="space-y-1">
              <Label htmlFor="create-password">Пароль *</Label>
              <Input
                id="create-password"
                type="password"
                placeholder="Минимум 1 символ"
                value={createForm.password}
                onChange={(e) =>
                  setCreateForm({ ...createForm, password: e.target.value })
                }
              />
              {createErrors.password && (
                <p className="text-sm text-red-500">{createErrors.password}</p>
              )}
            </div>
            <div className="space-y-1">
              <Label htmlFor="create-name">Имя</Label>
              <Input
                id="create-name"
                placeholder="Если не указать — будет использован логин"
                value={createForm.name}
                onChange={(e) =>
                  setCreateForm({ ...createForm, name: e.target.value })
                }
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="create-phone">Телефон</Label>
              <Input
                id="create-phone"
                inputMode="tel"
                value={createForm.phone}
                onChange={(e) =>
                  setCreateForm({ ...createForm, phone: e.target.value })
                }
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="create-capacity">Количество принтеров</Label>
              <Input
                id="create-capacity"
                type="number"
                placeholder="1"
                value={createForm.capacity}
                onChange={(e) =>
                  setCreateForm({ ...createForm, capacity: e.target.value })
                }
              />
              {createErrors.capacity ? (
                <p className="text-sm text-red-500">{createErrors.capacity}</p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Целое положительное число, без ограничения сверху. По
                  умолчанию — 1.
                </p>
              )}
            </div>
            <div className="space-y-1">
              <Label>Роль</Label>
              <Select
                value={createForm.role}
                onValueChange={(val) =>
                  setCreateForm({ ...createForm, role: val as CreateRole })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CREATE_ROLES.map((r) => (
                    <SelectItem key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Роль 👻 Создатель выдаётся только синхронизацией из Excel.
              </p>
            </div>
            {createErrors._server && (
              <p className="text-sm text-red-500">{createErrors._server}</p>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="outline"
                onClick={() => setShowCreate(false)}
                disabled={creating}
              >
                Отмена
              </Button>
              <Button onClick={handleCreateUser} disabled={creating}>
                {creating ? "Создание..." : "Создать"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};
