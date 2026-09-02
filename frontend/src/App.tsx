import { useEffect } from "react";
import { useDispatch } from "react-redux";
import { AppDispatch } from "./store";
import { restoreSession } from "./store/authSlice";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Login } from "./pages/Login/Login";
import { Register } from "./pages/Register/Register";
import { Profile } from "./pages/Profile/Profile";
import { Orders } from "./pages/Orders/Orders";
import { AdminPanel } from "./pages/Admin/AdminPanel";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { Layout } from "./components/Layout/Layout";

function App() {
  const dispatch = useDispatch<AppDispatch>();

  useEffect(() => {
    dispatch(restoreSession());
  }, [dispatch]);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />

        {/* Защищённые маршруты с Layout */}
        <Route element={<ProtectedRoute />}>
          <Route element={<Layout />}>
            <Route path="/profile" element={<Profile />} />
            <Route
              path="/orders"
              element={
                <ProtectedRoute
                  allowedRoles={["employee", "moderator", "admin"]}
                >
                  <Orders />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/*"
              element={
                <ProtectedRoute allowedRoles={["admin", "moderator"]}>
                  <AdminPanel />
                </ProtectedRoute>
              }
            />
          </Route>
        </Route>

        <Route path="*" element={<Navigate to="/profile" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
