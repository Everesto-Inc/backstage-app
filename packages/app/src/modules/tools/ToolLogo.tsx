import { useTheme } from '@material-ui/core';
import BuildIcon from '@material-ui/icons/Build';
import VpnKeyIcon from '@material-ui/icons/VpnKey';
import CodeIcon from '@material-ui/icons/Code';
import SecurityIcon from '@material-ui/icons/Security';
import LockIcon from '@material-ui/icons/Lock';

// Tools without a free brand mark get a fitting icon instead of a fake logo.
const FALLBACK: Record<string, typeof BuildIcon> = {
  'secrets-scan': VpnKeyIcon, // Gitleaks
  semgrep: CodeIcon,
  sast: SecurityIcon, // Fortify
  secrets: LockIcon, // Infisical
};
import { LOGOS } from './logos';
import { Tool } from './tools';

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** Brand mark on a soft tinted tile. Near-black marks switch to light ink in dark mode. */
export const ToolLogo = ({ tool, size = 36 }: { tool: Tool; size?: number }) => {
  const theme = useTheme();
  const dark = theme.palette.type === 'dark';
  const logo = tool.logo ? LOGOS[tool.logo] : undefined;
  const ink = logo
    ? dark && luminance(logo.hex) < 0.2
      ? theme.palette.text.primary
      : logo.hex
    : theme.palette.text.secondary;
  const tile = {
    width: size,
    height: size,
    borderRadius: 10,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    background: `${logo && !(dark && luminance(logo.hex) < 0.2) ? logo.hex : theme.palette.text.secondary}1f`,
  } as const;
  return (
    <span style={tile} title={tool.name}>
      {logo ? (
        <svg viewBox="0 0 24 24" width={size * 0.55} height={size * 0.55} role="img" aria-label={tool.name}>
          <path d={logo.path} fill={ink} />
        </svg>
      ) : (
        (() => {
          const Icon = FALLBACK[tool.id] ?? BuildIcon;
          return <Icon style={{ fontSize: size * 0.5, color: ink }} aria-label={tool.name} />;
        })()
      )}
    </span>
  );
};
