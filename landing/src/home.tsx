import * as stylex from '@stylexjs/stylex';
import { Button } from '../../web/src/ui/button';
import { focusRing } from '../../web/src/ui/focus_ring';
import { Row } from '../../web/src/ui/row';
import { Text } from '../../web/src/ui/text';
import { color, font } from '../../web/src/ui/tokens.stylex';
import { FeatureRow } from './feature_row';
import { FEATURES, HDR, HOME, RELEASES_URL, SITE } from './features';
import { Paragraph, SectionTitle, Title } from './prose';
import { Shot } from './shot';
import { FEATURES_URL, mount } from './site';
import { Speed } from './speed';

const WIDE = '@media (min-width: 960px)';

const styles = stylex.create({
  hero: {
    paddingTop: { default: '48px', [WIDE]: '88px' },
    paddingBottom: { default: '40px', [WIDE]: '64px' },
  },
  headline: {
    maxWidth: '24ch',
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
  section: {
    marginTop: '64px',
  },
  split: {
    display: 'grid',
    gridTemplateColumns: { default: null, [WIDE]: 'minmax(0, 5fr) minmax(0, 7fr)' },
    gap: '8px 56px',
    alignItems: 'start',
  },
  free: {
    maxWidth: '60ch',
  },
  index: {
    display: 'grid',
    gridTemplateColumns: { default: null, [WIDE]: 'minmax(0, 1fr) minmax(0, 1fr)' },
    columnGap: '56px',
  },
  entry: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    paddingBlock: '16px',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: color.slate,
    lineHeight: 1.5,
    color: { default: null, ':hover': color.glass },
  },
  entryTitle: {
    fontFamily: font.display,
    fontWeight: 600,
    fontSize: '18px',
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
});

function Home(): JSX.Element {
  return (
    <>
      <section {...stylex.props(styles.hero)}>
        <Title style={styles.headline}>{HOME.headline}</Title>
        <Paragraph muted style={styles.lead}>
          {HOME.lead}
        </Paragraph>
        <Row style={styles.actions}>
          <Button variant="primary" render={<a href={RELEASES_URL} />}>
            {SITE.nav.download}
          </Button>
          <Button render={<a href={FEATURES_URL} />}>{HOME.seeFeatures}</Button>
        </Row>
        <Shot shot={HOME.heroShot} />
      </section>

      <Speed />

      <FeatureRow feature={HDR} />

      <section>
        <SectionTitle>{HOME.featuresHeading}</SectionTitle>
        <div {...stylex.props(styles.index)}>
          {FEATURES.filter((feature) => feature !== HDR).map((feature) => (
            <a key={feature.id} {...stylex.props(styles.entry, focusRing.ring)} href={`${FEATURES_URL}#${feature.id}`}>
              <span {...stylex.props(styles.entryTitle)}>{feature.title}</span>
              <Text variant="muted">{feature.summary}</Text>
            </a>
          ))}
        </div>
      </section>

      <section {...stylex.props(styles.section, styles.split)}>
        <SectionTitle>{HOME.freeHeading}</SectionTitle>
        <div {...stylex.props(styles.free)}>
          <Paragraph muted>{HOME.freeBody}</Paragraph>
          <div {...stylex.props(styles.notice)}>
            <Paragraph style={styles.noticeText}>{HOME.stabilityBody}</Paragraph>
          </div>
          <Button variant="primary" render={<a href={RELEASES_URL} />}>
            {SITE.nav.download}
          </Button>
        </div>
      </section>
    </>
  );
}

mount('home', <Home />);
