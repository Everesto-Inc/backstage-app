/**
 * TechDocs look & feel for every doc on the platform (Content addon → CSS inside the docs' shadow DOM):
 *   - sidebar: clearer entries; the CURRENT page highlighted (bold, coloured bar + tinted background)
 *     instead of Backstage's default underline
 *   - Previous / Next: visible coloured buttons (Backstage keeps MkDocs' footer but makes it transparent)
 * Uses the theme's colours (--md-primary-fg-color), so light and dark mode both work.
 */
import { useEffect } from 'react';
import { createFrontendModule } from '@backstage/frontend-plugin-api';
import { AddonBlueprint } from '@backstage/plugin-techdocs-react/alpha';
import { useShadowRoot } from '@backstage/plugin-techdocs-react';

export const STYLE_ID = 'everesto-techdocs-style';

export const TECHDOCS_CSS = `
/* ---- sidebar ---- */
.md-nav--primary .md-nav__item { margin: 2px 0; }
.md-nav--primary .md-nav__link {
  font-weight: 500;
  padding: 6px 10px;
  border-radius: 6px;
  border-left: 3px solid transparent;
  margin: 0;
}
.md-nav--primary .md-nav__link:hover {
  background: color-mix(in srgb, var(--md-primary-fg-color) 8%, transparent);
}
.md-nav__item--active > .md-nav__link,
a.md-nav__link--active {
  text-decoration: none !important;
  font-weight: 700 !important;
  color: var(--md-primary-fg-color) !important;
  background: color-mix(in srgb, var(--md-primary-fg-color) 14%, transparent);
  border-left-color: var(--md-primary-fg-color);
}
.md-nav--primary > .md-nav__title { font-weight: 700; font-size: 1.05em; }

/* ---- Previous / Next ---- */
.md-footer { background: transparent !important; }
.md-footer__inner { padding: 0 8px 10px; }
.md-footer__link {
  background: var(--md-primary-fg-color);
  color: var(--md-primary-bg-color, #fff) !important;
  border-radius: 10px;
  padding: 8px 14px;
  margin: 0 6px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.18);
  opacity: 1 !important;
}
.md-footer__link:hover { filter: brightness(1.1); }
.md-footer__title { font-weight: 600; }
.md-footer__direction { opacity: 0.85; }
`;

/** Keeps the style in the docs' shadow root (re-adds it if a page change replaces the content). */
export const EverestoDocsStyle = () => {
  const root = useShadowRoot();
  useEffect(() => {
    if (!root) return undefined;
    const ensure = () => {
      if (root.getElementById(STYLE_ID)) return;
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = TECHDOCS_CSS;
      root.appendChild(style);
    };
    ensure();
    const observer = new MutationObserver(ensure);
    observer.observe(root, { childList: true });
    return () => observer.disconnect();
  }, [root]);
  return null;
};

export const techdocsStyleModule = createFrontendModule({
  pluginId: 'techdocs',
  extensions: [
    AddonBlueprint.make({
      name: 'everesto-style',
      params: { name: 'EverestoDocsStyle', location: 'Content', component: EverestoDocsStyle },
    }),
  ],
});
