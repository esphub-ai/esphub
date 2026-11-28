import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpRightIcon,
  CheckIcon,
  CopyIcon,
  GitBranchIcon,
  MagnifyingGlassIcon,
  RowsIcon,
  SquaresFourIcon,
  TerminalWindowIcon,
  XIcon,
} from "@phosphor-icons/react";
import { mcpEndpoint } from "../../../shared/identity.js";
import { BoardPhoto, type BoardSpec } from "./components/board-photo";
import { agents, manufacturer } from "./components/landing-brands";
import logo from "./assets/esphub-logo-light.svg";
import "./boards-page.css";

type DirectoryBoard = {
  id: string;
  vendor: string;
  name: string;
  model: string;
  bootloader: string;
  spec: BoardSpec;
  product_url: string | null;
  preview: boolean;
  image_url: string | null;
  firmware?: {
    bootloader?: {
      id: string;
      version: string;
    };
  };
};

type ProjectBoardRef = {
  board_id: string;
  version: string;
  sdk_version: string;
  updated_at: string;
};

type PublicProject = {
  id: string;
  name: string;
  description: string;
  repo_url: string | null;
  repo_path: string | null;
  cover_image_url: string | null;
  boards: ProjectBoardRef[];
  created_at: string;
  updated_at: string;
};

function formatSoc(soc: string): string {
  return soc.toUpperCase().replace(/^ESP32([A-Z])/, "ESP32-$1");
}

function formatConsole(consoleType: BoardSpec["console"]): string {
  return consoleType === "usb-serial-jtag" ? "USB-JTAG" : "UART";
}

function formatPsram(psram: BoardSpec["psram"]): string {
  if (!psram) return "None";
  return psram === "octal" ? "Octal PSRAM" : "Quad PSRAM";
}

function projectSourceUrl(project: PublicProject): string | null {
  if (!project.repo_url) return null;
  if (!project.repo_path) return project.repo_url;
  return `${project.repo_url.replace(/\/$/, "")}/tree/main/${project.repo_path}`;
}

function shortRepoLabel(project: PublicProject): string {
  if (!project.repo_url) return "Published on EspHub";
  const repo = project.repo_url.replace(/^https:\/\/github\.com\//, "");
  return project.repo_path ? `${repo} · ${project.repo_path}` : repo;
}

function formatShortDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
    }).format(new Date(iso));
  } catch {
    return "";
  }
}

export function parseBoardsPath(pathname: string): string | null {
  const clean = pathname.replace(/\/+$/, "") || "/";
  const match = /^\/boards\/([a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(clean);
  return match ? match[1] : null;
}

type PromptModalState =
  | { kind: "connect"; board: DirectoryBoard }
  | {
      kind: "ota";
      board: DirectoryBoard;
      project: PublicProject;
      ref: ProjectBoardRef;
    };

function buildModalPrompt(modal: PromptModalState): string {
  if (modal.kind === "connect") {
    return `My board is the ${modal.board.model} (${modal.board.id}). Help me connect it to my coding agent.\n\nConnect to EspHub at ${mcpEndpoint} using OAuth with CIMD and PKCE. Follow https://esphub.ai/SKILL.md. After I sign in, list my ESP32 devices. If my board is already registered, check whether it is online. Otherwise, guide me through first-time USB setup for ${modal.board.id} (flash the bootloader and Wi-Fi config first, recover Wi-Fi over USB or BLE if offline, then suggest starter projects to install over wireless OTA once online). Ask me before erasing data or flashing firmware.`;
  }
  return `Install "${modal.project.name}" on my ${modal.board.model} (${modal.board.id}) over wireless OTA using EspHub MCP (${mcpEndpoint}).\n\n1. Check devices_list for my ${modal.board.id} device (or guide me through first-time USB setup per https://esphub.ai/SKILL.md if not bound yet).\n2. Call projects_get with project_id="${modal.project.id}" to retrieve the release for ${modal.board.id}.\n3. Enter Bootloader mode with bootloader_enter and verify online=true and info.role=bootloader via devices_get.\n4. Call ota_install with kind="app" using the returned release URL for ${modal.board.id}, follow commands_get, and confirm the running firmware after reboot.`;
}

function AgentPromptModal({
  modal,
  onClose,
}: {
  modal: PromptModalState;
  onClose: () => void;
}) {
  const [selectedAgent, setSelectedAgent] = useState(agents[0].name);
  const [copied, setCopied] = useState(false);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const promptText = buildModalPrompt(modal);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(promptText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      fieldRef.current?.focus();
      fieldRef.current?.select();
    }
  }

  return (
    <div
      className="bh-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bh-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bh-modal">
        <div className="bh-modal-top">
          <div>
            <p className="bh-modal-eyebrow">
              {modal.kind === "connect"
                ? `${manufacturer(modal.board.id)} · First-time setup`
                : `Wireless OTA · ${modal.board.id}`}
            </p>
            <h2 id="bh-modal-title" className="bh-modal-title">
              {modal.kind === "connect"
                ? `Connect ${modal.board.name}`
                : `Install ${modal.project.name}`}
            </h2>
          </div>
          <button
            type="button"
            className="bh-modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            <XIcon size={18} />
          </button>
        </div>

        <div className="bh-modal-agents">
          {agents.slice(0, 4).map((a) => (
            <button
              key={a.name}
              type="button"
              className={`bh-modal-agent-btn${selectedAgent === a.name ? " is-selected" : ""}`}
              onClick={() => setSelectedAgent(a.name)}
            >
              <img src={a.logo} alt="" />
              <span>{a.name}</span>
            </button>
          ))}
        </div>

        <p style={{ fontSize: 13.5, color: "#4d5744", marginBottom: 10 }}>
          Paste this prompt into <strong>{selectedAgent}</strong> to run it via EspHub
          MCP:
        </p>

        <textarea
          ref={fieldRef}
          className="bh-modal-textarea"
          aria-label="Agent prompt"
          readOnly
          value={promptText}
        />

        <button type="button" className="bh-modal-copy-btn" onClick={copy}>
          <span>
            {copied ? "Copied" : `Copy prompt for ${selectedAgent}`}
          </span>
          {copied ? <CheckIcon size={18} /> : <CopyIcon size={18} />}
        </button>
      </div>
    </div>
  );
}

function BoardDetailView({
  board,
  allBoards,
  boardProjects,
  onNavigate,
  onOpenModal,
}: {
  board: DirectoryBoard;
  allBoards: DirectoryBoard[];
  boardProjects: { project: PublicProject; ref: ProjectBoardRef }[];
  onNavigate: (boardId: string | null) => void;
  onOpenModal: (modal: PromptModalState) => void;
}) {
  const [copiedId, setCopiedId] = useState(false);
  const [projQuery, setProjQuery] = useState("");

  useEffect(() => {
    setProjQuery("");
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [board.id]);

  const idx = allBoards.findIndex((b) => b.id === board.id);
  const prevBoard =
    idx >= 0 ? allBoards[(idx - 1 + allBoards.length) % allBoards.length] : null;
  const nextBoard = idx >= 0 ? allBoards[(idx + 1) % allBoards.length] : null;

  const filteredProjects = useMemo(() => {
    const q = projQuery.trim().toLowerCase();
    if (!q) return boardProjects;
    return boardProjects.filter(
      ({ project, ref }) =>
        project.name.toLowerCase().includes(q) ||
        project.description.toLowerCase().includes(q) ||
        (project.repo_path ?? "").toLowerCase().includes(q) ||
        ref.version.toLowerCase().includes(q),
    );
  }, [boardProjects, projQuery]);

  async function copyBoardId() {
    try {
      await navigator.clipboard.writeText(board.id);
      setCopiedId(true);
      setTimeout(() => setCopiedId(false), 1600);
    } catch {}
  }

  function handleNavLink(e: MouseEvent<HTMLAnchorElement>, targetId: string | null) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    onNavigate(targetId);
  }

  const bl = board.firmware?.bootloader;

  return (
    <main className="bh-detail-shell">
      <div className="bh-breadcrumb-bar">
        <div className="bh-breadcrumb">
          <a
            className="bh-back-btn"
            href="/boards"
            onClick={(e) => handleNavLink(e, null)}
          >
            <ArrowLeftIcon size={14} /> All boards
          </a>
          <span className="bh-crumb-trail">
            Boards / {manufacturer(board.id)} /{" "}
          </span>
          <span className="bh-crumb-trail bh-crumb-current">{board.name}</span>
        </div>
        {prevBoard && nextBoard && allBoards.length > 1 && (
          <div className="bh-detail-nav">
            <a
              href={`/boards/${prevBoard.id}`}
              onClick={(e) => handleNavLink(e, prevBoard.id)}
              title={prevBoard.model}
            >
              <ArrowLeftIcon size={13} /> Prev
            </a>
            <a
              href={`/boards/${nextBoard.id}`}
              onClick={(e) => handleNavLink(e, nextBoard.id)}
              title={nextBoard.model}
            >
              Next <ArrowRightIcon size={13} />
            </a>
          </div>
        )}
      </div>

      {/* Hardware Specimen + Datasheet Split */}
      <section className="bh-detail-hero" aria-labelledby="board-detail-title">
        <div className="bh-specimen-stage">
          <BoardPhoto
            imageUrl={board.image_url ?? undefined}
            size="detail"
            alt={board.model}
            className="bh-specimen-photo"
          />
          <span className="bh-specimen-caption">
            {manufacturer(board.id)} // {formatSoc(board.spec.soc)}
          </span>
        </div>

        <div className="bh-datasheet">
          <div className="bh-detail-meta-row">
            <span className="bh-detail-vendor">{manufacturer(board.id)}</span>
            <button type="button" className="bh-id-copy" onClick={copyBoardId}>
              <span>{board.id}</span>
              {copiedId ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
            </button>
          </div>

          <div>
            <h1 id="board-detail-title" className="bh-detail-title">
              {board.name}
            </h1>
            <p className="bh-detail-model">{board.model}</p>
          </div>

          <dl className="bh-spec-grid">
            <div className="bh-spec-cell">
              <dt>SoC</dt>
              <dd className="is-lime">{formatSoc(board.spec.soc)}</dd>
            </div>
            <div className="bh-spec-cell">
              <dt>Flash</dt>
              <dd>
                {board.spec.flash_mb} MB ·{" "}
                {board.spec.flash_bus === "octal" ? "Octal" : "Quad"}
              </dd>
            </div>
            <div className="bh-spec-cell">
              <dt>PSRAM</dt>
              <dd>{formatPsram(board.spec.psram)}</dd>
            </div>
            <div className="bh-spec-cell">
              <dt>Console</dt>
              <dd>{formatConsole(board.spec.console)}</dd>
            </div>
            <div className="bh-spec-cell">
              <dt>Bootloader</dt>
              <dd>{board.bootloader}</dd>
            </div>
            <div className="bh-spec-cell">
              <dt>Launcher</dt>
              <dd>{bl ? bl.version.slice(0, 10) : "—"}</dd>
            </div>
          </dl>

          <div className="bh-detail-actions">
            <button
              type="button"
              className="bh-btn-primary"
              onClick={() => onOpenModal({ kind: "connect", board })}
            >
              Connect to coding agent <ArrowRightIcon size={15} />
            </button>
            {board.product_url && (
              <a
                className="bh-btn-secondary"
                href={board.product_url}
                target="_blank"
                rel="noopener noreferrer"
              >
                Product page <ArrowUpRightIcon size={15} />
              </a>
            )}
          </div>
        </div>
      </section>

      {/* Runnable Projects */}
      <section className="bh-projects-section" aria-labelledby="projects-heading">
        <div className="bh-section-head">
          <div className="bh-section-title-group">
            <h2 id="projects-heading" className="bh-section-title">
              Runnable Projects
              <span className="bh-count-badge">{boardProjects.length}</span>
            </h2>
            <p className="bh-section-sub">
              Published firmware builds verified for <code>{board.id}</code> — ask your
              coding agent to install any project wirelessly via EspHub OTA.
            </p>
          </div>
          {boardProjects.length > 3 && (
            <input
              type="search"
              className="bh-proj-filter"
              placeholder={`Filter ${boardProjects.length} projects…`}
              aria-label="Filter projects"
              value={projQuery}
              onChange={(e) => setProjQuery(e.target.value)}
            />
          )}
        </div>

        {boardProjects.length === 0 ? (
          <div className="bh-proj-empty">
            <div>
              <h3>No published projects for {board.name} yet</h3>
              <p>
                This board is fully supported by EspHub Bootloader (
                <code>{board.bootloader}</code>). Connect it to your coding agent to
                compile and wirelessly OTA flash your own ESP-IDF app, or publish the
                first project via EspHub Projects.
              </p>
            </div>
            <button
              type="button"
              className="bh-btn-primary"
              onClick={() => onOpenModal({ kind: "connect", board })}
            >
              Start building with Agent <ArrowRightIcon size={15} />
            </button>
          </div>
        ) : filteredProjects.length === 0 ? (
          <div className="bh-empty">
            <h3>No matching projects</h3>
            <p>Try a different keyword to filter projects for {board.name}.</p>
          </div>
        ) : (
          <div className="bh-proj-grid">
            {filteredProjects.map(({ project, ref }) => {
              const source = projectSourceUrl(project);
              return (
                <article className="bh-proj-card" key={project.id}>
                  {project.cover_image_url && (
                    <img
                      className="bh-proj-cover"
                      src={project.cover_image_url}
                      alt={project.name}
                      loading="lazy"
                    />
                  )}
                  <div className="bh-proj-body">
                    <div className="bh-proj-top">
                      <h3 className="bh-proj-name">{project.name}</h3>
                      <div className="bh-proj-versions">
                        <span className="bh-ver-pill" title="Release version">
                          {ref.version.slice(0, 8)}
                        </span>
                        <span className="bh-ver-pill is-sdk" title="EspHub SDK version">
                          SDK {ref.sdk_version}
                        </span>
                      </div>
                    </div>

                    <p className="bh-proj-desc">
                      {project.description || "Published ESP32 application for EspHub OTA."}
                    </p>

                    <div className="bh-proj-repo">
                      {source ? (
                        <a
                          href={source}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <GitBranchIcon size={13} />
                          <span>{shortRepoLabel(project)}</span>
                        </a>
                      ) : (
                        <span>Published via EspHub Projects</span>
                      )}
                      <span>Updated {formatShortDate(ref.updated_at)}</span>
                    </div>
                  </div>

                  <div className="bh-proj-actions">
                    <button
                      type="button"
                      className="bh-proj-ota-btn"
                      onClick={() =>
                        onOpenModal({ kind: "ota", board, project, ref })
                      }
                    >
                      <TerminalWindowIcon size={14} />
                      Install via Agent
                    </button>
                    {source && (
                      <a
                        className="bh-proj-mini-btn"
                        href={source}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Source <ArrowUpRightIcon size={13} />
                      </a>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}

type SortKey = "featured" | "projects" | "flash" | "name";
type ViewMode = "grid" | "table";

export default function BoardsPage({
  initialBoardId,
}: {
  initialBoardId: string | null;
}) {
  const [selectedBoardId, setSelectedBoardId] = useState<string | null>(
    initialBoardId,
  );
  const [boards, setBoards] = useState<DirectoryBoard[] | null>(null);
  const [projects, setProjects] = useState<PublicProject[]>([]);
  const [fallbackBoard, setFallbackBoard] = useState<DirectoryBoard | null>(null);
  const [failed, setFailed] = useState(false);

  const [query, setQuery] = useState("");
  const [vendors, setVendors] = useState<string[]>([]);
  const [socs, setSocs] = useState<string[]>([]);
  const [flashes, setFlashes] = useState<number[]>([]);
  const [onlyWithProjects, setOnlyWithProjects] = useState(false);
  const [sortBy, setSortBy] = useState<SortKey>("featured");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [modal, setModal] = useState<PromptModalState | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    Promise.all([
      fetch("/backend/boards").then((r) => {
        if (!r.ok) throw Error("Board directory unavailable");
        return r.json() as Promise<DirectoryBoard[]>;
      }),
      fetch("/backend/projects")
        .then((r) => (r.ok ? (r.json() as Promise<PublicProject[]>) : []))
        .catch(() => [] as PublicProject[]),
    ])
      .then(([boardList, projectList]) => {
        if (!active) return;
        setBoards(boardList);
        setProjects(projectList);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const onPop = () => setSelectedBoardId(parseBoardsPath(location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Fallback fetch if user opens a direct URL for a retired/unlisted board
  useEffect(() => {
    if (!selectedBoardId || !boards) {
      setFallbackBoard(null);
      return;
    }
    if (boards.some((b) => b.id === selectedBoardId)) {
      setFallbackBoard(null);
      return;
    }
    let active = true;
    fetch(`/backend/boards/${selectedBoardId}`)
      .then((r) => (r.ok ? (r.json() as Promise<DirectoryBoard>) : null))
      .then((detail) => {
        if (active) setFallbackBoard(detail);
      })
      .catch(() => {
        if (active) setFallbackBoard(null);
      });
    return () => {
      active = false;
    };
  }, [selectedBoardId, boards]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (
        e.key === "/" &&
        !selectedBoardId &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement)
      ) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedBoardId]);

  const projectsByBoard = useMemo(() => {
    const map = new Map<string, { project: PublicProject; ref: ProjectBoardRef }[]>();
    for (const project of projects) {
      for (const ref of project.boards) {
        const list = map.get(ref.board_id) ?? [];
        list.push({ project, ref });
        map.set(ref.board_id, list);
      }
    }
    return map;
  }, [projects]);

  const boardList = boards ?? [];
  const selectedBoard = selectedBoardId
    ? boardList.find((b) => b.id === selectedBoardId) ?? fallbackBoard
    : null;

  useEffect(() => {
    document.title = selectedBoard
      ? `${selectedBoard.name} — EspHub Boards`
      : "Boards — EspHub";
  }, [selectedBoard]);

  function navigateBoard(id: string | null) {
    const nextPath = id ? `/boards/${id}` : "/boards";
    if (location.pathname !== nextPath) history.pushState(null, "", nextPath);
    setSelectedBoardId(id);
  }

  function toggleValue<T>(list: T[], val: T, setter: (next: T[]) => void) {
    setter(list.includes(val) ? list.filter((x) => x !== val) : [...list, val]);
  }

  function clearAll() {
    setQuery("");
    setVendors([]);
    setSocs([]);
    setFlashes([]);
    setOnlyWithProjects(false);
  }

  const matchBoard = (
    b: DirectoryBoard,
    ignore?: "vendor" | "soc" | "flash" | "projects",
  ) => {
    if (ignore !== "vendor" && vendors.length && !vendors.includes(b.vendor))
      return false;
    if (ignore !== "soc" && socs.length && !socs.includes(b.spec.soc))
      return false;
    if (ignore !== "flash" && flashes.length && !flashes.includes(b.spec.flash_mb))
      return false;
    if (
      ignore !== "projects" &&
      onlyWithProjects &&
      !(projectsByBoard.get(b.id)?.length)
    )
      return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    const projs = projectsByBoard.get(b.id) ?? [];
    return (
      b.id.toLowerCase().includes(q) ||
      b.name.toLowerCase().includes(q) ||
      b.model.toLowerCase().includes(q) ||
      manufacturer(b.id).toLowerCase().includes(q) ||
      b.spec.soc.toLowerCase().includes(q) ||
      formatSoc(b.spec.soc).toLowerCase().includes(q) ||
      b.bootloader.toLowerCase().includes(q) ||
      `${b.spec.flash_mb}mb`.includes(q.replace(/\s+/g, "")) ||
      projs.some(({ project }) => project.name.toLowerCase().includes(q))
    );
  };

  const vendorOptions = useMemo(() => {
    const totals = new Map<string, number>();
    for (const b of boardList) totals.set(b.vendor, (totals.get(b.vendor) ?? 0) + 1);
    return [...totals.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([v]) => ({
        id: v,
        label: manufacturer(`${v}/x`),
        count: boardList.filter((b) => b.vendor === v && matchBoard(b, "vendor"))
          .length,
      }));
  }, [boardList, query, socs, flashes, onlyWithProjects, projectsByBoard]);

  const socOptions = useMemo(() => {
    const totals = new Map<string, number>();
    for (const b of boardList)
      totals.set(b.spec.soc, (totals.get(b.spec.soc) ?? 0) + 1);
    return [...totals.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([s]) => ({
        id: s,
        label: formatSoc(s),
        count: boardList.filter((b) => b.spec.soc === s && matchBoard(b, "soc"))
          .length,
      }));
  }, [boardList, query, vendors, flashes, onlyWithProjects, projectsByBoard]);

  const flashOptions = useMemo(() => {
    const unique = [...new Set(boardList.map((b) => b.spec.flash_mb))].sort(
      (a, b) => a - b,
    );
    return unique.map((f) => ({
      id: f,
      label: `${f} MB`,
      count: boardList.filter((b) => b.spec.flash_mb === f && matchBoard(b, "flash"))
        .length,
    }));
  }, [boardList, query, vendors, socs, onlyWithProjects, projectsByBoard]);

  const filteredBoards = useMemo(() => {
    const list = boardList.filter((b) => matchBoard(b));
    if (sortBy === "projects") {
      return [...list].sort((a, b) => {
        const diff =
          (projectsByBoard.get(b.id)?.length ?? 0) -
          (projectsByBoard.get(a.id)?.length ?? 0);
        return diff || a.name.localeCompare(b.name);
      });
    }
    if (sortBy === "flash") {
      return [...list].sort(
        (a, b) => b.spec.flash_mb - a.spec.flash_mb || a.name.localeCompare(b.name),
      );
    }
    if (sortBy === "name") {
      return [...list].sort((a, b) => a.name.localeCompare(b.name));
    }
    return [...list].sort((a, b) => {
      const pa = projectsByBoard.get(a.id)?.length ?? 0;
      const pb = projectsByBoard.get(b.id)?.length ?? 0;
      if (pa > 0 && pb === 0) return -1;
      if (pb > 0 && pa === 0) return 1;
      return pb - pa;
    });
  }, [boardList, query, vendors, socs, flashes, onlyWithProjects, sortBy, projectsByBoard]);

  const hasFilters =
    Boolean(query.trim()) ||
    vendors.length > 0 ||
    socs.length > 0 ||
    flashes.length > 0 ||
    onlyWithProjects;

  const withProjectsCount = useMemo(
    () =>
      boardList.filter(
        (b) =>
          (projectsByBoard.get(b.id)?.length ?? 0) > 0 &&
          matchBoard(b, "projects"),
      ).length,
    [boardList, query, vendors, socs, flashes, projectsByBoard],
  );

  function onBoardCardClick(e: MouseEvent<HTMLAnchorElement>, id: string) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    navigateBoard(id);
  }

  return (
    <div className="esphub-boards-app">
      <header className="bh-masthead">
        <div className="bh-masthead-inner">
          <div className="bh-brand-group">
            <a className="bh-logo" href="/" aria-label="EspHub home">
              <img src={logo} alt="EspHub" width={109} height={31} />
            </a>
            <nav className="bh-nav" aria-label="Primary">
              <a className="bh-nav-link" href="/">
                Home
              </a>
              <a
                className="bh-nav-link is-active"
                href="/boards"
                aria-current="page"
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0)
                    return;
                  e.preventDefault();
                  navigateBoard(null);
                }}
              >
                Boards
              </a>
            </nav>
          </div>
          <a className="bh-workspace-link" href="/devices">
            Open workspace <ArrowUpRightIcon size={14} aria-hidden="true" />
          </a>
        </div>
      </header>

      {selectedBoardId ? (
        selectedBoard ? (
          <BoardDetailView
            board={selectedBoard}
            allBoards={filteredBoards.length ? filteredBoards : boardList}
            boardProjects={projectsByBoard.get(selectedBoard.id) ?? []}
            onNavigate={navigateBoard}
            onOpenModal={setModal}
          />
        ) : (
          <main className="bh-detail-shell">
            <div className="bh-empty">
              {failed ? (
                <>
                  <h3>Board directory unavailable</h3>
                  <p>Could not load board details right now.</p>
                </>
              ) : boards ? (
                <>
                  <h3>Board not found</h3>
                  <p>
                    No board matches <code>{selectedBoardId}</code>.
                  </p>
                  <div style={{ marginTop: 18 }}>
                    <a
                      className="bh-btn-primary"
                      href="/boards"
                      onClick={(e) => {
                        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0)
                          return;
                        e.preventDefault();
                        navigateBoard(null);
                      }}
                    >
                      Browse all boards
                    </a>
                  </div>
                </>
              ) : (
                <p role="status">Loading board…</p>
              )}
            </div>
          </main>
        )
      ) : (
        <>
          <section className="bh-dir-hero">
            <div className="bh-dir-hero-inner">
              <div>
                <div className="bh-kicker">
                  <i className="bh-kicker-dot" aria-hidden="true" />
                  Hardware Directory // Vibe OTA Catalog
                </div>
                <h1 className="bh-dir-title">
                  Supported <em>ESP32</em> Boards.
                </h1>
                <p className="bh-dir-sub">
                  Filter by manufacturer, SoC, flash capacity, or keyword. Open any
                  board to inspect its hardware spec and install runnable projects
                  wirelessly with your coding agent.
                </p>
              </div>

              <div className="bh-hero-stats" aria-label="Catalog summary">
                <div className="bh-stat">
                  <span className="bh-stat-val">
                    {boards ? boards.length : "—"}
                  </span>
                  <span className="bh-stat-label">Boards</span>
                </div>
                <div className="bh-stat">
                  <span className="bh-stat-val">
                    {boards ? vendorOptions.length : "—"}
                  </span>
                  <span className="bh-stat-label">Vendors</span>
                </div>
                <div className="bh-stat">
                  <span className="bh-stat-val is-lime">
                    {boards ? projects.length : "—"}
                  </span>
                  <span className="bh-stat-label">OTA Projects</span>
                </div>
              </div>
            </div>
          </section>

          <section className="bh-workbench" aria-label="Board filters">
            <div className="bh-workbench-inner">
              <div className="bh-toolbar-row">
                <div className="bh-search-wrap">
                  <MagnifyingGlassIcon
                    size={16}
                    className="bh-search-icon"
                    aria-hidden="true"
                  />
                  <input
                    ref={searchRef}
                    type="text"
                    className="bh-search-input"
                    placeholder="Search model, vendor, SoC, flash, or project name…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    aria-label="Search boards"
                  />
                  {query ? (
                    <button
                      type="button"
                      className="bh-search-clear"
                      onClick={() => setQuery("")}
                      aria-label="Clear search"
                    >
                      <XIcon size={14} />
                    </button>
                  ) : (
                    <span className="bh-search-kbd" aria-hidden="true">
                      /
                    </span>
                  )}
                </div>

                <div className="bh-toolbar-actions">
                  <button
                    type="button"
                    className={`bh-toggle-btn${onlyWithProjects ? " is-active" : ""}`}
                    onClick={() => setOnlyWithProjects((v) => !v)}
                  >
                    <i className="bh-dot" aria-hidden="true" />
                    With projects ({withProjectsCount})
                  </button>

                  <select
                    className="bh-select"
                    aria-label="Sort boards"
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value as SortKey)}
                  >
                    <option value="featured">Sort: Featured</option>
                    <option value="projects">Sort: Most projects</option>
                    <option value="flash">Sort: Flash high → low</option>
                    <option value="name">Sort: Name A → Z</option>
                  </select>

                  <div className="bh-view-switch" role="group" aria-label="View mode">
                    <button
                      type="button"
                      className={viewMode === "grid" ? "is-active" : undefined}
                      onClick={() => setViewMode("grid")}
                      aria-label="Grid view"
                    >
                      <SquaresFourIcon size={15} aria-hidden="true" /> Grid
                    </button>
                    <button
                      type="button"
                      className={viewMode === "table" ? "is-active" : undefined}
                      onClick={() => setViewMode("table")}
                      aria-label="Spec table view"
                    >
                      <RowsIcon size={15} aria-hidden="true" /> Table
                    </button>
                  </div>
                </div>
              </div>

              {boards && (
                <div className="bh-facets">
                  <div
                    className="bh-facet-group"
                    role="group"
                    aria-label="Filter by vendor"
                  >
                    <span className="bh-facet-label">Vendor</span>
                    <button
                      type="button"
                      className={`bh-chip${vendors.length === 0 ? " is-active" : ""}`}
                      onClick={() => setVendors([])}
                    >
                      All
                    </button>
                    {vendorOptions.map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        className={`bh-chip${vendors.includes(opt.id) ? " is-active" : ""}${opt.count === 0 ? " is-zero" : ""}`}
                        onClick={() => toggleValue(vendors, opt.id, setVendors)}
                      >
                        {opt.label}
                        <span className="bh-chip-count">{opt.count}</span>
                      </button>
                    ))}
                  </div>

                  <div
                    className="bh-facet-group"
                    role="group"
                    aria-label="Filter by SoC"
                  >
                    <span className="bh-facet-label">SoC</span>
                    <button
                      type="button"
                      className={`bh-chip${socs.length === 0 ? " is-active" : ""}`}
                      onClick={() => setSocs([])}
                    >
                      All
                    </button>
                    {socOptions.map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        className={`bh-chip${socs.includes(opt.id) ? " is-active" : ""}${opt.count === 0 ? " is-zero" : ""}`}
                        onClick={() => toggleValue(socs, opt.id, setSocs)}
                      >
                        {opt.label}
                        <span className="bh-chip-count">{opt.count}</span>
                      </button>
                    ))}
                  </div>

                  <div
                    className="bh-facet-group"
                    role="group"
                    aria-label="Filter by Flash"
                  >
                    <span className="bh-facet-label">Flash</span>
                    <button
                      type="button"
                      className={`bh-chip${flashes.length === 0 ? " is-active" : ""}`}
                      onClick={() => setFlashes([])}
                    >
                      All
                    </button>
                    {flashOptions.map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        className={`bh-chip${flashes.includes(opt.id) ? " is-active" : ""}${opt.count === 0 ? " is-zero" : ""}`}
                        onClick={() => toggleValue(flashes, opt.id, setFlashes)}
                      >
                        {opt.label}
                        <span className="bh-chip-count">{opt.count}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </section>

          <main className="bh-main">
            {failed ? (
              <div className="bh-empty">
                <h3>Board directory unavailable</h3>
                <p>Could not load boards from EspHub right now.</p>
              </div>
            ) : !boards ? (
              <div className="bh-empty">
                <p role="status">Loading boards…</p>
              </div>
            ) : (
              <>
                <div className="bh-results-bar">
                  <p className="bh-results-count">
                    Showing <strong>{filteredBoards.length}</strong> of{" "}
                    {boards.length} boards
                  </p>

                  {hasFilters && (
                    <div className="bh-active-tags">
                      {vendors.map((v) => (
                        <button
                          key={v}
                          type="button"
                          className="bh-active-tag"
                          onClick={() => toggleValue(vendors, v, setVendors)}
                        >
                          {manufacturer(`${v}/x`)} <XIcon size={11} />
                        </button>
                      ))}
                      {socs.map((s) => (
                        <button
                          key={s}
                          type="button"
                          className="bh-active-tag"
                          onClick={() => toggleValue(socs, s, setSocs)}
                        >
                          {formatSoc(s)} <XIcon size={11} />
                        </button>
                      ))}
                      {flashes.map((f) => (
                        <button
                          key={f}
                          type="button"
                          className="bh-active-tag"
                          onClick={() => toggleValue(flashes, f, setFlashes)}
                        >
                          {f} MB <XIcon size={11} />
                        </button>
                      ))}
                      {onlyWithProjects && (
                        <button
                          type="button"
                          className="bh-active-tag"
                          onClick={() => setOnlyWithProjects(false)}
                        >
                          With projects <XIcon size={11} />
                        </button>
                      )}
                      <button
                        type="button"
                        className="bh-clear-all"
                        onClick={clearAll}
                      >
                        Clear all
                      </button>
                    </div>
                  )}
                </div>

                {filteredBoards.length === 0 ? (
                  <div className="bh-empty">
                    <h3>No boards match the current filters</h3>
                    <p>
                      Try clearing one of the Vendor, SoC, Flash, or keyword filters.
                    </p>
                    <div style={{ marginTop: 18 }}>
                      <button
                        type="button"
                        className="bh-btn-primary"
                        onClick={clearAll}
                      >
                        Reset filters
                      </button>
                    </div>
                  </div>
                ) : viewMode === "grid" ? (
                  <div className="bh-grid">
                    {filteredBoards.map((board) => {
                      const projCount = projectsByBoard.get(board.id)?.length ?? 0;
                      return (
                        <a
                          key={board.id}
                          href={`/boards/${board.id}`}
                          className="bh-card"
                          onClick={(e) => onBoardCardClick(e, board.id)}
                        >
                          <div className="bh-card-plate">
                            <span className="bh-card-vendor">
                              {manufacturer(board.id)}
                            </span>
                            <div className="bh-card-badges">
                              {board.preview && (
                                <span className="bh-preview-pill">Preview</span>
                              )}
                              {projCount > 0 && (
                                <span className="bh-proj-pill">
                                  <i aria-hidden="true" />
                                  {projCount}{" "}
                                  {projCount === 1 ? "project" : "projects"}
                                </span>
                              )}
                            </div>
                            <BoardPhoto
                              imageUrl={board.image_url ?? undefined}
                              size="wall"
                              alt={board.model}
                              className="bh-card-photo"
                            />
                          </div>

                          <div className="bh-card-body">
                            <div className="bh-card-head">
                              <span className="bh-card-name">{board.name}</span>
                              <ArrowRightIcon
                                size={15}
                                className="bh-card-arrow"
                                aria-hidden="true"
                              />
                            </div>
                            <div className="bh-spec-pills">
                              <span className="bh-spec-pill is-soc">
                                {formatSoc(board.spec.soc)}
                              </span>
                              <span className="bh-spec-pill">
                                {board.spec.flash_mb} MB
                              </span>
                              {board.spec.psram && (
                                <span className="bh-spec-pill">
                                  {board.spec.psram === "octal"
                                    ? "OPI PSRAM"
                                    : "QPI PSRAM"}
                                </span>
                              )}
                              <span className="bh-spec-pill">
                                {formatConsole(board.spec.console)}
                              </span>
                            </div>
                            <span className="bh-card-id">{board.id}</span>
                          </div>
                        </a>
                      );
                    })}
                  </div>
                ) : (
                  <div className="bh-table-wrap">
                    <table className="bh-table">
                      <thead>
                        <tr>
                          <th>Board</th>
                          <th>Vendor</th>
                          <th>SoC</th>
                          <th>Flash</th>
                          <th>PSRAM</th>
                          <th>Console</th>
                          <th>Bootloader</th>
                          <th>Projects</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredBoards.map((board) => {
                          const projCount =
                            projectsByBoard.get(board.id)?.length ?? 0;
                          return (
                            <tr
                              key={board.id}
                              onClick={() => navigateBoard(board.id)}
                            >
                              <td>
                                <div className="bh-table-board">
                                  <div className="bh-table-thumb">
                                    <BoardPhoto
                                      imageUrl={board.image_url ?? undefined}
                                      size="device"
                                      alt=""
                                    />
                                  </div>
                                  <div>
                                    <div style={{ fontWeight: 600, color: "#f4f5ed" }}>
                                      {board.name}
                                    </div>
                                    <div className="bh-table-sub">{board.id}</div>
                                  </div>
                                </div>
                              </td>
                              <td className="bh-table-mono">
                                {manufacturer(board.id)}
                              </td>
                              <td
                                className="bh-table-mono"
                                style={{ color: "var(--lime)" }}
                              >
                                {formatSoc(board.spec.soc)}
                              </td>
                              <td className="bh-table-mono">
                                {board.spec.flash_mb} MB
                              </td>
                              <td className="bh-table-mono">
                                {formatPsram(board.spec.psram)}
                              </td>
                              <td className="bh-table-mono">
                                {formatConsole(board.spec.console)}
                              </td>
                              <td className="bh-table-mono">{board.bootloader}</td>
                              <td className="bh-table-mono">
                                {projCount > 0 ? (
                                  <span
                                    style={{ color: "var(--lime)", fontWeight: 600 }}
                                  >
                                    {projCount}
                                  </span>
                                ) : (
                                  <span style={{ color: "var(--text-dim)" }}>0</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </main>
        </>
      )}

      <footer className="bh-footer">
        <div className="bh-footer-inner">
          <nav aria-label="Legal">
            <a href="/terms/">Terms of Service</a>
            <a href="/privacy/">Privacy Policy</a>
          </nav>
        </div>
      </footer>

      {modal && (
        <AgentPromptModal modal={modal} onClose={() => setModal(null)} />
      )}
    </div>
  );
}
