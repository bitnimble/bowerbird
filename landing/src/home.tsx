import * as stylex from '@stylexjs/stylex';
import { Button } from '../../web/src/ui/button';
import { focusRing } from '../../web/src/ui/focus_ring';
import { Row } from '../../web/src/ui/row';
import { Text } from '../../web/src/ui/text';
import { color, font } from '../../web/src/ui/tokens.stylex';
import { HdrDemo } from './demos/hdr_demo';
import { FEATURES, HOME, RELEASES_URL, SITE } from './features';
import { Bullets, Paragraph, SectionTitle, Title } from './prose';
import { Shot } from './shot';
import { FEATURES_URL, mount } from './site';

const WIDE = '@media (min-width: 960px)';

const styles = stylex.create({
  hero: {
    display: 'grid',
    gridTemplateColumns: { default: null, [WIDE]: 'minmax(0, 5fr) minmax(0, 7fr)' },
    gap: '32px',
    alignItems: 'center',
    paddingTop: { default: '48px', [WIDE]: '72px' },
    paddingInline: 0,
    paddingBottom: '16px',
  },
  pitch: {
    fontFamily: font.display,
    fontSize: '21px',
    fontWeight: 500,
    lineHeight: 1.35,
    color: color.glass,
  },
  lead: {
    maxWidth: '58ch',
  },
  actions: {
    marginTop: '20px',
  },
  section: {
    marginTop: '64px',
  },
  split: {
    display: 'grid',
    gridTemplateColumns: { default: null, [WIDE]: 'minmax(0, 2fr) minmax(0, 3fr)' },
    gap: '24px 48px',
    alignItems: 'start',
  },
  splitEven: {
    gridTemplateColumns: { default: null, [WIDE]: 'minmax(0, 1fr) minmax(0, 1fr)' },
  },
  cards: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))',
    gap: '12px',
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    padding: '16px',
    backgroundColor: color.slateSoft,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: { default: color.slate, ':hover': color.satin },
    borderRadius: '6px',
    lineHeight: 1.5,
    transition: 'border-color 150ms ease',
  },
  cardTitle: {
    fontFamily: font.display,
    fontWeight: 600,
    fontSize: '17px',
  },
  cardMore: {
    marginTop: 'auto',
    paddingTop: '8px',
    color: color.glass,
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
        <div>
          <Title>{SITE.name}</Title>
          <Paragraph style={styles.pitch}>{HOME.pitch}</Paragraph>
          <Paragraph muted style={styles.lead}>
            {HOME.lead}
          </Paragraph>
          <Row style={styles.actions}>
            <Button variant="primary" render={<a href={RELEASES_URL} />}>
              {SITE.nav.download}
            </Button>
            <Button render={<a href={FEATURES_URL} />}>{HOME.seeFeatures}</Button>
          </Row>
        </div>
        <Shot shot={HOME.heroShot} />
      </section>

      <section {...stylex.props(styles.section)}>
        <SectionTitle>{HOME.keyHeading}</SectionTitle>
        <div {...stylex.props(styles.cards)}>
          {FEATURES.filter((feature) => feature.key).map((feature) => (
            <a key={feature.id} {...stylex.props(styles.card, focusRing.ring)} href={`${FEATURES_URL}#${feature.id}`}>
              <span {...stylex.props(styles.cardTitle)}>{feature.title}</span>
              <Text variant="muted">{feature.tagline}</Text>
              <Text variant="mono" style={styles.cardMore}>
                {HOME.more}
              </Text>
            </a>
          ))}
        </div>
      </section>

      <section {...stylex.props(styles.section, styles.split)}>
        <div>
          <SectionTitle>{HOME.tryHeading}</SectionTitle>
          <Paragraph muted>{HOME.tryBody}</Paragraph>
        </div>
        <HdrDemo />
      </section>

      <section {...stylex.props(styles.section, styles.split, styles.splitEven)}>
        <div>
          <SectionTitle>{HOME.whoHeading}</SectionTitle>
          <Paragraph>{HOME.whoIntro}</Paragraph>
          <Bullets items={HOME.whoList} />
          <Paragraph muted>{HOME.whoPeople}</Paragraph>
          <Paragraph muted>{HOME.whoNot}</Paragraph>
        </div>
        <div>
          <SectionTitle>{HOME.freeHeading}</SectionTitle>
          <Paragraph muted>{HOME.freeBody}</Paragraph>
          <div {...stylex.props(styles.notice)}>
            <Paragraph style={styles.noticeText}>{HOME.stabilityBody}</Paragraph>
          </div>
        </div>
      </section>
    </>
  );
}

mount('home', <Home />);
