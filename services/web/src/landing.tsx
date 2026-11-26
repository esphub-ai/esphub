import { useLayoutEffect, useRef, useState, type RefObject } from "react";
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

function scrollToWall(stage: HTMLElement, smooth: boolean) {
  const distance = stage.parentElement!.offsetHeight - stage.offsetHeight;
  window.scrollTo({
    top: distance,
    behavior:
      smooth && !matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "smooth"
        : "instant",
  });
}

function Hero({
  total,
  open,
  stage,
}: {
  total?: number;
  open: (view: LandingView) => void;
  stage: RefObject<HTMLDivElement | null>;
}) {
  const hero = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const element = hero.current!;
    const wall = element.closest<HTMLElement>(".wall-stage")!;
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    let distance = 1;
    let frame = 0;
    let lastProgress = -1;
    function paint() {
      frame = 0;
      const t = Math.min(1, Math.max(0, window.scrollY / distance));
      const progress = motion.matches ? Number(t >= 0.5) : t * t * (3 - 2 * t);
      if (progress === lastProgress) return;
      lastProgress = progress;
      element.style.setProperty("--progress", String(progress));
      element.toggleAttribute("data-compact", progress > 0.55);
      element.toggleAttribute("data-docked", t === 1);
    }
    function onScroll() {
      if (!frame) frame = requestAnimationFrame(paint);
    }
    function measure() {
      distance = Math.max(
        1,
        wall.parentElement!.offsetHeight - wall.offsetHeight,
      );
      paint();
    }
    const resize = new ResizeObserver(measure);
    resize.observe(wall.parentElement!);
    resize.observe(wall);
    window.addEventListener("scroll", onScroll, { passive: true });
    motion.addEventListener("change", paint);
    measure();
    if (location.hash === "#boards") scrollToWall(wall, false);
    return () => {
      window.removeEventListener("scroll", onScroll);
      motion.removeEventListener("change", paint);
      resize.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [stage]);

  return (
    <article className="wall-hero" ref={hero} aria-labelledby="hero-heading">
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
            scrollToWall(stage.current!, true);
          }}
        >
          <ArrowDownIcon aria-hidden="true" />
          Explore {total} boards
        </a>
      )}
    </article>
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
  const stage = useRef<HTMLDivElement>(null);
  return (
    <div className="landing">
      <a
        className="wall-skip"
        href="#boards"
        onClick={(event) => {
          event.preventDefault();
          scrollToWall(stage.current!, false);
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
        <div className="wall-stage" ref={stage}>
          <BoardWall
            boards={boards}
            paused={view !== null}
            onSelect={(board) => setView({ screen: "product", board })}
            onTileFocus={(tile) => {
              const hero = stage
                .current!.querySelector(".wall-hero")!
                .getBoundingClientRect();
              const card = tile.getBoundingClientRect();
              if (
                card.left < hero.right &&
                card.top < hero.bottom &&
                card.bottom > hero.top
              )
                scrollToWall(stage.current!, false);
            }}
            hero={<Hero stage={stage} open={setView} total={boards?.length} />}
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
        </div>
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
