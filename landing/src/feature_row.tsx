import * as stylex from '@stylexjs/stylex';
import { color } from '../../web/src/ui/tokens.stylex';
import { DEMOS } from './demos/demos';
import type { Feature } from './features';
import { layout } from './layout.stylex';
import { Paragraph, SectionTitle } from './prose';
import { Shot } from './shot';

const WIDE = '@media (min-width: 960px)';

const styles = stylex.create({
  row: {
    display: 'grid',
    gridTemplateColumns: { default: null, [WIDE]: 'minmax(0, 4fr) minmax(0, 7fr)' },
    gap: '24px 56px',
    alignItems: 'center',
    paddingBlock: { default: '40px', [WIDE]: '64px' },
    scrollMarginTop: layout.headerH,
  },
  flipped: {
    gridTemplateColumns: { default: null, [WIDE]: 'minmax(0, 7fr) minmax(0, 4fr)' },
  },
  visualFirst: {
    order: { default: null, [WIDE]: -1 },
  },
  summary: {
    color: color.glass,
    fontSize: '18px',
  },
  body: {
    fontSize: '16px',
  },
});

export function FeatureRow({ feature, flipped = false }: { feature: Feature; flipped?: boolean }): JSX.Element {
  return (
    <section id={feature.id} {...stylex.props(styles.row, flipped && styles.flipped)}>
      <div>
        <SectionTitle>{feature.title}</SectionTitle>
        <Paragraph style={styles.summary}>{feature.summary}</Paragraph>
        {feature.body.map((paragraph) => (
          <Paragraph key={paragraph} muted style={styles.body}>
            {paragraph}
          </Paragraph>
        ))}
      </div>
      <div {...stylex.props(flipped && styles.visualFirst)}>
        <Visual visual={feature.visual} />
      </div>
    </section>
  );
}

function Visual({ visual }: { visual: Feature['visual'] }): JSX.Element {
  if ('shot' in visual) return <Shot shot={visual.shot} />;
  const Demo = DEMOS[visual.demo];
  return <Demo />;
}
