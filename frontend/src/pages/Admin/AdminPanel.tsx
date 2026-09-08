import { Routes, Route, Navigate } from "react-router-dom";
import { Users } from "./Users";
import { Warehouses } from "./Warehouses";
import { OrdersManagement } from "./OrdersManagement";
import { ActiveOrders } from "./ActiveOrders";
import { Materials } from "./Materials";
import { EarningsManagement } from "./EarningsManagement";
import { ExportData } from "./ExportData";
import { AdminDashboard } from "./AdminDashboard";
import { StaffStats } from "./StaffStats";

export const AdminPanel = () => {
  return (
    <div className="container mx-auto py-6">
      <Routes>
        <Route path="/" element={<AdminDashboard />} />
        <Route path="/users" element={<Users />} />
        <Route path="/warehouses" element={<Warehouses />} />
        <Route path="/orders" element={<OrdersManagement />} />
        <Route path="/active-orders" element={<ActiveOrders />} />
        <Route path="/materials" element={<Materials />} />
        <Route path="/earnings" element={<EarningsManagement />} />
        <Route path="/stats" element={<StaffStats />} />
        <Route path="/export" element={<ExportData />} />
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Routes>
    </div>
  );
};
