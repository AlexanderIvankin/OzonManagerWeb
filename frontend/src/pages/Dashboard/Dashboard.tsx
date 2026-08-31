import { useSelector, useDispatch } from 'react-redux';
import { RootState, AppDispatch } from '../../store';
import { logout } from '../../store/authSlice';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export const Dashboard = () => {
  const user = useSelector((state: RootState) => state.auth.user);
  const dispatch = useDispatch<AppDispatch>();

  const handleLogout = async () => {
    await dispatch(logout());
    window.location.href = '/login';
  };

  return (
    <div className="container mx-auto py-10">
      <Card className="max-w-2xl mx-auto">
        <CardHeader>
          <CardTitle>Добро пожаловать, {user?.name}!</CardTitle>
          <CardDescription>Роль: {user?.role}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p><strong>Логин:</strong> {user?.username}</p>
          <p><strong>Email:</strong> {user?.email}</p>
          <p><strong>Принтеров:</strong> {user?.capacity}</p>
          <Button onClick={handleLogout} variant="destructive">Выйти</Button>
        </CardContent>
      </Card>
    </div>
  );
};