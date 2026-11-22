/**
 * TechDocs look & feel for every doc on the platform (Content addon → CSS inside the docs' shadow DOM):
 *   - sidebar: clearer entries; the CURRENT page highlighted (bold, coloured bar + tinted background)
 *     instead of Backstage's default underline
 *   - Previous / Next: small outlined buttons at the end of the page, aligned with the text (Backstage pins
 *     MkDocs' footer to the bottom of the window, where it floats over the content)
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

/* ---- Previous / Next: small outlined buttons at the END of the page (not floating over the text) ---- */
.md-footer {
  position: static !important;
  background: transparent !important;
  pointer-events: auto !important;
}
.md-footer__inner {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin: 8px 16rem 32px 16rem;   /* aligned with the text column (16rem sidebars) */
  padding: 16px 0 0;
  border-top: 1px solid var(--md-default-fg-color--lightest);
}
.md-footer__link,
.md-footer-nav__link {
  width: auto !important;
  max-width: 48%;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px !important;
  margin: 0 !important;
  border: 1px solid color-mix(in srgb, var(--md-primary-fg-color) 50%, transparent);
  border-radius: 8px;
  background: transparent !important;
  color: var(--md-primary-fg-color) !important;
  box-shadow: none !important;
  opacity: 1 !important;
}
.md-footer__link:hover,
.md-footer-nav__link:hover {
  background: color-mix(in srgb, var(--md-primary-fg-color) 10%, transparent) !important;
}
.md-footer__link--next { margin-left: auto !important; }
.md-footer__button {
  position: static !important;
  flex-shrink: 0;
  margin: 0 !important;
  padding: 0 !important;
}
.md-footer__title { flex: 0 0 auto; display: flex; flex-direction: column; max-width: none !important; min-width: max-content; }
.md-footer__button svg { width: 16px; height: 16px; }
.md-footer__title {
  position: static !important;
  padding: 0 !important;
  margin: 0 !important;
  font-size: 0.8rem;
  font-weight: 600;
  line-height: 1.3;
}
.md-footer__title,
.md-footer__title .md-ellipsis {
  overflow: visible !important;
  text-overflow: clip !important;
  white-space: nowrap;
}
.md-footer__direction {
  position: static !important;
  display: inline;
  margin-right: 6px;
  font-size: 0.7rem;
  font-weight: 400;
  opacity: 0.75;
}
@media screen and (max-width: 76.1875em) {
  .md-footer__inner { margin: 8px 16px 24px; }
}
`;

/** Desktop layout only — below this width MkDocs turns the sidebars into a slide-out drawer. */
const DESKTOP = '(min-width: 76.25em)';

/**
 * Backstage pins both sidebars (position: fixed) and sets their `top` from the docs' <html> element on every
 * scroll. Embedded in an entity's Tech Docs tab that element measures 0, so at the top of the page the sidebars
 * cover the entity header (title, owner, tabs). Run after Backstage's handler and place them at the top of the
 * real content area instead: below the header at the top of the page, pinned to the window once scrolled past it,
 * and never taller than the space down to the page footer.
 */
export function placeSidebars(root: ShadowRoot) {
  if (!window.matchMedia(DESKTOP).matches) return;
  const main = root.querySelector<HTMLElement>('.md-main');
  if (!main) return;
  const top = Math.max(main.getBoundingClientRect().top, 0);
  const footer = root.querySelector<HTMLElement>('.md-container > .md-footer');
  const bottom = Math.min(footer?.getBoundingClientRect().top ?? window.innerHeight, window.innerHeight);
  root.querySelectorAll<HTMLElement>('.md-sidebar').forEach(el => {
    el.style.top = `${top}px`;
    el.style.height = `${Math.max(bottom - top, 0)}px`;
  });
}

/** Keeps the style in the docs' shadow root (re-adds it if a page change replaces the content) and keeps the
 *  sidebars below the entity header. */
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
    // after Backstage's own scroll/resize handlers (registered earlier) → our placement wins
    let frame = 0;
    const place = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => placeSidebars(root)); };
    const observer = new MutationObserver(() => { ensure(); place(); });
    observer.observe(root, { childList: true, subtree: true });
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    place();
    const settle = window.setTimeout(place, 500); // once the docs' CSS has loaded
    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
      cancelAnimationFrame(frame);
      window.clearTimeout(settle);
    };
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
