import { useEffect, useState } from "react";

export default function ServiceStatus() {
  const [status, setStatus] = useState<"loading" | "ok" | "unavailable">("loading");

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    fetch("/v1/health", { signal: controller.signal, cache: "no-store" })
      .then(async response => {
        const data: unknown = await response.json();
        const healthy = response.ok && typeof data === "object" && data !== null
          && "status" in data && data.status === "ok";
        if (active) setStatus(healthy ? "ok" : "unavailable");
      })
      .catch(() => { if (active) setStatus("unavailable"); })
      .finally(() => clearTimeout(timeout));
    return () => { active = false; clearTimeout(timeout); controller.abort(); };
  }, []);

  return (
    <div className="service-status" role="status" aria-live="polite">
      <span className={`status-dot ${status}`} aria-hidden="true" />
      {status === "loading" ? "연결 확인 중" : status === "ok" ? "서비스 연결 정상" : "서비스 연결을 확인해 주세요"}
    </div>
  );
}
