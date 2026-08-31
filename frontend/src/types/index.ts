export interface User {
  id: number;
  username: string;
  email: string;
  name: string;
  phone?: string;
  capacity: number;
  earnings_factor: number;
  role: 'user' | 'employee' | 'moderator' | 'admin';
  is_fired: boolean;
  taking_orders: boolean;
  tg_user_id?: string;
  created_at: number;
  updated_at: number;
  stats?: {
    total_orders: number;
    total_amount: number;
    canceled_orders: number;
  };
  activeOrders?: Array<{ order_id: string; assigned_at: number }>;
}