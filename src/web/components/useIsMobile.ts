import { useEffect, useState } from 'react';
import { MOBILE_BREAKPOINT, MOBILE_MEDIA_QUERY } from './mobileLayout.js';

export function useIsMobile(breakpoint = MOBILE_BREAKPOINT) {
  const [isMobile, setIsMobile] = useState(() => (
    typeof window !== 'undefined' ? window.innerWidth <= breakpoint : false
  ));

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const query = breakpoint === MOBILE_BREAKPOINT
      ? MOBILE_MEDIA_QUERY
      : `(max-width: ${breakpoint}px)`;
    const media = typeof window.matchMedia === 'function' ? window.matchMedia(query) : null;
    const update = () => setIsMobile(media ? media.matches : window.innerWidth <= breakpoint);
    update();

    if (media && typeof media.addEventListener === 'function') {
      media.addEventListener('change', update);
      return () => {
        if (typeof media.removeEventListener === 'function') {
          media.removeEventListener('change', update);
        }
      };
    }

    const addResizeListener = typeof window.addEventListener === 'function';
    const removeResizeListener = typeof window.removeEventListener === 'function';
    if (!addResizeListener) return;

    window.addEventListener('resize', update);
    return () => {
      if (removeResizeListener) {
        window.removeEventListener('resize', update);
      }
    };
  }, [breakpoint]);

  return isMobile;
}
