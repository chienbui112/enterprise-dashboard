import React, { Suspense } from "react";
import { Outlet } from "react-router-dom";
import { FloatingBreadcrumb } from "./FloatingBreadcrumb";
import { MapLoadingOverlay } from "../MapLoadingOverlay";

// Layout chung cho mọi dashboard route: breadcrumb pill ở góc + dashboard fullscreen ở Outlet.
// Suspense fallback cho chunk loading khi user nhảy dashboard lần đầu.
export const DashboardShell: React.FC = () => {
  return (
    <>
      <FloatingBreadcrumb />
      <Suspense
        fallback={
          <div style={{ width: "100vw", height: "100vh", position: "relative", backgroundColor: "#0b1220" }}>
            <MapLoadingOverlay visible label="Loading dashboard chunk..." />
          </div>
        }
      >
        <Outlet />
      </Suspense>
    </>
  );
};
