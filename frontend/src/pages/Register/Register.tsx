import { useState } from 'react';
import { useDispatch } from 'react-redux';
import { Link, useNavigate } from 'react-router-dom';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PhoneInput } from '@/components/PhoneInput';
import { register } from '../../store/authSlice';
import { AppDispatch } from '../../store';
import {
  isValidPhone,
  PHONE_FORMAT_HINT,
} from '../../lib/utils';

const registerSchema = z.object({
  username: z.string().min(6, 'Логин: минимум 6 символов'),
  email: z.string().email('Некорректный email'),
  password: z.string().min(6, 'Минимум 6 символов'),
  name: z.string().min(1, 'Введите имя'),
  phone: z
    .string()
    .optional()
    .refine(
      (v) => !v || v.trim() === '' || isValidPhone(v),
      'Введите номер в формате ' + PHONE_FORMAT_HINT,
    ),
  capacity: z
    .string()
    .optional()
    .refine(
      (v) =>
        !v ||
        v.trim() === '' ||
        (Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 99),
      'Количество принтеров: целое число от 1 до 99',
    ),
});

type RegisterFormValues = z.infer<typeof registerSchema>;

export const Register = () => {
  const dispatch = useDispatch<AppDispatch>();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    register: registerField,
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<RegisterFormValues>({
    resolver: zodResolver(registerSchema),
    defaultValues: { capacity: '1' },
  });

  const onSubmit = async (data: RegisterFormValues) => {
    setLoading(true);
    setError(null);
    try {
      await dispatch(register({
        username: data.username,
        email: data.email,
        password: data.password,
        name: data.name,
        phone: data.phone || '',
        // zod-схема гарантирует: пусто или целое 1..99. Number вместо parseInt,
        // чтобы дробные значения не обрезались молча
        capacity:
          data.capacity && data.capacity.trim() !== ''
            ? Number(data.capacity)
            : 1,
      })).unwrap();
      // После регистрации — на страницу ввода кода из письма
      navigate(`/verify-email?email=${encodeURIComponent(data.email)}`);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Ошибка регистрации');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Регистрация</CardTitle>
          <CardDescription>Создайте новый аккаунт</CardDescription>
        </CardHeader>
        <form onSubmit={handleSubmit(onSubmit)}>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="username">Логин</Label>
              <Input id="username" placeholder="Придумайте логин" {...registerField('username')} />
              {errors.username && <p className="text-sm text-red-500">{errors.username.message}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" placeholder="Введите email" {...registerField('email')} />
              {errors.email && <p className="text-sm text-red-500">{errors.email.message}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Пароль</Label>
              <Input id="password" type="password" placeholder="Придумайте пароль" {...registerField('password')} />
              {errors.password && <p className="text-sm text-red-500">{errors.password.message}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="name">Имя</Label>
              <Input id="name" placeholder="Ваше имя" {...registerField('name')} />
              {errors.name && <p className="text-sm text-red-500">{errors.name.message}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="phone">Телефон (опционально)</Label>
              <Controller
                name="phone"
                control={control}
                render={({ field }) => (
                  <PhoneInput
                    id="phone"
                    placeholder="+7 (999) 999-99-99"
                    inputMode="tel"
                    value={field.value ?? ''}
                    onValueChange={(formatted) => field.onChange(formatted)}
                  />
                )}
              />
              {errors.phone && (
                <p className="text-sm text-red-500">{errors.phone.message}</p>
              )}
            </div>
            <div className="space-y-2 mb-[20px]">
              <Label htmlFor="capacity">Количество принтеров (опционально)</Label>
              <Input id="capacity" type="number" placeholder="1" {...registerField('capacity')} />
              {errors.capacity ? (
                <p className="text-sm text-red-500">{errors.capacity.message}</p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Целое число от 1 до 99. По умолчанию — 1.
                </p>
              )}
            </div>
            {error && <p className="text-sm text-red-500">{error}</p>}
          </CardContent>
          <CardFooter className="flex flex-col space-y-2">
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? 'Загрузка...' : 'Зарегистрироваться'}
            </Button>
            <p className="text-sm text-muted-foreground">
              Уже есть аккаунт? <Link to="/login" className="text-blue-600 hover:underline">Войти</Link>
            </p>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
};