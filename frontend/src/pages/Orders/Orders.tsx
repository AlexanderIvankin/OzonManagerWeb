import { useSelector } from 'react-redux';
import { RootState } from '../../store';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export const Orders = () => {
  const user = useSelector((state: RootState) => state.auth.user);

  return (
    <div className="container mx-auto py-10">
      <Card>
        <CardHeader>
          <CardTitle>Мои заказы</CardTitle>
        </CardHeader>
        <CardContent>
          <p>Здесь будет список активных заказов для сотрудника {user?.name}</p>
          <p className="text-sm text-muted-foreground mt-4">Страница в разработке</p>
        </CardContent>
      </Card>
    </div>
  );
};