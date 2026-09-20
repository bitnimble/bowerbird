import * as stylex from '@stylexjs/stylex';
import { Fragment, type ReactNode } from 'react';
import { focusRing } from '../../ui/focus_ring';
import { color, font } from '../../ui/tokens.stylex';

const styles = stylex.create({
  notes: {
    fontSize: '13px',
    color: color.boneDim,
  },
  heading: {
    marginTop: '10px',
    marginInline: 0,
    marginBottom: '4px',
    color: color.bone,
    fontWeight: 600,
  },
  para: {
    marginBlock: '6px',
    marginInline: 0,
  },
  list: {
    marginBlock: '6px',
    marginInline: 0,
    paddingLeft: '18px',
  },
  link: {
    color: color.satin,
  },
  code: {
    fontFamily: font.mono,
    fontSize: '12px',
  },
});

/**
 * A release description, which is written in markdown and read here.
 *
 * ponytail: the handful of markdown a release note actually uses - a heading, a bullet,
 * a link, a bit of code - rather than a markdown dependency and the sanitiser that would
 * have to come with it. Nothing here can emit markup: every value ends up as a text node
 * or as an `href` this checks, so a release note is inert whatever it says.
 */
export function ReleaseNotes({ markdown }: { markdown: string }): JSX.Element {
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    blocks.push(
      <p key={blocks.length} {...stylex.props(styles.para)}>
        {inline(paragraph.join(' '))}
      </p>,
    );
    paragraph = [];
  };

  const flushList = (): void => {
    if (bullets.length === 0) return;
    blocks.push(
      <ul key={blocks.length} {...stylex.props(styles.list)}>
        {bullets.map((item, i) => (
          <li key={i}>{inline(item)}</li>
        ))}
      </ul>,
    );
    bullets = [];
  };

  for (const line of markdown.split('\n')) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (heading != null) {
      flushParagraph();
      flushList();
      blocks.push(
        <div key={blocks.length} {...stylex.props(styles.heading)}>
          {inline(heading[2]!)}
        </div>,
      );
    } else if (bullet != null) {
      flushParagraph();
      bullets.push(bullet[1]!);
    } else if (line.trim() === '') {
      flushParagraph();
      flushList();
    } else if (bullets.length > 0) {
      // A bullet wrapped onto the next line, which is most of them: a release note is
      // written in an editor that wraps at eighty columns, and read here at whatever
      // width the dialog is. Taken as a block of its own it breaks out of the list and
      // lands full width under it, which reads as a sentence that lost its bullet.
      bullets[bullets.length - 1] += ` ${line.trim()}`;
    } else {
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  flushList();

  return <div {...stylex.props(styles.notes)}>{blocks}</div>;
}

// A link, a code span, a bold run, or a bare URL. Alternation rather than four passes
// so that a URL already inside a link is not matched a second time.
const INLINE = /\[([^\]]+)\]\(([^)\s]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|(https?:\/\/[^\s)]+)/g;

function inline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const match of text.matchAll(INLINE)) {
    const [whole, label, href, code, bold, bare] = match;
    if (match.index > at) parts.push(<Fragment key={at}>{text.slice(at, match.index)}</Fragment>);
    if (code != null) parts.push(<code key={match.index} {...stylex.props(styles.code)}>{code}</code>);
    else if (bold != null) parts.push(<strong key={match.index}>{bold}</strong>);
    else parts.push(<Link key={match.index} href={(href ?? bare)!} label={label ?? bare ?? ''} />);
    at = match.index + whole.length;
  }
  if (at < text.length) parts.push(<Fragment key={at}>{text.slice(at)}</Fragment>);
  return parts;
}

function Link({ href, label }: { href: string; label: string }): JSX.Element {
  // http and https only: a `javascript:` href is script running inside the app.
  if (!/^https?:\/\//i.test(href)) return <>{label}</>;
  return (
    <a {...stylex.props(styles.link, focusRing.ring)} href={href} target="_blank" rel="noreferrer noopener">
      {label}
    </a>
  );
}
