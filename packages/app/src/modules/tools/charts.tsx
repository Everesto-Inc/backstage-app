import { ReactNode, useMemo, useState } from 'react';
import { Box, Typography, makeStyles, useTheme } from '@material-ui/core';

/**
 * Small, dependency-free SVG charts for the tool tabs.
 * Follows the data-viz reference: one accent hue for a single series, 2px lines,
 * hairline grid, status colors only for state (always with a label), hover tooltip
 * with crosshair on line/area and per-mark tooltip on bars.
 */

export const STATUS = { good: '#0ca30c', warning: '#fab219', critical: '#d03b3b' };

const useInk = () => {
  const dark = useTheme().palette.type === 'dark';
  return dark
    ? { series: '#3987e5', fill: 'rgba(57,135,229,0.16)', grid: '#2c2c2a', axis: '#383835', muted: '#898781', surface: '#1a1a19', text: '#f0efec' }
    : { series: '#2a78d6', fill: 'rgba(42,120,214,0.12)', grid: '#e1e0d9', axis: '#c3c2b7', muted: '#898781', surface: '#fcfcfb', text: '#0b0b0b' };
};

const useStyles = makeStyles(theme => ({
  tile: {
    border: `1px solid ${theme.palette.divider}`,
    borderRadius: 12,
    padding: theme.spacing(2),
    background: theme.palette.background.paper,
    height: '100%',
  },
  label: { color: theme.palette.text.secondary, fontSize: 13, fontWeight: 500 },
  value: { fontSize: 28, fontWeight: 650, lineHeight: 1.2, marginTop: 4 },
  delta: { fontSize: 13, color: theme.palette.text.secondary, marginTop: 2 },
  tooltip: {
    position: 'absolute',
    pointerEvents: 'none',
    transform: 'translate(-50%, calc(-100% - 10px))',
    background: theme.palette.background.paper,
    border: `1px solid ${theme.palette.divider}`,
    borderRadius: 8,
    padding: '4px 8px',
    fontSize: 12,
    whiteSpace: 'nowrap',
    boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
    zIndex: 1,
  },
  legend: { display: 'flex', gap: 16, fontSize: 12, color: theme.palette.text.secondary, marginTop: 8 },
  swatch: { width: 10, height: 10, borderRadius: 3, display: 'inline-block', marginRight: 6, verticalAlign: 'middle' },
}));

/** Area sparkline with crosshair + tooltip. Single series → accent hue, no legend. */
export const Sparkline = ({
  data,
  format = v => String(v),
  height = 56,
}: {
  data: { t: string; v: number }[];
  format?: (v: number) => string;
  height?: number;
}) => {
  const ink = useInk();
  const classes = useStyles();
  const [hover, setHover] = useState<number | undefined>();
  const W = 300;
  const pad = 4;
  const { pts, line, area } = useMemo(() => {
    const vs = data.map(d => d.v);
    const min = Math.min(...vs);
    const max = Math.max(...vs);
    const span = max - min || 1;
    const p = data.map((d, i) => ({
      x: pad + (i * (W - 2 * pad)) / Math.max(data.length - 1, 1),
      y: pad + (1 - (d.v - min) / span) * (height - 2 * pad),
    }));
    const l = p.map((q, i) => `${i ? 'L' : 'M'}${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(' ');
    return { pts: p, line: l, area: `${l} L${p[p.length - 1].x},${height} L${p[0].x},${height} Z` };
  }, [data, height]);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    let best = 0;
    pts.forEach((q, i) => {
      if (Math.abs(q.x - x) < Math.abs(pts[best].x - x)) best = i;
    });
    setHover(best);
  };

  return (
    <Box position="relative" mt={1}>
      <svg
        viewBox={`0 0 ${W} ${height}`}
        width="100%"
        height={height}
        preserveAspectRatio="none"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(undefined)}
        role="img"
        aria-label={`Trend, last value ${format(data[data.length - 1].v)}`}
      >
        <path d={area} fill={ink.fill} />
        <path d={line} fill="none" stroke={ink.series} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        {hover !== undefined && (
          <>
            <line x1={pts[hover].x} x2={pts[hover].x} y1={0} y2={height} stroke={ink.axis} strokeWidth={1} vectorEffect="non-scaling-stroke" />
          </>
        )}
      </svg>
      {hover !== undefined && (
        <>
          <Box
            position="absolute"
            style={{
              left: `${(pts[hover].x / W) * 100}%`,
              top: pts[hover].y,
              width: 8,
              height: 8,
              marginLeft: -4,
              marginTop: -4,
              borderRadius: '50%',
              background: ink.series,
              boxShadow: `0 0 0 2px ${ink.surface}`,
              pointerEvents: 'none',
            }}
          />
          <div className={classes.tooltip} style={{ left: `${(pts[hover].x / W) * 100}%`, top: pts[hover].y }}>
            <b>{format(data[hover].v)}</b> · {data[hover].t}
          </div>
        </>
      )}
    </Box>
  );
};

/** Stat tile: label, value, optional delta line and sparkline. */
export const StatTile = ({
  label,
  value,
  delta,
  children,
}: {
  label: string;
  value: ReactNode;
  delta?: ReactNode;
  children?: ReactNode;
}) => {
  const classes = useStyles();
  return (
    <div className={classes.tile}>
      <div className={classes.label}>{label}</div>
      <div className={classes.value}>{value}</div>
      {delta && <div className={classes.delta}>{delta}</div>}
      {children}
    </div>
  );
};

/** Meter: one ratio against a limit, same-hue track. */
export const Meter = ({ value, max = 100, target }: { value: number; max?: number; target?: number }) => {
  const ink = useInk();
  const pct = Math.min(100, (value / max) * 100);
  return (
    <Box mt={1.5} position="relative" height={8} borderRadius={4} style={{ background: ink.fill }}>
      <Box height={8} borderRadius={4} style={{ width: `${pct}%`, background: ink.series }} />
      {target !== undefined && (
        <Box
          position="absolute"
          top={-3}
          height={14}
          width={2}
          style={{ left: `${(target / max) * 100}%`, background: ink.text }}
          title={`Quality gate: ${target}%`}
        />
      )}
    </Box>
  );
};

/** Column chart of CI run durations; color = run status (labelled in legend + tooltip). */
export const RunColumns = ({
  runs,
}: {
  runs: { id: string; minutes: number; ok: boolean; commit: string }[];
}) => {
  const ink = useInk();
  const classes = useStyles();
  const [hover, setHover] = useState<number | undefined>();
  const H = 140;
  const max = Math.max(...runs.map(r => r.minutes)) * 1.15;
  const gap = 2;
  const w = 100 / runs.length;

  return (
    <Box>
      <Box position="relative" height={H} mt={1}>
        {[0.5, 1].map(f => (
          <Box key={f} position="absolute" left={0} right={0} style={{ top: H - (H * f) / 1.15, borderTop: `1px solid ${ink.grid}` }}>
            <Typography variant="caption" style={{ color: ink.muted, position: 'absolute', top: -16 }}>
              {((max / 1.15) * f).toFixed(0)} min
            </Typography>
          </Box>
        ))}
        <Box position="absolute" left={0} right={0} bottom={0} style={{ borderTop: `1px solid ${ink.axis}` }} />
        {runs.map((r, i) => {
          const h = (r.minutes / max) * H;
          return (
            <Box
              key={r.id}
              position="absolute"
              bottom={0}
              style={{ left: `calc(${i * w}% + ${gap}px)`, width: `calc(${w}% - ${gap * 2}px)`, height: H, cursor: 'default' }}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(undefined)}
            >
              <Box
                position="absolute"
                bottom={0}
                left="20%"
                right="20%"
                style={{
                  height: h,
                  background: r.ok ? ink.series : STATUS.critical,
                  borderRadius: '4px 4px 0 0',
                  opacity: hover === undefined || hover === i ? 1 : 0.45,
                }}
              />
              {hover === i && (
                <div className={classes.tooltip} style={{ left: '50%', top: H - h }}>
                  <b>{r.id}</b> · {r.minutes.toFixed(1)} min · {r.ok ? '✓ success' : '✕ failed'}
                  <br />
                  {r.commit}
                </div>
              )}
            </Box>
          );
        })}
      </Box>
      <div className={classes.legend}>
        <span><span className={classes.swatch} style={{ background: ink.series }} />Success</span>
        <span><span className={classes.swatch} style={{ background: STATUS.critical }} />✕ Failed</span>
      </div>
    </Box>
  );
};
