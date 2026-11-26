import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpRightIcon,
  CheckIcon,
  CopyIcon,
  XIcon,
} from "@phosphor-icons/react";
import { mcpEndpoint } from "../../../../shared/identity.js";
import { BoardPhoto, type Board } from "./board-photo";
import { agents, manufacturer } from "./landing-brands";
import skill from "../../public/SKILL.md?raw";

export type LandingView =
  | { screen: "product"; board: Board }
  | { screen: "agents"; board?: Board }
  | { screen: "prompt"; board?: Board; agent: string }
  | { screen: "skill"; board?: undefined };

const setup = `Connect to EspHub at ${mcpEndpoint} using OAuth with CIMD and PKCE. Follow https://esphub.ai/SKILL.md. After I sign in, list my ESP32 devices.`;
function setupPrompt(board?: Board) {
  if (!board) return setup;
  return `My board is the ${board.model} (${board.id}). Help me connect it to my coding agent.\n\n${setup} If my board is already registered, check whether it is online. Otherwise, guide me through first-time USB setup for ${board.id}. Ask me before erasing data or flashing firmware, then verify that the board is online.`;
}

export function LandingDialog({
  view,
  setView,
  boards,
  onClose,
}: {
  view: LandingView;
  setView: (view: LandingView) => void;
  boards: Board[];
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const prompt = useRef<HTMLTextAreaElement>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const { board, screen } = view;
  const position = board ? boards.findIndex((b) => b.id === board.id) : -1;
  function step(direction: number) {
    setView({
      screen: "product",
      board: boards[(position + direction + boards.length) % boards.length],
    });
  }
  useLayoutEffect(() => {
    const popup = dialog.current!;
    popup.showModal();
    return () => popup.close();
  }, []);
  useLayoutEffect(() => {
    dialog.current!.scrollTop = 0;
    heading.current?.focus({ preventScroll: true });
  }, [view]);
  useEffect(() => {
    setCopyStatus("");
  }, [view]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(setupPrompt(board));
      setCopyStatus("Copied");
    } catch {
      prompt.current?.focus();
      prompt.current?.select();
      setCopyStatus("Prompt selected. Copy it to continue.");
    }
  }
  const title =
    screen === "product"
      ? board!.name
      : screen === "agents"
        ? "Choose your coding agent"
        : screen === "skill"
          ? "SKILL.md"
          : "Connect EspHub";
  return (
    <dialog
      className="board-viewer"
      data-screen={screen}
      data-general={!board || undefined}
      ref={dialog}
      aria-labelledby="viewer-title"
      onClose={onClose}
      onClick={(event) => {
        if (event.target !== dialog.current) return;
        const rect = dialog.current!.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          dialog.current!.close();
      }}
      onKeyDown={(event) => {
        if (screen !== "product" || boards.length < 2) return;
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          step(event.key === "ArrowLeft" ? -1 : 1);
        }
      }}
    >
      <div className="viewer-frame">
        {board && (
          <div className="product-plate">
            <BoardPhoto
              className="product-photo"
              size="detail"
              imageUrl={board.image_url}
              alt={board.model}
            />
            {screen === "product" && boards.length > 1 && (
              <div className="plate-nav">
                <button onClick={() => step(-1)} aria-label="Previous board">
                  <ArrowLeftIcon />
                </button>
                <span>
                  {position + 1} / {boards.length}
                </span>
                <button onClick={() => step(1)} aria-label="Next board">
                  <ArrowRightIcon />
                </button>
              </div>
            )}
          </div>
        )}
        <div className="viewer-copy">
          <div className="dialog-top">
            {(screen === "prompt" || (screen === "agents" && board)) && (
              <button
                className="back"
                onClick={() =>
                  setView(
                    screen === "prompt"
                      ? { screen: "agents", board }
                      : { screen: "product", board: board! },
                  )
                }
              >
                <ArrowLeftIcon /> Back
              </button>
            )}
            <button
              className="dismiss"
              aria-label="Close"
              onClick={() => dialog.current!.close()}
            >
              <XIcon />
            </button>
          </div>
          <div className="viewer-inner">
            <p className="viewer-context">
              {board
                ? screen === "product"
                  ? manufacturer(board.id)
                  : board.model
                : screen === "skill"
                  ? "EspHub"
                  : "EspHub MCP"}
            </p>
            <h2
              ref={heading}
              id="viewer-title"
              tabIndex={-1}
              className={title.length > 19 ? "long" : undefined}
            >
              {title}
            </h2>
            {screen === "product" && board && (
              <>
                <dl className="specs">
                  <div>
                    <dt>Chip</dt>
                    <dd>
                      {board.chip
                        .toUpperCase()
                        .replace(/^ESP32([A-Z])/, "ESP32-$1")}
                    </dd>
                  </div>
                  <div>
                    <dt>Flash</dt>
                    <dd>{board.flash_mb} MB</dd>
                  </div>
                </dl>
                <div className="ownership">
                  <p>Already have this board?</p>
                  <button
                    className="primary-action"
                    onClick={() => setView({ screen: "agents", board })}
                  >
                    Connect to my coding agent <ArrowRightIcon />
                  </button>
                  {board.product_url && (
                    <a
                      className="secondary-link"
                      href={board.product_url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Product page <ArrowUpRightIcon />
                    </a>
                  )}
                </div>
              </>
            )}
            {screen === "agents" && (
              <>
                <div className="agent-options">
                  {agents.map(({ name, logo }) => (
                    <button
                      key={name}
                      onClick={() =>
                        setView({ screen: "prompt", board, agent: name })
                      }
                    >
                      <img src={logo} alt="" />
                      {name}
                    </button>
                  ))}
                </div>
                <button
                  className="secondary-link"
                  onClick={() =>
                    setView({
                      screen: "prompt",
                      board,
                      agent: "your coding agent",
                    })
                  }
                >
                  Setup for any agent <ArrowRightIcon />
                </button>
              </>
            )}
            {view.screen === "prompt" && (
              <>
                <p className="prompt-help">
                  Paste this prompt into {view.agent}. Your agent will guide you
                  through setup.
                </p>
                <textarea
                  ref={prompt}
                  aria-label="Setup prompt"
                  readOnly
                  value={setupPrompt(board)}
                />
                <button className="primary-action" onClick={copy}>
                  {copyStatus === "Copied" ? (
                    <>
                      Copied <CheckIcon />
                    </>
                  ) : (
                    <>
                      Copy prompt <CopyIcon />
                    </>
                  )}
                </button>
                <p className="copy-status" role="status">
                  {copyStatus}
                </p>
              </>
            )}
            {screen === "skill" && (
              <>
                <pre className="skill-text" tabIndex={0}>
                  {skill}
                </pre>
                <a
                  className="secondary-link"
                  href="/SKILL.md"
                  download="SKILL.md"
                >
                  Download Markdown <ArrowRightIcon />
                </a>
              </>
            )}
          </div>
        </div>
      </div>
    </dialog>
  );
}
