export const MOBILE_BREAKPOINT = 768;

export const MOBILE_MEDIA_QUERY = `(max-width: ${MOBILE_BREAKPOINT}px)`;

// CSS hides the desktop .filter-panel at max-width:900px (index.css
// "Responsive Adjustments" block). Keep the JS breakpoint for that panel in
// sync so pages fall back to the mobile filter sheet instead of rendering a
// panel that CSS makes invisible (769-900px dead zone).
export const FILTER_PANEL_BREAKPOINT = 900;
