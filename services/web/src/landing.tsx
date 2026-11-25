import { useEffect, useRef, useState } from "react";
import { mcpEndpoint } from "../../../shared/identity.js";
import {
  CaretDownIcon,
  ArrowUpRightIcon,
  CheckIcon,
  CopyIcon,
  FileTextIcon,
} from "@phosphor-icons/react";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

import antigravityLogo from "./assets/agents/antigravity-color.svg";
import claudeLogo from "./assets/agents/claude-color.svg";
import codexLogo from "./assets/agents/codex-color.svg";
import cursorLogo from "./assets/agents/cursor.svg";
import grokLogo from "./assets/agents/grok.svg";
import hermesLogo from "./assets/agents/hermes.png";
import museLogo from "./assets/agents/muse-color.svg";
import openClawLogo from "./assets/agents/openclaw-color.svg";
import logo from "./assets/esphub-logo-light.svg";
import { BoardPhoto, type Board } from "./components/board-photo";
import skill from "../public/SKILL.md?raw";

const setup = `Connect to EspHub at ${mcpEndpoint} using OAuth with CIMD and PKCE. Follow https://esphub.ai/SKILL.md. After I sign in, list my ESP32 devices.`;
const featuredAgents = [
  { name: "Claude Code", logo: claudeLogo },
  { name: "Codex", logo: codexLogo },
  { name: "Antigravity", logo: antigravityLogo },
];
const agents: { name: string; logo: string; monochrome?: boolean }[] = [
  ...featuredAgents,
  { name: "Cursor", logo: cursorLogo, monochrome: true },
  { name: "Grok Bot", logo: grokLogo, monochrome: true },
  { name: "Muse", logo: museLogo },
  { name: "Hermes", logo: hermesLogo },
  { name: "OpenClaw", logo: openClawLogo },
];
function SkillDialog() {
  return (
    <Dialog>
      <DialogTrigger render={<Button variant="ghost" />}>
        <FileTextIcon aria-hidden="true" data-icon="inline-start" />
        Read SKILL.md
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>EspHub SKILL.md</DialogTitle>
          <DialogDescription>
            Setup instructions for coding agents.
          </DialogDescription>
        </DialogHeader>
        <pre
          className="max-h-[55dvh] overflow-auto whitespace-pre-wrap break-words border bg-muted p-3 text-xs"
          tabIndex={0}
        >
          {skill}
        </pre>
        <a
          className={buttonVariants({ variant: "outline" })}
          href="/SKILL.md"
          download="SKILL.md"
        >
          Download Markdown
        </a>
      </DialogContent>
    </Dialog>
  );
}

function ConnectMenu() {
  const [agent, setAgent] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const field = useRef<HTMLElement>(null);

  function choose(name: string) {
    setCopied(false);
    setAgent(name);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(setup);
      setCopied(true);
    } catch {
      if (!field.current) return;
      const range = document.createRange();
      range.selectNodeContents(field.current);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="outline"
              size="lg"
              className="h-11 gap-2.5 px-3 text-sm has-data-[icon=inline-end]:pr-3"
            />
          }
        >
          <span
            aria-hidden="true"
            className="isolate flex shrink-0 -space-x-1.5"
          >
            {featuredAgents.map(({ name, logo }) => (
              <span
                key={name}
                className="grid size-6 place-items-center rounded-full border border-border bg-background"
              >
                <img src={logo} alt="" width={14} height={14} />
              </span>
            ))}
          </span>
          Connect EspHub
          <CaretDownIcon aria-hidden="true" data-icon="inline-end" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-52">
          {agents.map(({ name, logo, monochrome }) => (
            <DropdownMenuItem key={name} onClick={() => choose(name)}>
              <img
                src={logo}
                alt=""
                width={16}
                height={16}
                className={monochrome ? "invert" : undefined}
              />
              {name}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => choose("your coding agent")}>
            <CopyIcon aria-hidden="true" />
            Setup for any agent
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog
        open={agent !== null}
        onOpenChange={(open) => {
          if (!open) setAgent(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect EspHub</DialogTitle>
            <DialogDescription>
              Paste this prompt into {agent}. The agent will guide you through
              MCP setup.
            </DialogDescription>
          </DialogHeader>
          <code ref={field} className="break-words border bg-muted p-3 text-xs">
            {setup}
          </code>
          <Button onClick={copy}>
            {copied ? (
              <CheckIcon aria-hidden="true" data-icon="inline-start" />
            ) : (
              <CopyIcon aria-hidden="true" data-icon="inline-start" />
            )}
            {copied ? "Copied" : "Copy prompt"}
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Hero() {
  return (
    <div className="w-full">
      <h1 className="text-3xl leading-tight font-semibold tracking-tighter text-balance md:text-5xl xl:text-6xl">
        Vibe OTA
        <br />
        your <span className="text-lime-300">ESP32.</span>
      </h1>
      <p className="mt-2 max-w-lg text-sm text-balance text-muted-foreground sm:mt-3 sm:text-base">
        Give your coding agent the tools to program your ESP32 boards{" "}
        <strong className="font-semibold text-lime-300">wirelessly</strong>.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 sm:mt-6">
        <ConnectMenu />
        <SkillDialog />
      </div>
    </div>
  );
}

const coverPositions = [
  "pointer-events-none z-0 -translate-x-[118%] -translate-z-36 rotate-y-[62deg] opacity-0",
  "z-0 -translate-x-[88%] -translate-z-32 rotate-y-[60deg] opacity-40",
  "z-10 -translate-x-[56%] -translate-z-24 rotate-y-[50deg] opacity-80",
  "z-20 translate-z-0 rotate-y-0 opacity-100",
  "z-10 translate-x-[56%] -translate-z-24 -rotate-y-[50deg] opacity-80",
  "z-0 translate-x-[88%] -translate-z-32 -rotate-y-[60deg] opacity-40",
  "pointer-events-none z-0 translate-x-[118%] -translate-z-36 -rotate-y-[62deg] opacity-0",
];

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

function AgentConnection() {
  return (
    <div
      className="flex flex-col items-center"
      aria-label="Your agent connects through EspHub MCP to ESP32 boards"
      role="img"
    >
      <div
        aria-hidden="true"
        className="grid grid-cols-11 motion-safe:animate-bounce"
      >
        {Array.from(sprite, (pixel, index) => (
          <span
            key={index}
            className={`size-1 md:size-1.25 ${pixel === "1" ? "bg-lime-300" : pixel === "2" ? "bg-zinc-950" : ""}`}
          />
        ))}
      </div>
      <div
        aria-hidden="true"
        className="h-2 border-l border-dashed border-lime-300/60 md:h-3"
      />
      <Badge variant="outline" className="px-1.5" aria-hidden="true">
        <img src={logo} alt="" width={54} height={15} />
        MCP
      </Badge>
      <div
        aria-hidden="true"
        className="h-2 border-l border-dashed border-lime-300/60 md:h-3"
      />
      <div
        aria-hidden="true"
        className="flex h-2 w-2/3 justify-between border-t border-dashed border-lime-300/50 md:h-3"
      >
        {[0, 1, 2].map((index) => (
          <span
            key={index}
            className="border-l border-dashed border-lime-300/50"
          />
        ))}
      </div>
    </div>
  );
}

function BoardPicker({
  boards,
  select,
  open,
  onOpenChange,
}: {
  boards: Board[];
  select: (index: number) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>ESP32 boards</DialogTitle>
          <DialogDescription>
            Choose a board to bring it to the front of the gallery.
          </DialogDescription>
        </DialogHeader>
        <div className="grid max-h-[64dvh] grid-cols-2 gap-2 overflow-y-auto p-1 sm:grid-cols-4">
          {boards.map(({ id, image_url }, index) => (
            <Button
              key={id}
              variant="outline"
              onClick={() => {
                select(index);
                onOpenChange(false);
              }}
              className="h-auto min-w-0 flex-col gap-1 p-2 whitespace-normal"
            >
              <BoardPhoto
                className="aspect-square w-14 object-cover"
                imageUrl={image_url}
                width={400}
                height={400}
                loading="lazy"
              />
              <span className="w-full break-words text-center text-xs">
                {id}
              </span>
            </Button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CoverFlow({ boards }: { boards: Board[] }) {
  const [active, setActive] = useState(0);
  const [playing, setPlaying] = useState(
    () => !matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [hovered, setHovered] = useState(false);
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  const [pointing, setPointing] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [pageVisible, setPageVisible] = useState(() => !document.hidden);
  const dragStart = useRef<number | null>(null);
  const dragged = useRef(false);
  const count = boards.length;
  const half = Math.floor(count / 2);

  useEffect(() => {
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const onMotionChange = () => {
      if (motion.matches) setPlaying(false);
    };
    const onVisibilityChange = () => setPageVisible(!document.hidden);
    motion.addEventListener("change", onMotionChange);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      motion.removeEventListener("change", onMotionChange);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    if (
      !playing ||
      hovered ||
      keyboardFocus ||
      pointing ||
      browsing ||
      !pageVisible
    )
      return;
    const timer = window.setTimeout(
      () => setActive((active + 1) % count),
      3500,
    );
    return () => window.clearTimeout(timer);
  }, [
    active,
    count,
    playing,
    hovered,
    keyboardFocus,
    pointing,
    browsing,
    pageVisible,
  ]);

  function advance(direction: number) {
    setActive((current) => (current + direction + count) % count);
  }

  return (
    <section
      className="mx-auto w-full min-w-0 max-w-2xl"
      aria-label="Board gallery"
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") setHovered(true);
      }}
      onPointerLeave={() => {
        setHovered(false);
        setPointing(false);
        dragStart.current = null;
      }}
      onFocusCapture={(event) =>
        setKeyboardFocus(event.target.matches(":focus-visible"))
      }
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setKeyboardFocus(false);
      }}
    >
      <AgentConnection />
      <div
        tabIndex={0}
        aria-label="Board covers"
        aria-description="Use the arrow keys to switch boards or Space to toggle autoplay."
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            advance(event.key === "ArrowLeft" ? -1 : 1);
          } else if (
            event.key === " " &&
            event.target === event.currentTarget
          ) {
            event.preventDefault();
            setPlaying((value) => !value);
          }
        }}
        className="relative isolate grid touch-pan-y place-items-center overflow-hidden pt-0.5 pb-[min(13.5%,5.75dvh)] perspective-[850px] focus-visible:outline-ring md:pb-[min(15%,10.25dvh)] [mask-image:linear-gradient(to_right,transparent,black_14%,black_86%,transparent)]"
        onPointerDown={(event) => {
          dragged.current = false;
          setPointing(true);
          dragStart.current = event.isPrimary ? event.clientX : null;
        }}
        onPointerCancel={() => {
          dragStart.current = null;
          setPointing(false);
        }}
        onPointerUp={(event) => {
          setPointing(false);
          if (dragStart.current === null) return;
          const distance = event.clientX - dragStart.current;
          dragStart.current = null;
          if (Math.abs(distance) < 36) return;
          dragged.current = true;
          advance(distance < 0 ? 1 : -1);
        }}
      >
        {boards.map(({ id, image_url }, index) => {
          const offset = ((index - active + count + half) % count) - half;
          const selected = offset === 0;
          if (Math.abs(offset) > 3) return null;
          const visible = Math.abs(offset) <= 2;
          const position = coverPositions[offset + 3];
          const [group, project] = id.split("/");
          return (
            <button
              key={id}
              type="button"
              aria-label={
                selected ? `Browse boards, current board ${id}` : `Show ${id}`
              }
              aria-current={selected || undefined}
              aria-hidden={!visible}
              tabIndex={selected ? 0 : -1}
              onClick={(event) => {
                if (event.detail !== 0 && dragged.current) return;
                if (selected) setBrowsing(true);
                else setActive(index);
              }}
              className={`group relative col-start-1 row-start-1 aspect-square w-[min(54%,23dvh)] cursor-pointer p-0 select-none transition-[transform,translate,opacity] duration-[560ms] ease-[cubic-bezier(0.22,0.72,0.24,1)] focus-visible:outline-2 focus-visible:outline-white motion-reduce:transition-none md:w-[min(60%,41dvh)] ${position}`}
            >
              <span
                className={`relative block size-full overflow-hidden bg-muted ${selected ? "shadow-xl shadow-black/55" : ""}`}
              >
                <BoardPhoto
                  imageUrl={image_url}
                  className="size-full object-cover"
                  width={400}
                  height={400}
                  draggable={false}
                />
                <span
                  aria-hidden={!selected}
                  className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/55 to-transparent px-2 pt-6 pb-2 text-left text-xs leading-tight text-white transition-opacity duration-200 motion-reduce:transition-none md:px-3 md:pt-9 md:pb-3 md:text-sm ${selected ? "opacity-100" : "opacity-0"}`}
                >
                  <span className="block text-zinc-300">{group}</span>
                  <span className="block font-semibold">{project}</span>
                </span>
              </span>
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 top-full h-1/4 overflow-hidden opacity-20 [mask-image:linear-gradient(to_bottom,black,transparent)]"
              >
                <BoardPhoto
                  imageUrl={image_url}
                  className="absolute top-0 aspect-square w-full -scale-y-100 object-cover"
                  width={400}
                  height={400}
                  draggable={false}
                />
              </span>
            </button>
          );
        })}
      </div>
      <span
        className="sr-only"
        aria-live={!playing || keyboardFocus ? "polite" : "off"}
      >
        {boards[active].id}
      </span>
      <BoardPicker
        boards={boards}
        select={setActive}
        open={browsing}
        onOpenChange={setBrowsing}
      />
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
  return (
    <div className="mx-auto grid min-h-dvh max-w-7xl grid-rows-[auto_1fr_auto] px-4 sm:px-6 lg:px-8">
      <header className="flex items-center justify-between gap-3 border-b py-3 sm:py-4">
        <a href="/" aria-label="EspHub home">
          <img src={logo} alt="EspHub" width={106} height={30} />
        </a>
        <a
          className={buttonVariants({ variant: "outline", size: "sm" })}
          href="/devices"
        >
          Open workspace{" "}
          <ArrowUpRightIcon aria-hidden="true" data-icon="inline-end" />
        </a>
      </header>
      <main className="grid min-w-0 content-center items-center gap-4 py-3 sm:py-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] md:gap-6 lg:gap-10">
        <Hero />
        {boards?.length ? (
          <CoverFlow boards={boards} />
        ) : (
          <div>
            <AgentConnection />
            <p
              role="status"
              className="text-center text-sm text-muted-foreground"
            >
              {failed
                ? "Board directory unavailable."
                : boards
                  ? "No boards available."
                  : "Loading boards…"}
            </p>
          </div>
        )}
      </main>
      <footer className="flex flex-wrap items-center gap-x-3 border-t py-1">
        <a
          className={buttonVariants({ variant: "link", size: "xs" })}
          href="/terms/"
        >
          Terms of Service
        </a>
        <a
          className={buttonVariants({ variant: "link", size: "xs" })}
          href="/privacy/"
        >
          Privacy Policy
        </a>
      </footer>
    </div>
  );
}
