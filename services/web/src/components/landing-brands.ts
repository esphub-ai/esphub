import antigravity from "../assets/agents/antigravity-color.svg";
import claude from "../assets/agents/claude-color.svg";
import codex from "../assets/agents/codex-color.svg";
import cursor from "../assets/agents/cursor.svg";
import grok from "../assets/agents/grok.svg";
import hermes from "../assets/agents/hermes.png";
import muse from "../assets/agents/muse-color.svg";
import openclaw from "../assets/agents/openclaw-color.svg";
import espressif from "../assets/manufacturers/espressif.svg";
import lilygo from "../assets/manufacturers/lilygo.webp";
import m5stack from "../assets/manufacturers/m5stack.svg";
import seeed from "../assets/manufacturers/seeed-studio.webp";
import waveshare from "../assets/manufacturers/waveshare.webp";

export const agents = [
  { name: "Claude Code", logo: claude },
  { name: "Codex", logo: codex },
  { name: "Antigravity", logo: antigravity },
  { name: "Cursor", logo: cursor, monochrome: true },
  { name: "Grok Bot", logo: grok, monochrome: true },
  { name: "Muse", logo: muse },
  { name: "Hermes", logo: hermes },
  { name: "OpenClaw", logo: openclaw },
];
export const manufacturers = [
  { id: "seeed-studio", name: "Seeed Studio", logo: seeed },
  { id: "m5stack", name: "M5Stack", logo: m5stack },
  { id: "espressif", name: "Espressif", logo: espressif },
  { id: "lilygo", name: "LILYGO", logo: lilygo },
  { id: "waveshare", name: "Waveshare", logo: waveshare },
];
export function manufacturer(id: string) {
  const group = id.split("/")[0];
  return manufacturers.find((item) => item.id === group)?.name ?? group;
}
