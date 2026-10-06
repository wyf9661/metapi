import { getEffectiveTheme } from './charts/chartShared.js';

const LIGHT_HEX = '#fdfcfa';
const DARK_HEX = '#5d6564';

/** Absolutely-positioned &lt;img&gt; that paints the active pill's bg fill.
 *  Honor MagicOS force-dark flattens CSS background-image (even data-URI
 *  SVG) but leaves &lt;img&gt; content intact — proven by the page logo
 *  surviving force-dark as its teal hue while every CSS-colored surface
 *  goes gray.  Use inside each `pill-tab` button:
 *
 *    &lt;button className="pill-tab" style={{position:'relative',zIndex:0,overflow:'hidden'}}&gt;
 *      {active && &lt;PillTabBg /&gt;}
 *      {label}
 *    &lt;/button&gt;
 */
export function PillTabBg() {
  const dark = getEffectiveTheme() === 'dark';
  const hex = dark ? DARK_HEX : LIGHT_HEX;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"><rect width="100%" height="100%" fill="${hex}"/></svg>`;
  return (
    <img
      src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
      alt=""
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        borderRadius: 'inherit',
        zIndex: -1,
        pointerEvents: 'none',
      }}
    />
  );
}