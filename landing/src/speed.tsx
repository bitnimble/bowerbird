import * as stylex from '@stylexjs/stylex';
import { color } from '../../web/src/ui/tokens.stylex';
import { SPEED } from './features';
import { Paragraph, SectionTitle } from './prose';

const WIDE = '@media (min-width: 960px)';

const styles = stylex.create({
  speed: {
    display: 'grid',
    gridTemplateColumns: { default: null, [WIDE]: 'minmax(0, 5fr) minmax(0, 7fr)' },
    gap: '8px 56px',
    paddingBlock: { default: '40px', [WIDE]: '64px' },
    borderTopWidth: '1px',
    borderBottomWidth: '1px',
    borderTopStyle: 'solid',
    borderBottomStyle: 'solid',
    borderTopColor: color.slate,
    borderBottomColor: color.slate,
  },
  body: {
    fontSize: { default: '17px', [WIDE]: '19px' },
    lineHeight: 1.55,
    maxWidth: '60ch',
  },
});

export function Speed(): JSX.Element {
  return (
    <section {...stylex.props(styles.speed)}>
      <SectionTitle>{SPEED.heading}</SectionTitle>
      <div>
        {SPEED.body.map((paragraph) => (
          <Paragraph key={paragraph} style={styles.body}>
            {paragraph}
          </Paragraph>
        ))}
      </div>
    </section>
  );
}
