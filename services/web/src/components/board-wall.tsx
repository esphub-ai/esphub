import {
  useEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react";
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

export function distributeBoards(boards: Board[], maxRows = 8): Board[][] {
  if (!boards.length) return [[]];
  const count = Math.min(maxRows, Math.max(1, Math.ceil(boards.length / 11)));
  // Deal each vendor round-robin across rows so adjacent models from the same
  // series land in different rows, then interleave vendors within each row.
  const byVendor = new Map<string, Board[]>();
  for (const board of boards) {
    const vendor = board.id.split("/")[0];
    let list = byVendor.get(vendor);
    if (!list) {
      list = [];
      byVendor.set(vendor, list);
    }
    list.push(board);
  }
  const rows = Array.from({ length: count }, () => [] as Board[]);
  let cursor = 0;
  for (const list of byVendor.values()) {
    for (const board of list) {
      rows[cursor % count].push(board);
      cursor++;
    }
  }
  return rows.map((row, rowIndex) => {
    const groups = new Map<string, Board[]>();
    for (const board of row) {
      const vendor = board.id.split("/")[0];
      let list = groups.get(vendor);
      if (!list) {
        list = [];
        groups.set(vendor, list);
      }
      list.push(board);
    }
    const vendors = [...groups.values()];
    const phase = (rowIndex * 0.37) % 1;
    return vendors
      .flatMap((group, v) =>
        group.map((board, k) => ({
          board,
          pos: ((k + (v + 0.5) / vendors.length) / group.length + phase) % 1,
        })),
      )
      .sort((a, b) => a.pos - b.pos)
      .map((entry) => entry.board);
  });
}

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
  const pausedRef = useRef(paused);
  const resumeRef = useRef<() => void>(() => {});
  pausedRef.current = paused;

  useEffect(() => {
    resumeRef.current();
  }, [paused]);

  useEffect(() => {
    const lane = ref.current!;
    const cycle = lane.firstElementChild as HTMLElement;
    const cards = Array.from(cycle.children) as HTMLElement[];
    cards.forEach((card, i) => {
      card.style.order = String(i);
    });
    let minOrder = 0;
    let maxOrder = cards.length - 1;
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    let seam = 0,
      loop = false,
      visible = false,
      mouseOver = false,
      touching = false,
      rebalancing = false;
    let frame = 0,
      previous = 0,
      fraction = 0;
    let drag: { x: number; left: number } | null = null;
    const speed = (index % 2 ? -1 : 1) * (18 + (index % 5) * 2);

    function moving() {
      return (
        loop &&
        visible &&
        !pausedRef.current &&
        !document.hidden &&
        !motion.matches &&
        !mouseOver &&
        !touching &&
        !lane.matches(":has(:focus-visible)")
      );
    }

    // Recycle single off-screen cards with CSS order instead of cloning the lane,
    // so every board exists once in the DOM and can never appear twice on screen.
    function rebalance() {
      if (rebalancing || !loop || motion.matches || cards.length < 3) return;
      const maxScroll = lane.scrollWidth - lane.clientWidth;
      if (maxScroll <= 0) return;
      const mid = maxScroll / 2;
      rebalancing = true;
      try {
        let guard = cards.length;
        while (guard-- > 0) {
          const first = cards[0];
          const step = first.offsetWidth + seam;
          if (lane.scrollLeft > mid + step && lane.scrollLeft >= step) {
            cards.push(cards.shift()!);
            first.style.order = String(++maxOrder);
            lane.scrollLeft -= step;
            if (drag) drag.left -= step;
          } else {
            break;
          }
        }
        guard = cards.length;
        while (guard-- > 0) {
          const last = cards[cards.length - 1];
          const step = last.offsetWidth + seam;
          if (
            lane.scrollLeft < mid - step &&
            lane.scrollLeft + lane.clientWidth <=
              lane.scrollWidth - last.offsetWidth
          ) {
            cards.unshift(cards.pop()!);
            last.style.order = String(--minOrder);
            lane.scrollLeft += step;
            if (drag) drag.left += step;
          } else {
            break;
          }
        }
      } finally {
        rebalancing = false;
      }
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
        lane.scrollLeft += pixels;
        fraction -= pixels;
        rebalance();
      }
      frame = requestAnimationFrame(tick);
    }

    function start() {
      if (!frame && moving()) {
        previous = 0;
        frame = requestAnimationFrame(tick);
      }
    }
    resumeRef.current = start;

    function measure() {
      seam = parseFloat(getComputedStyle(cycle).columnGap) || 0;
      const maxScroll = lane.scrollWidth - lane.clientWidth;
      const first = cards[0];
      const last = cards[cards.length - 1];
      loop =
        cards.length > 2 &&
        !!first &&
        !!last &&
        maxScroll >= first.offsetWidth + last.offsetWidth + 2 * seam;
      lane.toggleAttribute("data-loop", loop);
      if (loop && !lane.hasAttribute("data-positioned")) {
        const stagger = index % 2 ? Math.round(first.offsetWidth / 2) : 0;
        lane.scrollLeft = Math.min(
          maxScroll,
          Math.max(0, Math.round(maxScroll / 2) + stagger),
        );
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
      lane.scrollLeft = drag.left - dx;
      rebalance();
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
    function onScroll() {
      if (!rebalancing && !lane.matches(":has(:focus-visible)")) rebalance();
    }
    function onFocusOut() {
      queueMicrotask(start);
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
    lane.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    lane.addEventListener("focusout", onFocusOut);
    document.addEventListener("visibilitychange", start);
    motion.addEventListener("change", start);
    measure();
    return () => {
      resumeRef.current = () => {};
      resize.disconnect();
      observer.disconnect();
      cancelAnimationFrame(frame);
      lane.removeEventListener("pointerdown", down);
      lane.removeEventListener("pointermove", move);
      lane.removeEventListener("pointerenter", enter);
      lane.removeEventListener("pointerleave", leave);
      lane.removeEventListener("scroll", onScroll);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      lane.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("visibilitychange", start);
      motion.removeEventListener("change", start);
    };
  }, [index, boards]);

  return (
    <div className="board-lane" ref={ref}>
      <div className="lane-cycle">
        {boards.map((board, col) => (
          <button
            type="button"
            className="lane-card"
            key={board.id}
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
                    (col + index * 4 + Math.floor(index / 3)) % swatches.length
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
  const rows = useMemo(() => distributeBoards(boards), [boards]);
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
