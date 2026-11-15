import { createFrontendModule } from '@backstage/frontend-plugin-api';
import { ThemeBlueprint } from '@backstage/plugin-app-react';
import {
  UnifiedThemeProvider,
  createUnifiedTheme,
  genPageTheme,
  palettes,
} from '@backstage/theme';
import LightIcon from '@material-ui/icons/WbSunny';
import DarkIcon from '@material-ui/icons/Brightness2';

/**
 * everesto theme — flat, quiet, one accent (blue).
 * Colors follow the data-viz reference palette so charts and UI share one system:
 *   accent   #2a78d6 / dark #3987e5
 *   status   good #0ca30c · warning #fab219 · critical #d03b3b (always with icon + label)
 *   surfaces light page #f9f9f7, card #fcfcfb · dark page #0d0d0d, card #1a1a19
 */
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

const STATUS = { good: '#0ca30c', warning: '#fab219', critical: '#d03b3b' };

// Page headers: flat tone, no decorative shapes.
const header = (from: string, to: string) =>
  genPageTheme({ colors: [from, to], shape: 'none' });

const pageTheme = {
  home: header('#1c5cab', '#2a78d6'),
  documentation: header('#1c5cab', '#2a78d6'),
  tool: header('#1c5cab', '#2a78d6'),
  service: header('#1c5cab', '#2a78d6'),
  website: header('#1c5cab', '#2a78d6'),
  library: header('#1c5cab', '#2a78d6'),
  other: header('#1c5cab', '#2a78d6'),
  app: header('#1c5cab', '#2a78d6'),
  apis: header('#1c5cab', '#2a78d6'),
  card: header('#1c5cab', '#2a78d6'),
};

const components = (mode: 'light' | 'dark') => {
  const border = mode === 'light' ? 'rgba(11,11,11,0.10)' : 'rgba(255,255,255,0.10)';
  return {
    MuiPaper: {
      styleOverrides: {
        rounded: { borderRadius: 12 },
        elevation1: { boxShadow: 'none', border: `1px solid ${border}` },
        elevation2: { boxShadow: 'none', border: `1px solid ${border}` },
      },
    },
    MuiCard: { styleOverrides: { root: { borderRadius: 12 } } },
    MuiButton: {
      styleOverrides: {
        root: { textTransform: 'none' as const, borderRadius: 8, fontWeight: 600 },
      },
    },
    MuiChip: { styleOverrides: { root: { borderRadius: 8, fontWeight: 600 } } },
    MuiTab: { styleOverrides: { root: { textTransform: 'none' as const, fontWeight: 600 } } },
  };
};

const light = createUnifiedTheme({
  fontFamily: FONT,
  defaultPageTheme: 'home',
  pageTheme,
  components: components('light'),
  palette: {
    ...palettes.light,
    primary: { main: '#2a78d6' },
    secondary: { main: '#52514e' },
    background: { default: '#f9f9f7', paper: '#fcfcfb' },
    text: { primary: '#0b0b0b', secondary: '#52514e' },
    divider: '#e1e0d9',
    status: {
      ...palettes.light.status,
      ok: STATUS.good,
      warning: STATUS.warning,
      error: STATUS.critical,
      running: '#2a78d6',
      pending: STATUS.warning,
    },
    navigation: {
      ...palettes.light.navigation,
      background: '#0d0d0d',
      indicator: '#3987e5',
      color: '#c3c2b7',
      selectedColor: '#ffffff',
      navItem: { hoverBackground: '#1a1a19' },
    },
  },
});

const dark = createUnifiedTheme({
  fontFamily: FONT,
  defaultPageTheme: 'home',
  pageTheme,
  components: components('dark'),
  palette: {
    ...palettes.dark,
    primary: { main: '#3987e5' },
    secondary: { main: '#c3c2b7' },
    background: { default: '#0d0d0d', paper: '#1a1a19' },
    text: { primary: '#f0efec', secondary: '#c3c2b7' },
    divider: '#2c2c2a',
    status: {
      ...palettes.dark.status,
      ok: STATUS.good,
      warning: STATUS.warning,
      error: STATUS.critical,
      running: '#3987e5',
      pending: STATUS.warning,
    },
    navigation: {
      ...palettes.dark.navigation,
      background: '#000000',
      indicator: '#3987e5',
      color: '#c3c2b7',
      selectedColor: '#ffffff',
      navItem: { hoverBackground: '#1a1a19' },
    },
  },
});

const lightTheme = ThemeBlueprint.make({
  name: 'everesto-light',
  params: {
    theme: {
      id: 'everesto-light',
      title: 'Light',
      variant: 'light',
      icon: <LightIcon />,
      Provider: ({ children }) => <UnifiedThemeProvider theme={light}>{children}</UnifiedThemeProvider>,
    },
  },
});

const darkTheme = ThemeBlueprint.make({
  name: 'everesto-dark',
  params: {
    theme: {
      id: 'everesto-dark',
      title: 'Dark',
      variant: 'dark',
      icon: <DarkIcon />,
      Provider: ({ children }) => <UnifiedThemeProvider theme={dark}>{children}</UnifiedThemeProvider>,
    },
  },
});

export const themeModule = createFrontendModule({
  pluginId: 'app',
  extensions: [lightTheme, darkTheme],
});
