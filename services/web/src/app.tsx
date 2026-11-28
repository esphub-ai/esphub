import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { issuer, mcpEndpoint, portal } from "../../../shared/identity.js";
import "./index.css";
import Landing from "./landing";
import BoardsPage, { parseBoardsPath } from "./boards-page";
import ProjectsPage, { parseProjectsPath } from "./projects-page";
import { BoardPhoto, type Board } from "./components/board-photo";
import {
  CheckIcon,
  CopyIcon,
  CircleIcon,
  GearSixIcon,
  LinkIcon,
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

function Workspace({ clerk }: { clerk: Clerk }) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let request: AbortController | undefined;
    async function readDevices() {
      request?.abort();
      const controller = new AbortController();
      request = controller;
      try {
        const token = await clerk.session?.getToken();
        if (controller.signal.aborted) return;
        if (!token) return signIn();
        const response = await fetch("/backend/operations/devices_list", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + token,
          },
          body: "{}",
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (response.status === 401) return signIn();
        if (!response.ok) throw Error("Could not load devices.");
        const list: Device[] = await response.json();
        if (controller.signal.aborted) return;
        setDevices(list.filter((device) => device.kind === "physical"));
        setError("");
      } catch {
        if (!controller.signal.aborted) setError("Could not load devices.");
      }
    }
    void readDevices();
    window.addEventListener("focus", readDevices);
    return () => {
      request?.abort();
      window.removeEventListener("focus", readDevices);
    };
  }, [clerk, refresh]);

  return (
    <main className="w-full px-4 py-8 sm:px-6 sm:py-14 lg:px-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <Brand />
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
      {devices?.length ? (
        <DeviceCards devices={devices} />
      ) : (
        !error && (
          <p role="status">
            {devices ? "No devices yet." : "Loading devices…"}
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
