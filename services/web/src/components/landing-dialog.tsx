import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  CopyIcon,
  XIcon,
} from "@phosphor-icons/react";
import { mcpEndpoint } from "../../../../shared/identity.js";
import { agents } from "./landing-brands";
import skill from "../../public/SKILL.md?raw";

export type LandingView =
  | { screen: "agents" }
  | { screen: "prompt"; agent: string }
  | { screen: "skill" };

const setupPrompt = `Connect to EspHub at ${mcpEndpoint} using OAuth with CIMD and PKCE. Follow https://esphub.ai/SKILL.md. After I sign in, list my ESP32 devices.`;

export function LandingDialog({
  view,
  setView,
  onClose,
}: {
  view: LandingView;
  setView: (view: LandingView) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const prompt = useRef<HTMLTextAreaElement>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const { screen } = view;

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
      await navigator.clipboard.writeText(setupPrompt);
      setCopyStatus("Copied");
    } catch {
      prompt.current?.focus();
      prompt.current?.select();
      setCopyStatus("Prompt selected. Copy it to continue.");
    }
  }

  const title =
    screen === "agents"
      ? "Choose your coding agent"
      : screen === "skill"
        ? "SKILL.md"
        : "Connect EspHub";

  return (
    <dialog
      className="board-viewer"
      data-screen={screen}
      data-general
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
    >
      <div className="viewer-frame">
        <div className="viewer-copy">
          <div className="dialog-top">
            {screen === "prompt" && (
              <button
                className="back"
                onClick={() => setView({ screen: "agents" })}
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
              {screen === "skill" ? "EspHub" : "EspHub MCP"}
            </p>
            <h2
              ref={heading}
              id="viewer-title"
              tabIndex={-1}
              className={title.length > 19 ? "long" : undefined}
            >
              {title}
            </h2>
            {screen === "agents" && (
              <>
                <div className="agent-options">
                  {agents.map(({ name, logo }) => (
                    <button
                      key={name}
                      onClick={() => setView({ screen: "prompt", agent: name })}
                    >
                      <img src={logo} alt="" />
                      {name}
                    </button>
                  ))}
                </div>
                <button
                  className="secondary-link"
                  onClick={() =>
                    setView({ screen: "prompt", agent: "your coding agent" })
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
                  value={setupPrompt}
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
