import React, { useState } from "react";
import { Link } from "react-router-dom";
import {
  CATEGORIES,
  getDashboardsByCategory,
  type DashboardDef,
} from "../../config/dashboards";

const PAGE_BG = "#0b1220";

const DashboardCard: React.FC<{ d: DashboardDef }> = ({ d }) => {
  const [hover, setHover] = useState(false);
  return (
    <Link
      to={d.path}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: "20px 18px",
        backgroundColor: "#0f172a",
        border: `1px solid ${hover ? d.accent : "#1e293b"}`,
        borderRadius: 12,
        textDecoration: "none",
        color: "#f8fafc",
        boxShadow: hover ? `0 8px 24px ${d.accent}33` : "0 2px 8px rgba(0,0,0,0.3)",
        transform: hover ? "translateY(-2px)" : "translateY(0)",
        transition: "all 0.18s ease",
        minHeight: 160,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ fontSize: "2rem", lineHeight: 1 }}>{d.icon}</span>
        <span
          style={{
            fontSize: "1.05rem",
            fontWeight: 700,
            color: hover ? d.accent : "#f8fafc",
            transition: "color 0.18s",
          }}
        >
          {d.label}
        </span>
      </div>
      <p
        style={{
          margin: 0,
          fontSize: "0.85rem",
          color: "#94a3b8",
          lineHeight: 1.5,
          flex: 1,
        }}
      >
        {d.desc}
      </p>
      {d.badges && d.badges.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {d.badges.map((b) => (
            <span
              key={b}
              style={{
                padding: "3px 8px",
                fontSize: "0.7rem",
                fontWeight: 600,
                color: d.accent,
                backgroundColor: `${d.accent}1a`,
                border: `1px solid ${d.accent}33`,
                borderRadius: 999,
              }}
            >
              {b}
            </span>
          ))}
        </div>
      )}
    </Link>
  );
};

export const HomePage: React.FC = () => {
  return (
    <div
      style={{
        minHeight: "100vh",
        width: "100%",
        backgroundColor: PAGE_BG,
        color: "#f8fafc",
        fontFamily: "sans-serif",
        overflowX: "hidden",
        overflowY: "auto",
        backgroundImage:
          "radial-gradient(circle at 20% 10%, rgba(56,189,248,0.12), transparent 40%), radial-gradient(circle at 80% 80%, rgba(244,63,94,0.08), transparent 45%)",
      }}
    >
      <div
        style={{
          maxWidth: 1200,
          margin: "0 auto",
          padding: "56px 32px 80px 32px",
        }}
      >
        {/* Header */}
        <header style={{ marginBottom: 48 }}>
          <h1
            style={{
              margin: 0,
              padding: "8px 0", // chừa chỗ cho descender khi WebkitBackgroundClip text clip line-box
              fontSize: "3rem",
              fontWeight: 700,
              lineHeight: 1.2, // override 145% từ :root → tránh "nhảy" height theo system font
              letterSpacing: "-0.02em",
              display: "inline-block",
              background: "linear-gradient(90deg, #38bdf8, #a855f7, #f43f5e)",
              WebkitBackgroundClip: "text",
              backgroundClip: "text",
              WebkitTextFillColor: "transparent",
            }}
          >
            WebGIS Performance Showcase
          </h1>
          <p
            style={{
              margin: "12px 0 0 0",
              fontSize: "1rem",
              color: "#94a3b8",
              maxWidth: 720,
              lineHeight: 1.6,
            }}
          >
            Bộ demo render quy mô lớn trên MapLibre GL + React 19 + Web Workers.
            100k–1M điểm, GPU shader, supercluster, lerp 60fps, offline-first sync.
          </p>
        </header>

        {/* Categories */}
        {CATEGORIES.map((cat) => {
          const items = getDashboardsByCategory(cat.id);
          if (items.length === 0) return null;
          return (
            <section key={cat.id} style={{ marginBottom: 40 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 6 }}>
                <h2
                  style={{
                    margin: 0,
                    fontSize: "1.3rem",
                    fontWeight: 700,
                    color: cat.accent,
                  }}
                >
                  {cat.icon} {cat.label}
                </h2>
                <span style={{ fontSize: "0.85rem", color: "#64748b" }}>{items.length} demo</span>
              </div>
              <p style={{ margin: "0 0 18px 0", fontSize: "0.85rem", color: "#94a3b8" }}>
                {cat.desc}
              </p>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
                  gap: 16,
                }}
              >
                {items.map((d) => (
                  <DashboardCard key={d.id} d={d} />
                ))}
              </div>
            </section>
          );
        })}

        <footer
          style={{
            marginTop: 48,
            paddingTop: 24,
            borderTop: "1px solid #1e293b",
            fontSize: "0.75rem",
            color: "#64748b",
            textAlign: "center",
            lineHeight: 1.6,
          }}
        >
          React 19 · MapLibre GL v5 · Vite · Web Workers · IndexedDB · WebGL
        </footer>
      </div>
    </div>
  );
};
