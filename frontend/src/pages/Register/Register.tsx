import { useEffect, useState } from 'react';
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
import { register, resendCode } from '../../store/authSlice';
import { AppDispatch } from '../../store';
import {
  isValidPhone,
  PHONE_FORMAT_HINT,
} from '../../lib/utils';

const registerSchema = z.object({
  username: z.string().min(6, 'Логин: минимум 6 символов'),
  email: z.string().email('Некорректный email'),
  password: z.string().min(6, 'Минимум 6 символов'),
  // Отображаемое имя необязательное: если оставлено пустым,
  // бэкенд (AuthService.register) подставит в display_name логин
  name: z.string().optional(),
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

// Кулдаун повторной отправки кода (сек) — как на странице ввода кода.
// Фактический интервал диктует сервер (RESEND_CODE_COOLDOWN_SEC, по умолчанию 60)
const RESEND_COOLDOWN_SECONDS = 60;

export const Register = () => {
  const dispatch = useDispatch<AppDispatch>();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // === Повторная отправка кода подтверждения прямо со страницы регистрации ===
  // (письмо с кодом не пришло: указываем email из формы — сервер пришлёт новый код)
  const [resendLoading, setResendLoading] = useState(false);
  const [resendMessage, setResendMessage] = useState<string | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  // Email, на который код реально ушёл — для ссылки «Перейти к вводу кода»
  const [resentEmail, setResentEmail] = useState<string | null>(null);

  const {
    register: registerField,
    control,
    handleSubmit,
    getValues,
    formState: { errors },
  } = useForm<RegisterFormValues>({
    resolver: zodResolver(registerSchema),
    defaultValues: { capacity: '1' },
  });

  const onSubmit = async (data: RegisterFormValues) => {
    setLoading(true);
    setError(null);
    try {
      const result = await dispatch(register({
        username: data.username,
        email: data.email,
        password: data.password,
        name: data.name || '',
        // name необязателен: пустое значение бэкенд заменит на username
        // (AuthService.register: displayName = указанное имя || username)
        phone: data.phone || '',
        // zod-схема гарантирует: пусто или целое 1..99. Number вместо parseInt,
        // чтобы дробные значения не обрезались молча
        capacity:
          data.capacity && data.capacity.trim() !== ''
            ? Number(data.capacity)
            : 1,
      })).unwrap();
      // После регистрации — на страницу ввода кода из письма.
      // resent=1 — тем же логином/email нашлась неподтверждённая регистрация:
      // сервер заменил её и отправил код заново (страница покажет это)
      navigate(
        `/verify-email?email=${encodeURIComponent(data.email)}${
          result?.resent ? '&resent=1' : ''
        }`,
      );
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Ошибка регистрации');
    } finally {
      setLoading(false);
    }
  };

  // Таймер кулдауна повторной отправки (как на странице ввода кода)
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => {
      setCooldown((s) => (s > 0 ? s - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  // Повторная отправка кода на email, указанный в форме регистрации.
  // Кулдаун (не чаще раза в минуту) диктует сервер: sent === false означает,
  // что письмо не ушло — кулдаун ещё идёт, аккаунта нет или email уже подтверждён
  const handleResendCode = async () => {
    const email = getValues('email')?.trim();
    setResendMessage(null);
    setResendError(null);
    setResentEmail(null);
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
      setResendError('Укажите в поле Email адрес, указанный при регистрации');
      return;
    }

    setResendLoading(true);
    try {
      const res = await dispatch(resendCode({ email })).unwrap();
      const wait = res.retryAfterSec ?? RESEND_COOLDOWN_SECONDS;
      setCooldown(wait);
      if (res.sent === false) {
        setResendMessage(
          `Письмо уже отправлено — повторно можно через ${wait} с.`,
        );
      } else {
        setResendMessage(
          res.message || 'Код подтверждения отправлен повторно на указанный email',
        );
        setResentEmail(email);
      }
    } catch (err: any) {
      setResendError(
        err?.response?.data?.error || err?.message || 'Ошибка отправки',
      );
    } finally {
      setResendLoading(false);
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
              <Label htmlFor="name">Отображаемое имя (опционально)</Label>
              <Input id="name" placeholder="По умолчанию — логин" {...registerField('name')} />
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
            {/* Письмо с кодом не пришло: отправляем код повторно на email из формы.
                Кулдаун (RESEND_CODE_COOLDOWN_SEC) диктует сервер — не чаще раза в минуту */}
            <Button
              type="button"
              variant="outline"
              className="w-full"
              disabled={resendLoading || cooldown > 0}
              onClick={handleResendCode}
            >
              {cooldown > 0
                ? `Отправить код повторно (${cooldown} с)`
                : resendLoading
                  ? 'Отправляем...'
                  : 'Отправить код повторно'}
            </Button>
            <p className="text-xs text-center text-muted-foreground">
              Письмо с кодом не пришло? Укажите в поле Email адрес, который
              использовали при регистрации, и отправьте код повторно — не чаще
              одного раза в минуту.
            </p>
            {resendMessage && (
              <p className="text-sm text-center text-green-700">
                {resendMessage}
              </p>
            )}
            {resendError && (
              <p className="text-sm text-center text-red-500">{resendError}</p>
            )}
            {resentEmail && (
              <p className="text-sm text-muted-foreground">
                <Link
                  to={`/verify-email?email=${encodeURIComponent(
                    resentEmail,
                  )}&resent=1`}
                  className="text-blue-600 hover:underline"
                >
                  Перейти к вводу кода
                </Link>
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              Уже есть аккаунт? <Link to="/login" className="text-blue-600 hover:underline">Войти</Link>
            </p>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
};