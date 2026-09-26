import * as stylex from '@stylexjs/stylex';
import type { ReactNode } from 'react';
import { Button } from '../../web/src/ui/button';
import { Row } from '../../web/src/ui/row';
import { color, font } from '../../web/src/ui/tokens.stylex';
import { RELEASES_URL, SITE } from './features';
import { layout } from './layout.stylex';
import { Paragraph, SectionTitle } from './prose';
import { FEATURES_URL } from './site';

const WIDE = '@media (min-width: 960px)';

const styles = stylex.create({
  hero: {
    paddingTop: { default: '48px', [WIDE]: '88px' },
    paddingBottom: { default: '40px', [WIDE]: '64px' },
  },
  lead: {
    maxWidth: '56ch',
    fontSize: { default: '17px', [WIDE]: '19px' },
    lineHeight: 1.55,
  },
  actions: {
    marginTop: '24px',
    marginBottom: { default: '40px', [WIDE]: '56px' },
  },
  intro: {
    paddingTop: { default: '40px', [WIDE]: '64px' },
    paddingBottom: '24px',
  },
  split: {
    display: 'grid',
    gridTemplateColumns: { default: null, [WIDE]: 'minmax(0, 5fr) minmax(0, 7fr)' },
    gap: '8px 56px',
    alignItems: 'start',
  },
  splitBody: {
    maxWidth: '60ch',
  },
  notice: {
    backgroundColor: color.slateSoft,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: color.slate,
    borderLeftWidth: '2px',
    borderLeftColor: color.ochre,
    borderRadius: '4px',
    paddingBlock: '2px',
    paddingInline: '12px',
    marginBottom: '16px',
  },
  noticeText: {
    marginBlock: '10px',
  },
  section: {
    paddingBlock: { default: '40px', [WIDE]: '64px' },
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: color.slate,
  },
  halves: {
    display: 'grid',
    gridTemplateColumns: { default: null, [WIDE]: 'minmax(0, 1fr) minmax(0, 1fr)' },
    gap: '24px 48px',
  },
  cards: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))',
    gap: '24px 56px',
  },
  card: {
    paddingTop: '16px',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: color.slate,
    scrollMarginTop: `calc(${layout.headerH} + 16px)`,
  },
  cardTitle: {
    fontFamily: font.display,
    fontWeight: 600,
    fontSize: '17px',
    marginTop: 0,
    marginInline: 0,
    marginBottom: '6px',
  },
  cardBody: {
    marginBottom: 0,
  },
});

type Children = { children?: ReactNode };

export function Hero({ children }: Children): JSX.Element {
  return <section {...stylex.props(styles.hero)}>{children}</section>;
}

export function Lead({ children }: Children): JSX.Element {
  return (
    <Paragraph muted style={styles.lead}>
      {children}
    </Paragraph>
  );
}

export function Actions({ children }: Children): JSX.Element {
  return <Row style={styles.actions}>{children}</Row>;
}

export function DownloadButton(): JSX.Element {
  return (
    <Button variant="primary" render={<a href={RELEASES_URL} />}>
      {SITE.nav.download}
    </Button>
  );
}

export function FeaturesButton({ children }: Children): JSX.Element {
  return <Button render={<a href={FEATURES_URL} />}>{children}</Button>;
}

export function Intro({ children }: Children): JSX.Element {
  return <header {...stylex.props(styles.intro)}>{children}</header>;
}

export function Split({ title, children }: Children & { title: string }): JSX.Element {
  return (
    <section {...stylex.props(styles.split)}>
      <SectionTitle>{title}</SectionTitle>
      <div {...stylex.props(styles.splitBody)}>{children}</div>
    </section>
  );
}

export function Notice({ children }: Children): JSX.Element {
  return (
    <div {...stylex.props(styles.notice)}>
      <Paragraph style={styles.noticeText}>{children}</Paragraph>
    </div>
  );
}

export function Section({ id, children }: Children & { id?: string }): JSX.Element {
  return (
    <section id={id} {...stylex.props(styles.section)}>
      {children}
    </section>
  );
}

export function Halves({ children }: Children): JSX.Element {
  return <div {...stylex.props(styles.halves)}>{children}</div>;
}

export function Cards({ children }: Children): JSX.Element {
  return <div {...stylex.props(styles.cards)}>{children}</div>;
}

export function Card({ id, title, children }: Children & { id: string; title: string }): JSX.Element {
  return (
    <article id={id} {...stylex.props(styles.card)}>
      <h3 {...stylex.props(styles.cardTitle)}>{title}</h3>
      <Paragraph muted style={styles.cardBody}>
        {children}
      </Paragraph>
    </article>
  );
}
