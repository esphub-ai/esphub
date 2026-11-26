import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { BoardPhoto, type Board } from "./board-photo";
import { manufacturer } from "./landing-brands";

const swatches = [
  "#c7d8b7",
  "#d4c7e1",
  "#bbd4db",
  "#efda9e",
  "#eac1ad",
  "#dad9ca",
  "#c7d0e4",
  "#d2ddc9",
  "#e5d5c1",
  "#c0dad2",
  "#e4c9d2",
  "#cbd5bc",
];
const ratios = [1.36, 1.12, 1.26, 1.39, 1.08, 1.34, 1.17, 1.29];

type LaneProps = {
  boards: Board[];
  index: number;
  paused: boolean;
  onSelect: (board: Board) => void;
  onTileFocus: (tile: HTMLElement) => void;
};

function BoardLane({
  boards,
  index,
  paused,
  onSelect,
  onTileFocus,
}: LaneProps) {
  const ref = useRef<HTMLDivElement>(null);
  const suppressClick = useRef(false);
  useEffect(() => {
    const lane = ref.current!;
    const cycle = lane.firstElementChild as HTMLElement;
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    let width = 0,
      loop = false,
      visible = false,
      mouseOver = false,
      touching = false;
    let frame = 0,
      previous = 0,
      fraction = 0;
    let drag: { x: number; left: number } | null = null;
    const speed = (index % 2 ? -1 : 1) * (18 + (index % 5) * 2);
    const wrap = (x: number) => ((x % width) + width) % width;
    function moving() {
      return (
        loop &&
        visible &&
        !paused &&
        !document.hidden &&
        !motion.matches &&
        !mouseOver &&
        !touching &&
        !lane.matches(":has(:focus-visible)")
      );
    }
    function tick(time: number) {
      frame = 0;
      if (!moving()) {
        previous = 0;
        return;
      }
      const delta = previous
        ? (speed * Math.min(time - previous, 50)) / 1000
        : 0;
      previous = time;
      fraction += delta;
      const pixels = Math.trunc(fraction);
      if (pixels) {
        lane.scrollLeft = wrap(lane.scrollLeft + pixels);
        fraction -= pixels;
      }
      frame = requestAnimationFrame(tick);
    }
    function start() {
      if (!frame && moving()) {
        previous = 0;
        frame = requestAnimationFrame(tick);
      }
    }
    function measure() {
      const initial = width === 0;
      width = cycle.offsetWidth;
      loop = cycle.childElementCount > 1;
      lane.toggleAttribute("data-loop", loop);
      if (
        initial &&
        !lane.hasAttribute("data-positioned") &&
        loop &&
        index % 2
      ) {
        lane.scrollLeft = cycle.firstElementChild!.clientWidth / 2;
        lane.setAttribute("data-positioned", "");
      }
      start();
    }
    // Native horizontal scrolling handles touch, trackpads, and keyboard focus.
    // Mouse dragging uses the same scroll position as the automatic crossflow.
    function down(event: PointerEvent) {
      if (!event.isPrimary || event.button !== 0) return;
      suppressClick.current = false;
      touching = true;
      if (event.pointerType === "mouse")
        drag = { x: event.clientX, left: lane.scrollLeft };
    }
    function move(event: PointerEvent) {
      if (!drag || !loop) return;
      const dx = event.clientX - drag.x;
      if (!suppressClick.current && Math.abs(dx) < 5) return;
      suppressClick.current = true;
      lane.setPointerCapture(event.pointerId);
      lane.scrollLeft = wrap(drag.left - dx);
    }
    function up() {
      drag = null;
      touching = false;
      start();
    }
    function enter(event: PointerEvent) {
      mouseOver = event.pointerType === "mouse";
    }
    function leave() {
      mouseOver = false;
      if (!suppressClick.current) up();
      start();
    }
    const resize = new ResizeObserver(measure);
    resize.observe(lane);
    resize.observe(cycle);
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      start();
    });
    observer.observe(lane);
    lane.addEventListener("pointerdown", down);
    lane.addEventListener("pointermove", move);
    lane.addEventListener("pointerenter", enter);
    lane.addEventListener("pointerleave", leave);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    function onFocusOut() {
      queueMicrotask(start);
    }
    lane.addEventListener("focusout", onFocusOut);
    document.addEventListener("visibilitychange", start);
    motion.addEventListener("change", start);
    measure();
    return () => {
      resize.disconnect();
      observer.disconnect();
      cancelAnimationFrame(frame);
      lane.removeEventListener("pointerdown", down);
      lane.removeEventListener("pointermove", move);
      lane.removeEventListener("pointerenter", enter);
      lane.removeEventListener("pointerleave", leave);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      lane.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("visibilitychange", start);
      motion.removeEventListener("change", start);
    };
  }, [index, paused]);

  return (
    <div className="board-lane" ref={ref}>
      {[false, true].map((copy) => (
        <div
          key={String(copy)}
          className={copy ? "lane-cycle lane-copy" : "lane-cycle"}
          aria-hidden={copy || undefined}
        >
          {boards.map((board, col) => (
            <button
              type="button"
              className="lane-card"
              key={board.id}
              tabIndex={copy ? -1 : undefined}
              aria-haspopup="dialog"
              aria-label={board.model}
              onClick={(e) => {
                if (!e.detail || !suppressClick.current) onSelect(board);
              }}
              onFocus={(e) => {
                if (e.target.matches(":focus-visible"))
                  onTileFocus(e.currentTarget);
              }}
              style={
                {
                  "--swatch":
                    swatches[
                      (col + index * 4 + Math.floor(index / 3)) %
                        swatches.length
                    ],
                  "--ratio": ratios[(col + index * 3) % ratios.length],
                } as CSSProperties
              }
            >
              <span className="maker">{manufacturer(board.id)}</span>
              <BoardPhoto
                imageUrl={board.image_url}
                size="wall"
                className="tile-photo"
              />
              <span className="model">{board.name}</span>
              <i className="tile-plus" aria-hidden="true" />
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

export function BoardWall({
  boards = [],
  hero,
  ...props
}: Omit<LaneProps, "index" | "boards"> & {
  boards?: Board[];
  hero: ReactNode;
}) {
  // Deal the API order across the rows so different manufacturers appear together.
  const count = Math.max(1, Math.ceil(boards.length / 11));
  const rows = Array.from({ length: count }, () => [] as Board[]);
  boards.forEach((board, i) => rows[i % count].push(board));
  return (
    <section
      id="boards"
      className="board-wall"
      aria-label="Board gallery"
      tabIndex={-1}
    >
      {rows.map((row, index) => (
        <div className="wall-row" key={index}>
          {index === 0 && <div className="hero-dock">{hero}</div>}
          {!!row.length && <BoardLane {...props} boards={row} index={index} />}
        </div>
      ))}
    </section>
  );
}
