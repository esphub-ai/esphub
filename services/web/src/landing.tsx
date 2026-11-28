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

function Hero({
  total,
  open,
}: {
  total?: number;
  open: (view: LandingView) => void;
}) {
  return (
    <section className="wall-hero" aria-labelledby="hero-heading">
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
        <a href="/" aria-label="EspHub home">
          <img src={logo} alt="EspHub" width="109" height="31" />
        </a>
        <a className="workspace-link" href="/devices">
          Open workspace <ArrowUpRightIcon aria-hidden="true" />
        </a>
      </header>
      <main className="wall-story">
        <Hero open={setView} total={boards?.length} />
        <BoardWall
          boards={boards}
          paused={view !== null}
          onSelect={(board) => setView({ screen: "product", board })}
        />
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
          boards={boards ?? []}
          onClose={() => setView(null)}
        />
      )}
    </div>
  );
}
