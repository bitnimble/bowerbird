import { Menu } from '@base-ui-components/react/menu';
import { Separator } from '@base-ui-components/react/separator';
import * as stylex from '@stylexjs/stylex';
import { Children, Fragment, isValidElement, type ReactNode } from 'react';
import { menuStyles } from './menu_styles';
import { textStyles } from './text';

/**
 * One headed group of a popup - a menu's or a popover's, which are the same object here:
 * `Menu.Group` takes its label from its own context rather than from a menu root, and
 * `Menu.Separator` is the plain separator under another name.
 */
export function Section({ label, children }: { label?: string; children: ReactNode }): JSX.Element {
  return (
    <Menu.Group {...stylex.props(menuStyles.group)}>
      {/* A menu of one subject names nothing: the heading is what tells two groups apart, and
          over a single group it is a word the reader has to skip on the way to the action. */}
      {label != null && (
        <Menu.GroupLabel {...stylex.props(textStyles.label, menuStyles.groupLabel)}>{label}</Menu.GroupLabel>
      )}
      {children}
    </Menu.Group>
  );
}

/**
 * The sections of one popup, fenced from each other by a rule.
 *
 * The rule belongs here rather than to whoever writes the sections: a popup that draws its
 * own is a popup whose headings sit at a different height from every other one's. A section
 * left out - `{hasX && <Section/>}` - takes its rule with it, `Children.toArray` dropping
 * what did not render before any of them is counted.
 *
 * An element of its own rather than a fragment, so what stands either side of a rule is
 * this component's to say: as a fragment the sections became children of whatever popup
 * held them, and a panel laid out with a `gap` spaced its rules further apart than a menu
 * whose rows sit flush.
 */
export function Sections({ children }: { children: ReactNode }): JSX.Element {
  const sections = Children.toArray(children);
  return (
    <div {...stylex.props(menuStyles.group)}>
      {sections.map((section, index) => (
        <Fragment key={isValidElement(section) ? section.key : index}>
          {index > 0 && <Separator {...stylex.props(menuStyles.rule)} />}
          {section}
        </Fragment>
      ))}
    </div>
  );
}
