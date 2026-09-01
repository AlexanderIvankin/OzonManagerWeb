import { Routes, Route, Navigate } from "react-router-dom";
import { Users } from "./Users";
import { Warehouses } from "./Warehouses";
import { OrdersManagement } from "./OrdersManagement";
import { Materials } from "./Materials";
import { EarningsManagement } from "./EarningsManagement";
import { ExportTeamInfo } from "./ExportTeamInfo";
import { AdminDashboard } from "./AdminDashboard";

export const AdminPanel = () => {
  return (
    <div className="container mx-auto py-6">
      <Routes>
        <Route path="/" element={<AdminDashboard />} />
        <Route path="/users" element={<Users />} />
        <Route path="/warehouses" element={<Warehouses />} />
        <Route path="/orders" element={<OrdersManagement />} />
        <Route path="/materials" element={<Materials />} />
        <Route path="/earnings" element={<EarningsManagement />} />
        <Route path="/export" element={<ExportTeamInfo />} />
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Routes>
    </div>
  );
};
