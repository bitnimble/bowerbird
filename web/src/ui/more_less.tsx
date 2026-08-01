import { ChevronDown } from 'lucide-react';

// Keeps a panel to a few lines: the rest is one click away, at the same type
// size, so nothing reads as a different level of importance than it is.
export function MoreLess({ count, open, onToggle }: { count: number; open: boolean; onToggle: () => void }): JSX.Element {
  return (
    <button type="button" className="ui-more" aria-expanded={open} onClick={onToggle}>
      <ChevronDown size={12} className={open ? 'ui-more__chevron is-open' : 'ui-more__chevron'} />
      {open ? 'Show less' : `${count} more`}
    </button>
  );
}
