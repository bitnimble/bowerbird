import * as stylex from '@stylexjs/stylex';
import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../web/src/app/global.css';
import { focusRing } from '../../web/src/ui/focus_ring';
import { Text } from '../../web/src/ui/text';
import { color, font } from '../../web/src/ui/tokens.stylex';
import { REPO_URL, RELEASES_URL, SITE } from './features';
import { layout } from './layout.stylex';

const HOME_URL = import.meta.env.BASE_URL;
export const FEATURES_URL = `${import.meta.env.BASE_URL}features.html`;

const FINE = '@media (pointer: fine)';

const styles = stylex.create({
  html: {
    scrollBehavior: { default: 'smooth', '@media (prefers-reduced-motion: reduce)': 'auto' },
  },
  body: {
    backgroundColor: color.ink,
    color: color.bone,
    fontFamily: font.body,
    fontSize: '15px',
    WebkitFontSmoothing: 'antialiased',
  },
  // global.css pins #root to the viewport's height, which lets the sticky header scroll away with it.
  root: {
    height: 'auto',
  },
  page: {
    maxWidth: '1320px',
    marginBlock: 0,
    marginInline: 'auto',
    paddingBlock: 0,
    paddingInline: layout.pageX,
  },
  header: {
    position: 'sticky',
    top: 0,
    zIndex: 20,
    height: layout.headerH,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '16px',
    paddingBlock: 0,
    paddingInline: layout.pageX,
    backgroundColor: color.ink,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: color.slate,
  },
  brand: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '10px',
    fontFamily: font.display,
    fontWeight: 600,
    fontSize: '17px',
  },
  nav: {
    display: 'flex',
    gap: '18px',
    fontSize: '14px',
  },
  footer: {
    maxWidth: '1320px',
    marginTop: '64px',
    marginInline: 'auto',
    marginBottom: 0,
    paddingTop: '24px',
    paddingInline: layout.pageX,
    paddingBottom: '40px',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: color.slate,
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: '12px',
    fontSize: '13px',
  },
  link: {
    textDecorationLine: {
      default: 'underline',
      [FINE]: { default: 'none', ':hover': 'underline', ':focus-visible': 'underline' },
    },
    textDecorationColor: { default: color.boneDim, ':hover': color.satin, ':focus-visible': color.satin },
    textUnderlineOffset: '2px',
    color: { default: null, '[aria-current=page]': color.glass },
  },
  bower: { fill: color.bower },
  satin: { fill: color.satin },
  glass: { fill: color.glass },
  slate: { fill: color.slate },
});

type Page = 'home' | 'features';

export function mount(page: Page, content: ReactNode): void {
  const root = document.getElementById('root');
  if (root == null) throw new Error('No #root element to mount into');
  document.documentElement.className = stylex.props(styles.html).className ?? '';
  document.body.className = stylex.props(styles.body).className ?? '';
  root.className = stylex.props(styles.root).className ?? '';
  createRoot(root).render(
    <StrictMode>
      <Header page={page} />
      <main {...stylex.props(styles.page)}>{content}</main>
      <Footer />
    </StrictMode>,
  );
}

function Header({ page }: { page: Page }): JSX.Element {
  return (
    <header {...stylex.props(styles.header)}>
      <a {...stylex.props(styles.brand, focusRing.ring)} href={HOME_URL}>
        <Mark />
        {SITE.name}
      </a>
      <nav {...stylex.props(styles.nav)}>
        <SiteLink href={HOME_URL} current={page === 'home'}>
          {SITE.nav.home}
        </SiteLink>
        <SiteLink href={FEATURES_URL} current={page === 'features'}>
          {SITE.nav.features}
        </SiteLink>
        <SiteLink href={RELEASES_URL}>{SITE.nav.download}</SiteLink>
      </nav>
    </header>
  );
}

function Footer(): JSX.Element {
  return (
    <footer {...stylex.props(styles.footer)}>
      <Text variant="muted">{SITE.footer}</Text>
      <SiteLink href={REPO_URL}>{SITE.sourceCode}</SiteLink>
    </footer>
  );
}

/** `TextLink`'s look on a plain anchor: the web one is a router link. */
function SiteLink({ href, current = false, children }: { href: string; current?: boolean; children: ReactNode }): JSX.Element {
  return (
    <a {...stylex.props(styles.link, focusRing.ring)} href={href} aria-current={current ? 'page' : undefined}>
      {children}
    </a>
  );
}

function Mark(): JSX.Element {
  return (
    <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="4" {...stylex.props(styles.bower)} />
      <rect x="5" y="9" width="22" height="4" {...stylex.props(styles.satin)} />
      <rect x="5" y="16" width="11" height="4" {...stylex.props(styles.glass)} />
      <rect x="5" y="23" width="17" height="4" {...stylex.props(styles.slate)} />
    </svg>
  );
}
