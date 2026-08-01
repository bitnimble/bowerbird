import type { ReactNode } from 'react';

export function Heading({ level = 2, children }: { level?: 1 | 2; children: ReactNode }): JSX.Element {
  const As = level === 1 ? 'h1' : 'h2';
  return <As className={`ui-h ui-h--${level}`}>{children}</As>;
}
