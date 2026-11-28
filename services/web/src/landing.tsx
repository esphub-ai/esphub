import { useState } from "react";
import {
  ArrowDownIcon,
  ArrowUpRightIcon,
  CaretDownIcon,
  FileTextIcon,
} from "@phosphor-icons/react";
import { BoardWall } from "./components/board-wall";
import { LandingDialog, type LandingView } from "./components/landing-dialog";
import type { Board } from "./components/board-photo";
import { agents, manufacturers } from "./components/landing-brands";
import logo from "./assets/esphub-logo-light.svg";
import "./landing.css";

const sprite = [
  "00010001000",
  "00011011000",
  "00111111100",
  "11121112111",
  "11111111111",
  "10111111101",
  "00101010100",
  "00101010100",
].join("");

function ConnectionDiagram() {
  return (
    <div className="hero-demo">
      <ul className="hardware-brands" aria-label="Hardware manufacturers">
        {manufacturers.map(({ id, name, logo }) => (
          <li className={`brand-plate ${id}`} key={id}>
            <img src={logo} alt={name} />
          </li>
        ))}
      </ul>
      <div className="mcp-label">
        <img src={logo} alt="EspHub" /> MCP
      </div>
      <i className="agent-lead" aria-hidden="true" />
      <div className="pixel-agent" role="img" aria-label="Coding agent">
        {Array.from(sprite, (pixel, i) => (
          <i className={pixel === "1" ? "on" : undefined} key={i} />
        ))}
      </div>
      <ul className="coding-agent-logos" aria-label="Coding agents">
        {agents.map(({ name, logo, monochrome }) => (
          <li key={name} title={name}>
            <img
              className={monochrome ? "invert" : undefined}
              src={logo}
              alt={name}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function scrollToWall(smooth: boolean) {
  document.getElementById("boards")?.scrollIntoView({
    behavior:
      smooth && !matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "smooth"
        : "instant",
  });
}

const pcbVias: [number, number][] = [
  [148, 88],
  [340, 124],
  [512, 96],
  [650, 56],
  [856, 92],
  [1090, 44],
  [1168, 212],
  [1130, 396],
  [1054, 454],
  [960, 454],
  [896, 490],
  [664, 534],
  [570, 526],
  [382, 564],
  [1332, 92],
  [1252, 212],
  [1222, 396],
];

const pcbActiveVias: [number, number][] = [
  [604, 132],
  [782, 490],
  [1372, 52],
  [1138, 92],
];

function HeroBackdrop() {
  return (
    <div className="hero-bg" aria-hidden="true">
      <svg
        className="hero-bg-svg"
        viewBox="0 0 1440 640"
        preserveAspectRatio="xMidYMid slice"
      >
        <defs>
          <pattern
            id="pcb-pitch"
            width="28"
            height="28"
            patternUnits="userSpaceOnUse"
          >
            <circle cx="14" cy="14" r="1.05" fill="#7c8f63" opacity="0.28" />
          </pattern>
          <radialGradient id="pcb-glow" cx="76%" cy="50%" r="48%">
            <stop offset="0%" stopColor="#c7f563" stopOpacity="0.11" />
            <stop offset="55%" stopColor="#4f6338" stopOpacity="0.04" />
            <stop offset="100%" stopColor="#10120f" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="pcb-mask-grad" cx="56%" cy="50%" r="64%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="72%" stopColor="#ffffff" stopOpacity="0.82" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0.22" />
          </radialGradient>
          <radialGradient id="pcb-copy-clear" cx="24%" cy="48%" r="34%">
            <stop offset="0%" stopColor="#000000" stopOpacity="0.82" />
            <stop offset="68%" stopColor="#000000" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#000000" stopOpacity="0" />
          </radialGradient>
          <mask id="pcb-mask">
            <rect width="1440" height="640" fill="url(#pcb-mask-grad)" />
            <rect width="1440" height="640" fill="url(#pcb-copy-clear)" />
          </mask>
        </defs>

        <rect width="1440" height="640" fill="url(#pcb-glow)" />

        <g mask="url(#pcb-mask)">
          <rect width="1440" height="640" fill="url(#pcb-pitch)" />

          <g
            fill="none"
            stroke="#6e8258"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity="0.46"
          >
            <path d="M 0 88 H 148 L 184 124 H 340 L 368 96 H 512" />
            <path d="M 0 104 H 136 L 176 144 H 322" />
            <path d="M 218 0 V 58 L 252 92 H 410" />
            <path d="M 468 0 V 64 L 504 100 H 632 L 664 132 V 210" />
          </g>

          <g
            fill="none"
            stroke="#7d9462"
            strokeWidth="1.25"
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity="0.54"
          >
            <path d="M 650 56 H 820 L 856 92 H 1090 L 1138 44 H 1440" />
            <path d="M 692 72 H 808 L 848 112 H 1042" />
            <path d="M 1440 168 H 1296 L 1252 212 H 1168" />
            <path d="M 1440 186 H 1308 L 1264 230 H 1196" />
            <path d="M 1440 442 H 1268 L 1222 396 H 1130" />
            <path d="M 1440 462 H 1256 L 1208 414 H 1094 L 1054 454 H 960" />
            <path d="M 1440 536 H 1188 L 1142 490 H 896 L 852 534 H 664" />
            <path d="M 1440 554 H 1174 L 1130 510 H 910" />
            <path d="M 760 640 V 548 L 802 506 H 866" />
            <path d="M 612 640 V 568 L 570 526 H 420 L 382 564 H 214" />
          </g>

          <g
            fill="none"
            stroke="#c7f563"
            strokeWidth="1.15"
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity="0.34"
          >
            <path d="M 1090 44 L 1138 92 H 1332 L 1372 52 H 1440" />
            <path d="M 664 534 L 708 490 H 782" />
            <path d="M 512 96 L 548 132 H 604" />
          </g>

          <g fill="#10120f" stroke="#8ea86d" strokeWidth="1.35" opacity="0.72">
            {pcbVias.map(([cx, cy], idx) => (
              <g key={idx}>
                <circle cx={cx} cy={cy} r="5.5" strokeOpacity="0.45" />
                <circle cx={cx} cy={cy} r="2.2" />
              </g>
            ))}
          </g>

          <g fill="#10120f" stroke="#c7f563" strokeWidth="1.3" opacity="0.68">
            {pcbActiveVias.map(([cx, cy], idx) => (
              <g key={idx}>
                <circle cx={cx} cy={cy} r="5.5" strokeOpacity="0.42" />
                <circle cx={cx} cy={cy} r="2" fill="#c7f563" />
              </g>
            ))}
          </g>

          <g fill="none" stroke="#73875d" strokeWidth="1" opacity="0.45">
            <rect
              x="1352"
              y="256"
              width="52"
              height="140"
              rx="2"
              strokeDasharray="3 3"
            />
            {[0, 1, 2, 3, 4, 5, 6].map((i) => (
              <g key={i}>
                <circle cx="1368" cy={272 + i * 18} r="3.4" />
                <circle cx="1388" cy={272 + i * 18} r="3.4" />
              </g>
            ))}
          </g>

          <g
            className="hero-bg-label"
            fill="#8ea374"
            fontFamily="JetBrains Mono Variable, monospace"
            fontSize="10"
            letterSpacing="0.08em"
            opacity="0.54"
          >
            <text x="518" y="88">OTA_0</text>
            <text x="656" y="48">U1 · ESP32-S3</text>
            <text x="1146" y="85" fill="#c7f563" opacity="0.76">
              2.4GHz RF
            </text>
            <text x="1348" y="248">J2 · GPIO</text>
            <text x="1192" y="528">3V3 / GND</text>
            <text x="670" y="526">MCP_BUS</text>
          </g>
        </g>
      </svg>
    </div>
  );
}

function Hero({
  total,
  open,
}: {
  total?: number;
  open: (view: LandingView) => void;
}) {
  return (
    <section className="wall-hero" aria-labelledby="hero-heading">
      <HeroBackdrop />
      <div className="hero-copy">
        <h1 id="hero-heading">
          Vibe OTA
          <br />
          your <em>ESP32.</em>
        </h1>
        <div className="hero-summary">
          <p>
            Give your coding agent the tools to program your ESP32 boards{" "}
            <strong>wirelessly</strong>.
          </p>
        </div>
        <div className="hero-actions">
          <button
            className="connect-trigger"
            onClick={() => open({ screen: "agents" })}
            aria-haspopup="dialog"
          >
            <span className="agent-stack" aria-hidden="true">
              {agents.slice(0, 3).map((a) => (
                <img key={a.name} src={a.logo} alt="" />
              ))}
            </span>
            Connect EspHub <CaretDownIcon aria-hidden="true" />
          </button>
          <button
            className="skill-trigger"
            onClick={() => open({ screen: "skill" })}
            aria-haspopup="dialog"
          >
            <FileTextIcon aria-hidden="true" />
            Read SKILL.md
          </button>
        </div>
      </div>
      <ConnectionDiagram />
      {!!total && (
        <a
          className="wall-jump"
          href="#boards"
          onClick={(event) => {
            event.preventDefault();
            scrollToWall(true);
          }}
        >
          <ArrowDownIcon aria-hidden="true" />
          Explore {total} boards
        </a>
      )}
    </section>
  );
}

export default function Landing({
  boards,
  failed,
}: {
  boards?: Board[];
  failed?: boolean;
}) {
  const [view, setView] = useState<LandingView | null>(null);
  return (
    <div className="landing">
      <a
        className="wall-skip"
        href="#boards"
        onClick={(event) => {
          event.preventDefault();
          scrollToWall(false);
          document.getElementById("boards")?.focus({ preventScroll: true });
        }}
      >
        Skip to the board wall
      </a>
      <header className="masthead">
        <div className="masthead-brand">
          <a href="/" aria-label="EspHub home">
            <img src={logo} alt="EspHub" width="109" height="31" />
          </a>
          <nav className="masthead-nav" aria-label="Primary">
            <a className="masthead-nav-link is-active" href="/" aria-current="page">
              Home
            </a>
            <a className="masthead-nav-link" href="/boards">
              Boards
            </a>
            <a className="masthead-nav-link" href="/projects">
              Projects
            </a>
          </nav>
        </div>
        <a className="workspace-link" href="/devices">
          Open workspace <ArrowUpRightIcon aria-hidden="true" />
        </a>
      </header>
      <main className="wall-story">
        <Hero open={setView} total={boards?.length} />
        <BoardWall boards={boards} paused={view !== null} />
        {!boards?.length && (
          <p role="status" className="wall-status">
            {failed
              ? "Board directory unavailable."
              : boards
                ? "No board photos available."
                : "Loading boards…"}
          </p>
        )}
      </main>
      <footer className="wall-footer">
        <nav aria-label="Legal">
          <a href="/terms/">Terms of Service</a>
          <a href="/privacy/">Privacy Policy</a>
        </nav>
      </footer>
      {view && (
        <LandingDialog
          view={view}
          setView={setView}
          onClose={() => setView(null)}
        />
      )}
    </div>
  );
}
