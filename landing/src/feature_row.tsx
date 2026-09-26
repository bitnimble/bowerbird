import * as stylex from '@stylexjs/stylex';
import { focusRing } from '../../web/src/ui/focus_ring';
import { Text } from '../../web/src/ui/text';
import { color, font } from '../../web/src/ui/tokens.stylex';
import { DEMOS } from './demos/demos';
import { FEATURES, featureById, type Feature } from './features';
import { layout } from './layout.stylex';
import { Paragraph, SectionTitle } from './prose';
import { Shot } from './shot';
import { FEATURES_URL } from './site';

const WIDE = '@media (min-width: 960px)';

const styles = stylex.create({
  row: {
    display: 'grid',
    gridTemplateColumns: { default: 'minmax(0, 1fr)', [WIDE]: 'minmax(0, 4fr) minmax(0, 7fr)' },
    gap: '24px 56px',
    alignItems: 'center',
    paddingBlock: { default: '40px', [WIDE]: '64px' },
    scrollMarginTop: layout.headerH,
  },
  flipped: {
    gridTemplateColumns: { default: 'minmax(0, 1fr)', [WIDE]: 'minmax(0, 7fr) minmax(0, 4fr)' },
  },
  visualFirst: {
    order: { default: null, [WIDE]: -1 },
  },
  copy: {
    fontSize: '16px',
  },
  summary: {
    color: color.glass,
    fontSize: '18px',
  },
  index: {
    display: 'grid',
    gridTemplateColumns: { default: null, [WIDE]: 'minmax(0, 1fr) minmax(0, 1fr)' },
    columnGap: '56px',
    marginBottom: '64px',
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
});

export function FeatureRow({ id, flipped = false }: { id: string; flipped?: boolean }): JSX.Element {
  const feature = featureById(id);
  return (
    <section id={feature.id} {...stylex.props(styles.row, flipped && styles.flipped)}>
      <div {...stylex.props(styles.copy)}>
        <SectionTitle>{feature.title}</SectionTitle>
        <Paragraph style={styles.summary}>{feature.summary}</Paragraph>
        <feature.Body />
      </div>
      <div {...stylex.props(flipped && styles.visualFirst)}>
        <Visual feature={feature} />
      </div>
    </section>
  );
}

export function FeatureRows(): JSX.Element {
  return (
    <>
      {FEATURES.map((feature, index) => (
        <FeatureRow key={feature.id} id={feature.id} flipped={index % 2 === 1} />
      ))}
    </>
  );
}

export function FeatureIndex({ skip }: { skip?: string }): JSX.Element {
  return (
    <div {...stylex.props(styles.index)}>
      {FEATURES.filter((feature) => feature.id !== skip).map((feature) => (
        <a key={feature.id} {...stylex.props(styles.entry, focusRing.ring)} href={`${FEATURES_URL}#${feature.id}`}>
          <span {...stylex.props(styles.entryTitle)}>{feature.title}</span>
          <Text variant="muted">{feature.summary}</Text>
        </a>
      ))}
    </div>
  );
}

function Visual({ feature }: { feature: Feature }): JSX.Element {
  if ('shot' in feature) return <Shot {...feature.shot} />;
  const Demo = DEMOS[feature.demo];
  return <Demo />;
}
