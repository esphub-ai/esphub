import { useState, type ImgHTMLAttributes } from "react";
import { CpuIcon } from "@phosphor-icons/react";

export type Board = { id: string; image_url: string };

export function BoardPhoto({
  imageUrl,
  className,
  ...props
}: Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "alt"> & {
  imageUrl?: string;
}) {
  const [failed, setFailed] = useState<string>();
  if (!imageUrl || failed === imageUrl)
    return <CpuIcon className={className} aria-hidden="true" />;
  return (
    <img
      {...props}
      className={className}
      alt=""
      src={"/backend" + new URL(imageUrl).pathname}
      onError={() => setFailed(imageUrl)}
    />
  );
}
