import zlib from "zlib";

/**
 * Generates a 128×128 PNG avatar per agent (gradient circle + white initials), so Discord webhook replies show a
 * distinct role badge without any third-party image service. Pure Node (zlib only), cached in memory.
 */
const FONT: Record<string, string[]> = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"], B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"], E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"], G: ["01111", "10000", "10000", "10011", "10001", "10001", "01111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"], O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"], Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"], U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"], C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"], T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"], N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"], V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "11011", "10001"], H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
};

export const AGENT_BADGES: Record<string, { initials: string; from: string; to: string; emoji: string }> = {
  "project-manager": { initials: "PM", from: "#f59e0b", to: "#ea580c", emoji: "🧭" },
  "software-architect": { initials: "SA", from: "#8b5cf6", to: "#4f46e5", emoji: "🏛" },
  "ui-ux-designer": { initials: "UX", from: "#ec4899", to: "#e11d48", emoji: "🎨" },
  "frontend-developer": { initials: "FE", from: "#0ea5e9", to: "#2563eb", emoji: "🖥" },
  "backend-developer": { initials: "BE", from: "#10b981", to: "#0d9488", emoji: "🗄" },
  "mobile-developer": { initials: "MD", from: "#06b6d4", to: "#0284c7", emoji: "📱" },
  "game-developer": { initials: "GD", from: "#d946ef", to: "#9333ea", emoji: "🎮" },
  "qa-engineer": { initials: "QA", from: "#84cc16", to: "#16a34a", emoji: "🧪" },
  "security-engineer": { initials: "SE", from: "#ef4444", to: "#be123c", emoji: "🛡" },
  "devops-engineer": { initials: "DO", from: "#f97316", to: "#dc2626", emoji: "🚀" },
  "executive-assistant": { initials: "EA", from: "#d97757", to: "#f0a35e", emoji: "✨" },
};

const hex = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf: Buffer) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

const cache = new Map<string, Buffer>();

export function agentAvatarPng(slug: string): Buffer {
  const hit = cache.get(slug);
  if (hit) return hit;
  const badge = AGENT_BADGES[slug] ?? { initials: slug.split("-").map(w => w[0] ?? "").join("").toUpperCase().slice(0, 2) || "AI", from: "#78716c", to: "#44403c", emoji: "🤖" };
  const S = 128, R = 62, c = S / 2;
  const [r1, g1, b1] = hex(badge.from), [r2, g2, b2] = hex(badge.to);
  const px = Buffer.alloc(S * S * 4);

  // Glyph mask (initials, 5×7 font scaled ×6, centred).
  const scale = 6, gw = 5 * scale, gh = 7 * scale, gap = scale;
  const letters = badge.initials.split("").filter(ch => FONT[ch]);
  const totalW = letters.length * gw + (letters.length - 1) * gap;
  const x0 = Math.round(c - totalW / 2), y0 = Math.round(c - gh / 2);
  const glyph = (x: number, y: number) => {
    if (y < y0 || y >= y0 + gh) return false;
    for (const [i, ch] of letters.entries()) {
      const lx = x - (x0 + i * (gw + gap));
      if (lx >= 0 && lx < gw) return FONT[ch][Math.floor((y - y0) / scale)][Math.floor(lx / scale)] === "1";
    }
    return false;
  };

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c);
      const alpha = Math.max(0, Math.min(1, R + 0.5 - d)); // anti-aliased edge
      const t = (x + y) / (2 * S);
      let r = r1 + (r2 - r1) * t, g = g1 + (g2 - g1) * t, b = b1 + (b2 - b1) * t;
      if (d > R - 4 && d <= R) { r = r * 0.8 + 255 * 0.2; g = g * 0.8 + 255 * 0.2; b = b * 0.8 + 255 * 0.2; } // subtle ring
      if (glyph(x, y)) { r = 255; g = 255; b = 255; }
      const o = (y * S + x) * 4;
      px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = Math.round(alpha * 255);
    }
  }
  const raw = Buffer.alloc((S * 4 + 1) * S);
  for (let y = 0; y < S; y++) { raw[y * (S * 4 + 1)] = 0; px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  cache.set(slug, png);
  return png;
}
