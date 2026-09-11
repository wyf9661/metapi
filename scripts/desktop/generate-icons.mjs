import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

export const DESKTOP_ICON_SIZE = 512;
export const DESKTOP_ICON_PADDING = 30;
export const DESKTOP_ICON_RADIUS = 106;
export const DESKTOP_ICON_MARK_SIZE = 400;
export const DESKTOP_TRAY_TEMPLATE_PADDING = 36;

/**
 * Warm plate behind the desktop icon: a floating mark alone disappears on
 * dark wallpapers/docks and gives the OS nothing to frame. The plate keeps
 * the mark legible on any background; corners stay transparent so macOS,
 * Windows and Linux launchers can apply their own masking.
 */
function createPlateSvg(size, inset, radius) {
  return Buffer.from(
    `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="metapi-plate" x1="0" y1="${inset}" x2="0" y2="${size - inset}" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#fcfaf6"/>
          <stop offset="1" stop-color="#ece7de"/>
        </linearGradient>
      </defs>
      <rect x="${inset}" y="${inset}" width="${size - inset * 2}" height="${size - inset * 2}"
        rx="${radius}" ry="${radius}"
        fill="url(#metapi-plate)" stroke="#3e362e" stroke-opacity="0.16" stroke-width="1.5"/>
    </svg>`,
  );
}

async function renderDesktopIconBuffer({
  sourcePath,
  size = DESKTOP_ICON_SIZE,
  padding = DESKTOP_ICON_PADDING,
  cornerRadius = DESKTOP_ICON_RADIUS,
  markSize = DESKTOP_ICON_MARK_SIZE,
}) {
  const plate = await sharp(createPlateSvg(size, padding, cornerRadius)).png().toBuffer();

  const mark = await sharp(sourcePath)
    .resize(markSize, markSize, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  const markOffset = Math.round((size - markSize) / 2);

  return sharp(plate)
    .composite([{ input: mark, left: markOffset, top: markOffset }])
    .png()
    .toBuffer();
}

async function renderTrayTemplateIconBuffer({
  sourcePath,
  size = DESKTOP_ICON_SIZE,
  padding = DESKTOP_TRAY_TEMPLATE_PADDING,
}) {
  const innerSize = Math.max(1, size - padding * 2);

  // Render the logo once, then normalise its alpha into a hard stencil: the
  // logo paints its flows with partial opacity, but a menu-bar template must
  // be fully opaque inside the shape and fully transparent outside it.
  // `dest-in` blends against the input's alpha channel, so extracting it into
  // a greyscale image first would make the mask fully opaque and paint a solid
  // black square into the tray — keep the data RGBA throughout.
  const { data, info } = await sharp(sourcePath)
    .resize(innerSize, innerSize, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const silhouetteRaw = Buffer.from(data);
  for (let i = 3; i < silhouetteRaw.length; i += 4) {
    silhouetteRaw[i] = silhouetteRaw[i] > 8 ? 255 : 0;
  }

  const silhouette = await sharp(silhouetteRaw, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .png()
    .toBuffer();

  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    },
  })
    .composite([{ input: silhouette, left: padding, top: padding, blend: 'dest-in' }])
    .png()
    .toBuffer();
}

export async function generateDesktopIconAssets({
  sourcePath = join(process.cwd(), 'src', 'web', 'public', 'logo.svg'),
  buildOutputPath = join(process.cwd(), 'build', 'desktop-icon.png'),
  webOutputPath = join(process.cwd(), 'src', 'web', 'public', 'desktop-icon.png'),
  trayTemplateOutputPath = join(process.cwd(), 'src', 'web', 'public', 'desktop-tray-template.png'),
  size = DESKTOP_ICON_SIZE,
  padding = DESKTOP_ICON_PADDING,
  cornerRadius = DESKTOP_ICON_RADIUS,
} = {}) {
  const [outputBuffer, trayTemplateBuffer] = await Promise.all([
    renderDesktopIconBuffer({
      sourcePath,
      size,
      padding,
      cornerRadius,
    }),
    renderTrayTemplateIconBuffer({
      sourcePath,
      size,
    }),
  ]);

  await Promise.all([
    mkdir(dirname(buildOutputPath), { recursive: true }),
    mkdir(dirname(webOutputPath), { recursive: true }),
    mkdir(dirname(trayTemplateOutputPath), { recursive: true }),
  ]);

  await Promise.all([
    sharp(outputBuffer).toFile(buildOutputPath),
    sharp(outputBuffer).toFile(webOutputPath),
    sharp(trayTemplateBuffer).toFile(trayTemplateOutputPath),
  ]);

  return {
    buildOutputPath,
    webOutputPath,
    trayTemplateOutputPath,
  };
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const outputs = await generateDesktopIconAssets();
  console.log(`[metapi-desktop] Generated desktop icons:
- ${outputs.buildOutputPath}
- ${outputs.webOutputPath}
- ${outputs.trayTemplateOutputPath}`);
}
