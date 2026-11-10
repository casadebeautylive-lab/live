"use client";

import { useEffect, useRef, useState } from "react";

type Series = { name: string; color: string; values: number[] };

const W0 = 640;

/** Chart coordinate width = its real width in pixels, so labels stay readable on a phone. */
function useChartWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(W0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}
const H = 200;
const PAD = { l: 52, r: 12, t: 12, b: 24 };

function niceTicks(min: number, max: number, count = 4): number[] {
  if (min === max) return [min];
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? step0;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}

const money = (v: number) => (Math.abs(v) >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v.toFixed(0)}`);

/** Multi-series line chart with a shared hover readout. */
export function LineChart({ labels, series, height = H }: { labels: string[]; series: Series[]; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const [ref, W] = useChartWidth();
  if (!labels.length) return <Empty />;
  const all = series.flatMap((s) => s.values);
  const lo = Math.min(0, ...all);
  const hi = Math.max(1, ...all);
  const ticks = niceTicks(lo, hi);
  const y0 = Math.min(lo, ticks[0]);
  const y1 = Math.max(hi, ticks[ticks.length - 1]);
  const x = (i: number) => PAD.l + (labels.length === 1 ? 0 : (i * (W - PAD.l - PAD.r)) / (labels.length - 1));
  const y = (v: number) => PAD.t + ((y1 - v) * (height - PAD.t - PAD.b)) / (y1 - y0 || 1);

  return (
    <div className="relative" ref={ref}>
      <svg
        viewBox={`0 0 ${W} ${height}`}
        className="h-auto w-full"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          const i = Math.round(((px - PAD.l) / (W - PAD.l - PAD.r)) * (labels.length - 1));
          setHover(Math.max(0, Math.min(labels.length - 1, i)));
        }}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke={t === 0 ? "#3a404b" : "#1d2128"} />
            <text x={PAD.l - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="#5b6270" className="num">
              {money(t)}
            </text>
          </g>
        ))}
        {series.map((s) => (
          <polyline
            key={s.name}
            fill="none"
            stroke={s.color}
            strokeWidth="2"
            strokeLinejoin="round"
            points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(" ")}
          />
        ))}
        {[0, Math.floor((labels.length - 1) / 2), labels.length - 1]
          .filter((v, i, a) => a.indexOf(v) === i)
          .map((i) => (
            <text key={i} x={x(i)} y={height - 6} textAnchor={i === 0 ? "start" : i === labels.length - 1 ? "end" : "middle"} fontSize="11" fill="#5b6270">
              {labels[i]}
            </text>
          ))}
        {hover !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={height - PAD.b} stroke="#3a404b" />
            {series.map((s) => (
              <circle key={s.name} cx={x(hover)} cy={y(s.values[hover])} r="3.5" fill={s.color} />
            ))}
          </g>
        )}
      </svg>
      <div className="mt-2 flex flex-wrap gap-4 text-xs text-muted">
        {series.map((s) => (
          <span key={s.name} className="flex items-center gap-1.5">
            <span className="h-0.5 w-3 rounded" style={{ background: s.color }} />
            {s.name}
            {hover !== null && <span className="num text-ink">{money(s.values[hover])}</span>}
          </span>
        ))}
        {hover !== null && <span className="ml-auto">{labels[hover]}</span>}
      </div>
    </div>
  );
}

/**
 * Bar chart that handles negative values (a quiet minute loses money).
 * Positive bars use `color`, negative bars `negColor`; bars are drawn from zero.
 */
export function BarChart({
  labels,
  values,
  color = "#d9b26b",
  negColor = "#f87171",
  unit = "",
  format,
  height = 140,
  highlight,
}: {
  labels: string[];
  values: number[];
  color?: string;
  negColor?: string;
  unit?: string;
  format?: "money";
  height?: number;
  highlight?: [number, number];
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [ref, W] = useChartWidth();
  if (!labels.length) return <Empty />;
  const h = height;
  const hi = Math.max(0, ...values);
  const lo = Math.min(0, ...values);
  const span = hi - lo || 1;
  const plotH = h - PAD.t - PAD.b;
  const y = (v: number) => PAD.t + ((hi - v) * plotH) / span;
  const bw = (W - PAD.l - PAD.r) / values.length;
  const fmt = (v: number) => (format === "money" ? (Math.abs(v) < 100 ? `$${v.toFixed(2)}` : money(v)) : String(Math.round(v * 100) / 100));
  return (
    <div ref={ref}>
      <svg viewBox={`0 0 ${W} ${h}`} className="h-auto w-full" onMouseLeave={() => setHover(null)}>
        {highlight && (
          <rect x={PAD.l + highlight[0] * bw} y={PAD.t} width={(highlight[1] - highlight[0] + 1) * bw} height={plotH} fill="#d9b26b" opacity="0.07" />
        )}
        <text x={PAD.l - 8} y={y(hi) + 4} textAnchor="end" fontSize="11" fill="#5b6270" className="num">{fmt(hi)}</text>
        {lo < 0 && <text x={PAD.l - 8} y={y(lo) + 4} textAnchor="end" fontSize="11" fill="#5b6270" className="num">{fmt(lo)}</text>}
        <line x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} stroke="#3a404b" />
        {values.map((v, i) => {
          const top = v >= 0 ? y(v) : y(0);
          const bh = Math.max(v === 0 ? 0 : 1, Math.abs(y(v) - y(0)));
          return (
            <rect
              key={i}
              x={PAD.l + i * bw + (bw > 4 ? 1 : 0)}
              y={top}
              width={Math.max(1, bw - (bw > 4 ? 2 : 0))}
              height={bh}
              rx={bw > 6 ? 2 : 0}
              fill={v < 0 ? negColor : color}
              opacity={hover === null || hover === i ? 0.9 : 0.4}
              onMouseEnter={() => setHover(i)}
            />
          );
        })}
        {/* wide invisible hit areas so thin bars are easy to hover/tap */}
        {values.map((_, i) => (
          <rect key={`h${i}`} x={PAD.l + i * bw} y={PAD.t} width={bw} height={plotH} fill="transparent" onMouseEnter={() => setHover(i)} onTouchStart={() => setHover(i)} />
        ))}
        <text x={PAD.l} y={h - 6} fontSize="11" fill="#5b6270">{labels[0]}</text>
        <text x={W - PAD.r} y={h - 6} fontSize="11" fill="#5b6270" textAnchor="end">{labels[labels.length - 1]}</text>
      </svg>
      <div className="mt-1 h-4 text-xs text-muted">
        {hover !== null && (
          <span>
            {labels[hover]} · <span className={`num ${values[hover] < 0 ? "text-neg" : "text-ink"}`}>{fmt(values[hover])}</span> {unit}
          </span>
        )}
      </div>
    </div>
  );
}

function Empty() {
  return <div className="flex h-32 items-center justify-center text-sm text-faint">No data yet</div>;
}
