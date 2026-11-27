import { useState, type ImgHTMLAttributes } from "react";
import { CpuIcon } from "@phosphor-icons/react";
import { thumbnailWidths } from "../../../../shared/board-photo.js";

export type BoardSpec = {
  soc: string;
  flash_mb: number;
  flash_bus: "quad" | "octal";
  psram: "quad" | "octal" | null;
  console: "usb-serial-jtag" | "uart";
};

export type Board = {
  id: string;
  name: string;
  model: string;
  bootloader: string;
  spec: BoardSpec;
  product_url: string | null;
  image_url: string;
};

type PhotoProps = Pick<
  ImgHTMLAttributes<HTMLImageElement>,
  "className" | "alt"
> & {
  imageUrl?: string;
  size: "device" | "wall" | "detail";
};

export function BoardPhoto({
  imageUrl,
  size,
  alt = "",
  className,
}: PhotoProps) {
  const [failed, setFailed] = useState<string>();
  if (!imageUrl || failed === imageUrl)
    return <CpuIcon className={className} aria-hidden="true" />;

  const widths = size === "detail" ? undefined : thumbnailWidths[size];
  const variant = (width: number) => {
    const url = new URL(imageUrl);
    url.searchParams.set("width", String(width));
    return url.href;
  };
  return (
    <img
      className={className}
      alt={alt}
      width={widths?.[0] ?? 400}
      height={widths?.[0] ?? 400}
      src={widths ? variant(widths[0]) : imageUrl}
      srcSet={widths?.map((w) => `${variant(w)} ${w}w`).join(", ")}
      sizes={
        size === "wall"
          ? "(max-width: 650px) 128px, 160px"
          : size === "device"
            ? "80px"
            : undefined
      }
      loading={size === "detail" ? "eager" : "lazy"}
      decoding="async"
      draggable={false}
      onError={() => setFailed(imageUrl)}
    />
  );
}
