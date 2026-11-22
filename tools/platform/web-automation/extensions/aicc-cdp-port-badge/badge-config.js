(() => {
  const slots = Object.freeze({
    "user": Object.freeze({ badge: "상", color: "#334155", label: "Chrome · 상훈" }),
    "9222": Object.freeze({ badge: "22", color: "#2563EB", label: "ChatGPT 기본 · Chrome 9222" }),
    "9223": Object.freeze({ badge: "23", color: "#EA580C", label: "ChatGPT 보조 · Chrome 9223" }),
    "9224": Object.freeze({ badge: "24", color: "#7C3AED", label: "ChatGPT Pro · Chrome 9224" }),
    "9225": Object.freeze({ badge: "25", color: "#0D9488", label: "네이버 블로그 · Chrome 9225" })
  });

  globalThis.AiccCdpBadge = Object.freeze({
    storageKey: "slot",
    slots,
    unconfigured: Object.freeze({ badge: "?", color: "#5F6368", label: "Chrome identity not configured" })
  });
})();
