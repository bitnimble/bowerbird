import * as stylex from '@stylexjs/stylex';
import { focusRing } from '../../web/src/ui/focus_ring';
import { Heading } from '../../web/src/ui/heading';
import { color, size } from '../../web/src/ui/tokens.stylex';
import { DEMOS } from './demos/demos';
import { FEATURES, FEATURES_PAGE, type Feature } from './features';
import { layout } from './layout.stylex';
import { Bullets, Paragraph, Title } from './prose';
import { Shot } from './shot';
import { mount } from './site';

const WIDE = '@media (min-width: 960px)';

const styles = stylex.create({
  features: {
    display: 'grid',
    gridTemplateColumns: { default: null, [WIDE]: '210px minmax(0, 1fr)' },
    gap: '0 48px',
  },
  nav: {
    position: 'sticky',
    top: { default: layout.headerH, [WIDE]: `calc(${layout.headerH} + 24px)` },
    zIndex: 10,
    alignSelf: { default: null, [WIDE]: 'start' },
    display: 'flex',
    flexDirection: { default: null, [WIDE]: 'column' },
    gap: '2px',
    maxHeight: { default: null, [WIDE]: `calc(100vh - ${layout.headerH} - 48px)` },
    overflowX: 'auto',
    overflowY: { default: null, [WIDE]: 'auto' },
    scrollbarWidth: 'none',
    marginTop: { default: 0, [WIDE]: '40px' },
    marginBottom: 0,
    marginInline: { default: `calc(-1 * ${layout.pageX})`, [WIDE]: 0 },
    paddingBlock: { default: '8px', [WIDE]: 0 },
    paddingInline: { default: layout.pageX, [WIDE]: 0 },
    backgroundColor: { default: color.ink, [WIDE]: 'transparent' },
    borderBottomWidth: { default: '1px', [WIDE]: 0 },
    borderBottomStyle: 'solid',
    borderBottomColor: color.slate,
  },
  navLink: {
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
    paddingBlock: '5px',
    paddingInline: '9px',
    borderRadius: size.radius,
    backgroundColor: { default: null, ':hover': color.slateSoft },
    color: { default: color.boneDim, ':hover': color.bone },
    fontSize: '13px',
    whiteSpace: 'nowrap',
  },
  intro: {
    paddingTop: '40px',
    paddingInline: 0,
    paddingBottom: '16px',
  },
  feature: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
    paddingBlock: '40px',
    paddingInline: 0,
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: color.slate,
    scrollMarginTop: { default: `calc(${layout.headerH} + 52px)`, [WIDE]: `calc(${layout.headerH} + 16px)` },
  },
  tagline: {
    color: color.glass,
    fontSize: '16px',
  },
});

const EXTRA_SECTIONS = [
  { id: 'coming-soon', title: FEATURES_PAGE.comingSoonHeading },
  { id: 'stability', title: FEATURES_PAGE.stabilityHeading },
];

function FeaturesPage(): JSX.Element {
  return (
    <div {...stylex.props(styles.features)}>
      <nav {...stylex.props(styles.nav)} aria-label={FEATURES_PAGE.navLabel}>
        {[...FEATURES, ...EXTRA_SECTIONS].map((section) => (
          <a key={section.id} {...stylex.props(styles.navLink, focusRing.ring)} href={`#${section.id}`}>
            {section.title}
          </a>
        ))}
      </nav>
      <div>
        <header {...stylex.props(styles.intro)}>
          <Title>{FEATURES_PAGE.title}</Title>
          <Paragraph muted>{FEATURES_PAGE.lead}</Paragraph>
        </header>
        {FEATURES.map((feature) => (
          <FeatureSection key={feature.id} feature={feature} />
        ))}
        <section id="coming-soon" {...stylex.props(styles.feature)}>
          <div>
            <Heading>{FEATURES_PAGE.comingSoonHeading}</Heading>
            <Bullets items={FEATURES_PAGE.comingSoon} />
          </div>
        </section>
        <section id="stability" {...stylex.props(styles.feature)}>
          <div>
            <Heading>{FEATURES_PAGE.stabilityHeading}</Heading>
            {FEATURES_PAGE.stability.map((line) => (
              <Paragraph key={line} muted>
                {line}
              </Paragraph>
            ))}
            <Heading>{FEATURES_PAGE.requirementsHeading}</Heading>
            <Bullets items={FEATURES_PAGE.requirements} />
          </div>
        </section>
      </div>
    </div>
  );
}

function FeatureSection({ feature }: { feature: Feature }): JSX.Element {
  const Demo = feature.demo == null ? null : DEMOS[feature.demo];
  return (
    <section id={feature.id} {...stylex.props(styles.feature)}>
      <div>
        <Heading>{feature.title}</Heading>
        <Paragraph style={styles.tagline}>{feature.tagline}</Paragraph>
        {feature.body.map((paragraph) => (
          <Paragraph key={paragraph} muted>
            {paragraph}
          </Paragraph>
        ))}
      </div>
      {Demo != null && <Demo />}
      {feature.shot != null && <Shot shot={feature.shot} />}
    </section>
  );
}

mount('features', <FeaturesPage />);
