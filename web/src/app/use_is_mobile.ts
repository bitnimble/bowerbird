import { useEffect, useState } from 'react';

const MOBILE = '(max-width: 860px)';

// A narrow screen has no column to spare, so chrome that sits beside the content
// on a desktop has to overlay it here. Kept in step with the breakpoint the
// stylesheet's mobile rules use.
export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => window.matchMedia(MOBILE).matches);
  useEffect(() => {
    const query = window.matchMedia(MOBILE);
    setMobile(query.matches);
    const onChange = (e: MediaQueryListEvent): void => setMobile(e.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return mobile;
}
