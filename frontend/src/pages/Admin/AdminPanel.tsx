import { useSelector } from 'react-redux';
import { RootState } from '../../store';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export const AdminPanel = () => {
  const user = useSelector((state: RootState) => state.auth.user);

  return (
    <div className="container mx-auto py-10">
      <Card>
        <CardHeader>
          <CardTitle>Панель администратора</CardTitle>
        </CardHeader>
        <CardContent>
          <p>Добро пожаловать, {user?.name} (роль: {user?.role})</p>
          <p className="text-sm text-muted-foreground mt-4">Здесь будет админка: управление пользователями, складами, заказами и т.д.</p>
        </CardContent>
      </Card>
    </div>
  );
};