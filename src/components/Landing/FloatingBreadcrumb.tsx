import React from "react";
import { Link, useLocation } from "react-router-dom";
import { getDashboardByPath, getCategoryById } from "../../config/dashboards";

// Pill float top-left khi user ở trong dashboard. Đọc current path → registry → hiển thị crumbs.
// z-index 1000 — trên map content, dưới popup MapLibre (1010).
export const FloatingBreadcrumb: React.FC = () => {
  const location = useLocation();
  const dashboard = getDashboardByPath(location.pathname);
  if (!dashboard) return null;
  const category = getCategoryById(dashboard.category);

  return (
    <nav
      style={{
        position: "fixed",
        top: 12,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 14px",
        backgroundColor: "rgba(15, 23, 42, 0.95)",
        border: "1px solid #1e293b",
        borderRadius: 999,
        boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
        backdropFilter: "blur(8px)",
        fontFamily: "sans-serif",
        fontSize: "0.85rem",
      }}
    >
      <Link
        to="/"
        title="Về trang chủ"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          color: "#94a3b8",
          textDecoration: "none",
          fontWeight: 600,
          padding: "2px 6px",
          borderRadius: 6,
          transition: "color 0.15s, background-color 0.15s",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = "#f8fafc";
          e.currentTarget.style.backgroundColor = "#1e293b";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = "#94a3b8";
          e.currentTarget.style.backgroundColor = "transparent";
        }}
      >
        🏠 Home
      </Link>

      {category && (
        <>
          <span style={{ color: "#475569" }}>›</span>
          <span style={{ color: category.accent, fontWeight: 600 }}>
            {category.icon} {category.label}
          </span>
        </>
      )}

      <span style={{ color: "#475569" }}>›</span>
      <span style={{ color: dashboard.accent, fontWeight: 700 }}>
        {dashboard.icon} {dashboard.label}
      </span>
    </nav>
  );
};
