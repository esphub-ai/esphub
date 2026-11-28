import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { issuer, mcpEndpoint, portal } from "../../../shared/identity.js";
import "./index.css";
import Landing from "./landing";
import BoardsPage, { parseBoardsPath } from "./boards-page";
import ProjectsPage, { parseProjectsPath } from "./projects-page";
import { BoardPhoto, type Board } from "./components/board-photo";
import {
  ArrowUpRightIcon,
  CheckIcon,
  CopyIcon,
  CircleIcon,
  GearSixIcon,
  GlobeIcon,
  LinkIcon,
  LockSimpleIcon,
} from "@phosphor-icons/react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

import logo from "./assets/esphub-logo-light.svg";
const prompts = {
  manage: `Connect to EspHub MCP at ${mcpEndpoint}. Use CIMD OAuth with devices:read and devices:write as needed.

1. Use devices_list to list my physical devices and their online status. Ask which device I want to manage and what I want to do.
2. Use devices_get for details. For Wi-Fi, start with wifi_list and use wifi_scan, wifi_add, or wifi_remove as needed.
3. Use projects_search (filtered by board ID) and projects_get to find a published app's download_url, or upload a custom binary with ota_prepare_upload. Enter Bootloader mode with bootloader_enter, call ota_install (url is required for kind="app"; omit url for kind="bootloader" to install the latest Launcher), and verify the receipt and firmware version after reboot.
   In Launcher mode, use ota_resize_app to grow or shrink the app slot. Ask me before changing its size because this erases all LittleFS files.
4. Use devices_reset to clear device provisioning or devices_delete to remove a device. Confirm the target and effect with me first.`,
  bind: `Connect to EspHub MCP at ${mcpEndpoint}. Use CIMD OAuth with devices:read and devices:write as needed. Follow https://esphub.ai/SKILL.md.

1. Ask me to connect my ESP32 over USB. Identify the manufacturer and model. Search the board ID with boards_search, pick the exact vendor/model ID, and ask me to confirm it if it is unclear.
2. Ask me for my Wi-Fi SSID and password, then register the device with devices_create including wifi (flash only the bootloader set and private NVS image with --erase-all first so the board boots cleanly into Bootloader mode). Ask before erasing existing data, and keep the NVS download credential and image private.
3. Check devices_get after reboot:
   - If online (info.role=bootloader): tell me wireless OTA is ready and I can unplug the USB cable from my computer (power only is enough), call projects_search for this board to suggest fun starter projects, and ask which project or app I want to OTA install.
   - If offline: if USB is still connected, scan visible Wi-Fi networks over serial at 115200 baud with \`EH-WIFI {"op":"wifi.scan"}\`, let me pick a network and enter the password, and join via \`EH-WIFI {"op":"wifi.join",...}\`; if USB is unplugged, use BLE provisioning (wifi_ble_credential + wifi.scan/wifi.join). Once online, continue to OTA.`,
};

function PromptDialog({
  title,
  prompt,
  primary = false,
}: {
  title: string;
  prompt: string;
  primary?: boolean;
}) {
  const ActionIcon = primary ? LinkIcon : GearSixIcon;
  const field = useRef<HTMLTextAreaElement>(null);
  const [copyLabel, setCopyLabel] = useState("Copy prompt");

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopyLabel("Copied");
    } catch {
      field.current?.focus();
      field.current?.select();
      setCopyLabel("Press Ctrl+C or ⌘C");
    }
  }

  return (
    <Dialog
      onOpenChange={(open) => {
        if (open) setCopyLabel("Copy prompt");
      }}
    >
      <DialogTrigger
        render={<Button variant={primary ? "default" : "outline"} />}
      >
        <ActionIcon aria-hidden="true" data-icon="inline-start" />
        {title}
      </DialogTrigger>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ActionIcon aria-hidden="true" />
            {title}
          </DialogTitle>
          <DialogDescription>
            Copy this prompt and paste it into your coding agent.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          ref={field}
          value={prompt}
          aria-label="Prompt"
          readOnly
          rows={9}
        />
        <DialogFooter showCloseButton>
          <Button onClick={copyPrompt}>
            {copyLabel === "Copied" ? (
              <CheckIcon aria-hidden="true" data-icon="inline-start" />
            ) : (
              <CopyIcon aria-hidden="true" data-icon="inline-start" />
            )}
            {copyLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type Device = {
  id: string;
  name: string;
  board: string;
  image_url?: string;
  kind: "physical" | "virtual";
  online: boolean;
};

type Clerk = {
  load(): Promise<void>;
  session: { getToken(): Promise<string | null> } | null;
  signOut(options: { redirectUrl: string }): Promise<void>;
};

function signIn() {
  const url = new URL("/sign-in", portal);
  url.searchParams.set("redirect_url", location.href);
  location.replace(url.href);
}

async function loadClerk() {
  const script = document.createElement("script");
  script.src = issuer + "/npm/@clerk/clerk-js@6/dist/clerk.browser.js";
  script.crossOrigin = "anonymous";
  script.dataset.clerkPublishableKey =
    "pk_live_" + btoa(new URL(issuer).host + "$");
  await new Promise<void>((resolve, reject) => {
    script.onload = () => resolve();
    script.onerror = () => reject(Error("Unable to load sign-in."));
    document.head.append(script);
  });
  const { Clerk: clerk } = window as Window & { Clerk: Clerk };
  await clerk.load();
  return clerk;
}

function DeviceCards({ devices }: { devices: Device[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
      {devices.map(({ id, name, board, image_url, online }) => (
        <Card key={id} size="sm">
          <CardContent className="flex items-center gap-3">
            <BoardPhoto
              imageUrl={image_url}
              className="aspect-square w-20 shrink-0 object-contain"
              size="device"
            />
            <div className="grid min-w-0 flex-1 gap-2">
              <div>
                <CardTitle>{name}</CardTitle>
                <p className="break-all">{board}</p>
              </div>
              <Badge variant={online ? "secondary" : "outline"}>
                <CircleIcon
                  weight="fill"
                  aria-hidden="true"
                  data-icon="inline-start"
                  className={
                    online
                      ? "text-green-500 motion-safe:animate-pulse"
                      : "text-zinc-500"
                  }
                />
                <span className="leading-none">
                  {online ? "Online" : "Offline"}
                </span>
              </Badge>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function Brand() {
  return (
    <h1>
      <img src={logo} alt="EspHub" width={113} height={32} />
    </h1>
  );
}

type OwnedProject = {
  id: string;
  name: string;
  description: string;
  repo_url: string | null;
  repo_path: string | null;
  upstream_url: string | null;
  visibility: "private" | "public";
  tags: string[];
  author: { id: string; name: string; logo_url: string | null; url: string | null } | null;
  boards: { board_id: string; version: string }[];
};

type AuthorOption = {
  id: string;
  name: string;
};

type AccountMe = {
  display_name: string | null;
  avatar_url: string | null;
  is_staff: boolean;
};

function Workspace({ clerk }: { clerk: Clerk }) {
  const [tab, setTab] = useState<"devices" | "projects">("devices");
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [projects, setProjects] = useState<OwnedProject[] | null>(null);
  const [me, setMe] = useState<AccountMe | null>(null);
  const [authors, setAuthors] = useState<AuthorOption[]>([]);
  const [busyProjectId, setBusyProjectId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let request: AbortController | undefined;
    async function readWorkspace() {
      request?.abort();
      const controller = new AbortController();
      request = controller;
      try {
        const token = await clerk.session?.getToken();
        if (controller.signal.aborted) return;
        if (!token) return signIn();
        const authHeaders = {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
        };
        const [devRes, projRes, meRes] = await Promise.all([
          fetch("/backend/operations/devices_list", {
            method: "POST",
            headers: authHeaders,
            body: "{}",
            signal: controller.signal,
          }),
          fetch("/backend/v1/projects", {
            headers: { Authorization: "Bearer " + token },
            signal: controller.signal,
          }),
          fetch("/backend/v1/me", {
            headers: { Authorization: "Bearer " + token },
            signal: controller.signal,
          }),
        ]);
        if (controller.signal.aborted) return;
        if (devRes.status === 401) return signIn();
        if (!devRes.ok) throw Error("Could not load devices.");
        const list: Device[] = await devRes.json();
        if (controller.signal.aborted) return;
        setDevices(list.filter((device) => device.kind === "physical"));
        if (projRes.ok) setProjects(await projRes.json());
        if (meRes.ok) {
          const profile: AccountMe = await meRes.json();
          setMe(profile);
          if (profile.is_staff) {
            fetch("/backend/authors", { signal: controller.signal })
              .then((r) => (r.ok ? r.json() : []))
              .then((rows) => {
                if (!controller.signal.aborted) setAuthors(rows);
              })
              .catch(() => {});
          }
        }
        setError("");
      } catch {
        if (!controller.signal.aborted) setError("Could not load devices.");
      }
    }
    void readWorkspace();
    window.addEventListener("focus", readWorkspace);
    return () => {
      request?.abort();
      window.removeEventListener("focus", readWorkspace);
    };
  }, [clerk, refresh]);

  async function toggleVisibility(project: OwnedProject) {
    const nextVisibility = project.visibility === "public" ? "private" : "public";
    setBusyProjectId(project.id);
    setError("");
    try {
      const token = await clerk.session?.getToken();
      if (!token) return signIn();
      const res = await fetch(`/backend/v1/projects/${project.id}/visibility`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
        },
        body: JSON.stringify({ visibility: nextVisibility }),
      });
      if (!res.ok) throw Error("Could not update project visibility.");
      const updated = await res.json();
      setProjects((prev) =>
        prev
          ? prev.map((p) =>
              p.id === project.id ? { ...p, visibility: updated.visibility } : p,
            )
          : prev,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update project visibility.");
    } finally {
      setBusyProjectId(null);
    }
  }

  async function updateStaffProjectMeta(
    project: OwnedProject,
    patch: { author_id?: string | null; tags?: string[] },
  ) {
    setBusyProjectId(project.id);
    setError("");
    try {
      const token = await clerk.session?.getToken();
      if (!token) return signIn();
      const res = await fetch(`/backend/v1/projects/${project.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
        },
        body: JSON.stringify({
          name: project.name,
          description: project.description,
          repo_url: project.repo_url,
          repo_path: project.repo_path,
          upstream_url: project.upstream_url,
          visibility: project.visibility,
          tags: patch.tags ?? project.tags,
          author_id:
            patch.author_id !== undefined
              ? patch.author_id
              : (project.author?.id ?? null),
        }),
      });
      if (!res.ok) throw Error("Could not update project metadata.");
      const updated = await res.json();
      setProjects((prev) =>
        prev
          ? prev.map((p) =>
              p.id === project.id
                ? { ...p, tags: updated.tags, author: updated.author }
                : p,
            )
          : prev,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update project metadata.");
    } finally {
      setBusyProjectId(null);
    }
  }

  const publicOrigin =
    location.hostname === "app.esphub.ai" ? "https://esphub.ai" : "";

  return (
    <main className="w-full px-4 py-8 sm:px-6 sm:py-14 lg:px-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-4">
          <Brand />
          <div
            className="flex items-center gap-0.5 border border-border bg-background p-0.5"
            role="tablist"
            aria-label="Workspace sections"
          >
            <Button
              role="tab"
              aria-selected={tab === "devices"}
              variant={tab === "devices" ? "default" : "ghost"}
              size="sm"
              className={tab === "devices" ? undefined : "text-muted-foreground"}
              onClick={() => setTab("devices")}
            >
              Devices
            </Button>
            <Button
              role="tab"
              aria-selected={tab === "projects"}
              variant={tab === "projects" ? "default" : "ghost"}
              size="sm"
              className={tab === "projects" ? undefined : "text-muted-foreground"}
              onClick={() => setTab("projects")}
            >
              Projects{projects ? ` (${projects.length})` : ""}
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PromptDialog title="Manage devices" prompt={prompts.manage} />
          <PromptDialog title="Bind my ESP32" prompt={prompts.bind} primary />
        </div>
      </div>
      {error && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <p role="alert">{error}</p>
          <Button
            variant="outline"
            onClick={() => setRefresh((value) => value + 1)}
          >
            Retry
          </Button>
        </div>
      )}
      {tab === "devices" ? (
        devices?.length ? (
          <DeviceCards devices={devices} />
        ) : (
          !error && (
            <p role="status">
              {devices ? "No devices yet." : "Loading devices…"}
            </p>
          )
        )
      ) : projects?.length ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {projects.map((project) => {
            const busy = busyProjectId === project.id;
            const isPublic = project.visibility === "public";
            const published = project.boards.length > 0;
            const toggleTag = (tag: string) => {
              const next = project.tags.includes(tag)
                ? project.tags.filter((t) => t !== tag)
                : [...project.tags, tag];
              void updateStaffProjectMeta(project, { tags: next });
            };
            return (
              <Card key={project.id} size="sm">
                <CardContent className="flex flex-col gap-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <CardTitle className="truncate">{project.name}</CardTitle>
                      {project.description && (
                        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                          {project.description}
                        </p>
                      )}
                    </div>
                    <Badge variant={isPublic ? "secondary" : "outline"} className="shrink-0">
                      {isPublic ? (
                        <GlobeIcon aria-hidden="true" data-icon="inline-start" />
                      ) : (
                        <LockSimpleIcon aria-hidden="true" data-icon="inline-start" />
                      )}
                      {isPublic ? "Public" : "Private"}
                    </Badge>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    {published ? (
                      project.boards.slice(0, 3).map((b) => (
                        <Badge key={b.board_id} variant="outline">
                          {b.board_id}
                        </Badge>
                      ))
                    ) : (
                      <span>Draft (no board releases yet)</span>
                    )}
                    {project.boards.length > 3 && (
                      <span>+{project.boards.length - 3} more</span>
                    )}
                  </div>

                  {me?.is_staff && (
                    <div className="flex flex-wrap items-center gap-1.5 border-t border-border pt-2.5 text-xs">
                      <select
                        aria-label={`Author for ${project.name}`}
                        className="h-7 min-w-0 flex-1 border border-input bg-background px-2 text-xs text-foreground"
                        disabled={busy}
                        value={project.author?.id ?? ""}
                        onChange={(e) =>
                          void updateStaffProjectMeta(project, {
                            author_id: e.target.value || null,
                          })
                        }
                      >
                        <option value="">No official author</option>
                        {authors.map((a) => (
                          <option key={a.id} value={a.id}>
                            Author: {a.name}
                          </option>
                        ))}
                      </select>
                      <Button
                        size="sm"
                        variant={project.tags.includes("factory") ? "default" : "outline"}
                        disabled={busy}
                        onClick={() => toggleTag("factory")}
                      >
                        Factory
                      </Button>
                      <Button
                        size="sm"
                        variant={project.tags.includes("example") ? "default" : "outline"}
                        disabled={busy}
                        onClick={() => toggleTag("example")}
                      >
                        Example
                      </Button>
                    </div>
                  )}

                  <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2.5">
                    <Button
                      size="sm"
                      variant={isPublic ? "outline" : "default"}
                      disabled={busy}
                      onClick={() => void toggleVisibility(project)}
                    >
                      {busy
                        ? "Saving…"
                        : isPublic
                          ? "Make private"
                          : "Make public"}
                    </Button>
                    {isPublic && published && (
                      <a
                        className={buttonVariants({ variant: "ghost", size: "sm" })}
                        href={`${publicOrigin}/projects/${project.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Public page <ArrowUpRightIcon aria-hidden="true" />
                      </a>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : (
        !error && (
          <p role="status">
            {projects ? "No projects yet." : "Loading projects…"}
          </p>
        )
      )}
      <footer className="mt-6">
        <Button
          variant="ghost"
          onClick={() =>
            void clerk
              .signOut({ redirectUrl: "https://esphub.ai/" })
              .catch(() => setError("Could not sign out."))
          }
        >
          Sign out
        </Button>
      </footer>
    </main>
  );
}

const root = createRoot(document.getElementById("root")!);
const path = location.pathname.replace(/\/$/, "") || "/";
if (path === "/") {
  root.render(<Landing />);
  fetch("/backend/boards/gallery")
    .then(async (response) => {
      if (!response.ok) throw Error("Board directory unavailable");
      const boards: Board[] = await response.json();
      root.render(<Landing boards={boards} />);
    })
    .catch(() => root.render(<Landing failed />));
} else if (path === "/boards" || parseBoardsPath(path) !== null) {
  root.render(<BoardsPage initialBoardId={parseBoardsPath(path)} />);
} else if (path === "/projects" || parseProjectsPath(path) !== null) {
  root.render(<ProjectsPage initialProjectId={parseProjectsPath(path)} />);
} else if (path === "/devices") {
  root.render(
    <main className="p-8">
      <p role="status">Loading devices…</p>
    </main>,
  );
  loadClerk()
    .then((clerk) => {
      if (!clerk.session) return signIn();
      root.render(<Workspace clerk={clerk} />);
    })
    .catch(() => {
      root.render(
        <main className="grid justify-items-start gap-4 p-8">
          <Brand />
          <p role="alert">Unable to load sign-in.</p>
          <Button onClick={() => location.reload()}>Retry</Button>
        </main>,
      );
    });
} else {
  root.render(
    <main className="grid justify-items-start gap-4 p-8">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <a className={buttonVariants()} href="/">
        Back to EspHub
      </a>
    </main>,
  );
}
