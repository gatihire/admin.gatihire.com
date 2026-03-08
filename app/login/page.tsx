"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

const LOGO_URL = "https://i.postimg.cc/D0W2Z5sY/log0-def.png";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json();

      if (res.ok && data.success) {
        router.push("/");
      } else {
        setError(data.error || "Invalid credentials");
      }
    } catch (err) {
      setError("An error occurred during login");
    }
  };

  return (
    <div style={{ display: "flex", justifyContent: "center", alignItems: "center", height: "100vh", background: "#f7f7f7" }}>
      <form onSubmit={handleSubmit} style={{ background: "#fff", borderRadius: 12, boxShadow: "0 4px 24px rgba(0,0,0,0.08)", padding: 40, minWidth: 340, display: "flex", flexDirection: "column", gap: 20, alignItems: "center" }}>
        <img src={LOGO_URL} alt="Logo" style={{ width: 120, marginBottom: 16 }} />
        <h2 style={{ marginBottom: 8 }}>Login</h2>
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          required
          style={{ padding: 10, borderRadius: 6, border: "1px solid #ddd", width: "100%" }}
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          required
          style={{ padding: 10, borderRadius: 6, border: "1px solid #ddd", width: "100%" }}
        />
        <button type="submit" style={{ padding: "10px 24px", borderRadius: 6, border: "none", background: "#333", color: "#fff", fontWeight: 600, cursor: "pointer", width: "100%" }}>Login</button>
        {error && <div style={{ color: "red", marginTop: 8 }}>{error}</div>}
      </form>
    </div>
  );
}
