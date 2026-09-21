import * as stylex from '@stylexjs/stylex';
import { color, font } from '../../web/src/ui/tokens.stylex';
import { FeatureRow } from './feature_row';
import { FEATURES, FEATURES_PAGE, MORE_FEATURES } from './features';
import { layout } from './layout.stylex';
import { Bullets, Paragraph, SectionTitle, Title } from './prose';
import { mount } from './site';
import { Speed } from './speed';

const WIDE = '@media (min-width: 960px)';

const styles = stylex.create({
  intro: {
    paddingTop: { default: '40px', [WIDE]: '64px' },
    paddingBottom: '24px',
  },
  section: {
    paddingBlock: { default: '40px', [WIDE]: '64px' },
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: color.slate,
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
  split: {
    display: 'grid',
    gridTemplateColumns: { default: null, [WIDE]: 'minmax(0, 1fr) minmax(0, 1fr)' },
    gap: '24px 48px',
  },
  comingSoon: {
    columnCount: { default: null, [WIDE]: 2 },
    columnGap: '48px',
  },
});

function FeaturesPage(): JSX.Element {
  return (
    <>
      <header {...stylex.props(styles.intro)}>
        <Title>{FEATURES_PAGE.title}</Title>
        <Paragraph muted>{FEATURES_PAGE.lead}</Paragraph>
      </header>
      <Speed />
      {FEATURES.map((feature, index) => (
        <FeatureRow key={feature.id} feature={feature} flipped={index % 2 === 1} />
      ))}
      <section {...stylex.props(styles.section)}>
        <SectionTitle>{FEATURES_PAGE.moreHeading}</SectionTitle>
        <div {...stylex.props(styles.cards)}>
          {MORE_FEATURES.map((feature) => (
            <article key={feature.id} id={feature.id} {...stylex.props(styles.card)}>
              <h3 {...stylex.props(styles.cardTitle)}>{feature.title}</h3>
              <Paragraph muted style={styles.cardBody}>
                {feature.body}
              </Paragraph>
            </article>
          ))}
        </div>
      </section>
      <section id="coming-soon" {...stylex.props(styles.section)}>
        <SectionTitle>{FEATURES_PAGE.comingSoonHeading}</SectionTitle>
        <Bullets items={FEATURES_PAGE.comingSoon} style={styles.comingSoon} />
      </section>
      <section id="stability" {...stylex.props(styles.section, styles.split)}>
        <div>
          <SectionTitle>{FEATURES_PAGE.stabilityHeading}</SectionTitle>
          {FEATURES_PAGE.stability.map((line) => (
            <Paragraph key={line} muted>
              {line}
            </Paragraph>
          ))}
        </div>
        <div>
          <SectionTitle>{FEATURES_PAGE.requirementsHeading}</SectionTitle>
          <Bullets items={FEATURES_PAGE.requirements} />
        </div>
      </section>
    </>
  );
}

mount('features', <FeaturesPage />);
