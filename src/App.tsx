import { Navigate, Route, Routes } from "react-router-dom";
import { DASHBOARDS } from "./config/dashboards";
import { HomePage } from "./components/Landing/HomePage";
import { DashboardShell } from "./components/Landing/DashboardShell";

function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route element={<DashboardShell />}>
        {DASHBOARDS.map((d) => {
          const Comp = d.component;
          return <Route key={d.id} path={d.path} element={<Comp />} />;
        })}
      </Route>
      {/* Unknown path → về home */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;
