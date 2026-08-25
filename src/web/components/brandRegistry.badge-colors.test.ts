import { describe, expect, it } from 'vitest';
import { getAllBrands } from '../../server/shared/modelBrand.js';
import { brandBadgeColors } from './brandRegistry.js';

describe('brandBadgeColors', () => {
  it('derives tint, border, and text from the brand color', () => {
    // DeepSeek brand color starts at #4d6bfe (77,107,254) and is darkened
    // slightly (luminance clamp 0.40) for readable label text; the tint
    // follows the darkened label hue so bg and text stay in the same family.
    expect(brandBadgeColors('linear-gradient(135deg, #4d6bfe, #44a3ec)')).toEqual({
      bg: 'rgba(71,98,233,0.12)',
      border: 'rgba(71,98,233,0.25)',
      text: '#4762e9',
    });
  });

  it('gives GLM and Qwen their own tints instead of one shared theme color', () => {
    const zhipu = brandBadgeColors('linear-gradient(135deg, #3b6cf5, #6366f1)');
    const qwen = brandBadgeColors('linear-gradient(135deg, #615cf7, #9b8afb)');

    expect(zhipu.bg).toBe('rgba(56,102,233,0.12)');
    expect(qwen.bg).toBe('rgba(95,90,242,0.12)');
    expect(zhipu.bg).not.toBe(qwen.bg);
    expect(zhipu.text).not.toBe('var(--color-primary)');
    expect(qwen.text).not.toBe('var(--color-primary)');
  });

  it('darkens light brand colors so the label stays readable', () => {
    // NVIDIA green (#76b900) is bright enough that using it verbatim as label
    // text on a 12% tint is hard to read.
    const nvidia = brandBadgeColors('linear-gradient(135deg, #76b900, #4a8c0b)');
    expect(nvidia.bg).toBe('rgba(76,120,0,0.12)');
    expect(nvidia.text).not.toBe('#76b900');
    expect(nvidia.text).toBe('#4c7800');
  });

  it('supports shorthand hex and falls back when no color is present', () => {
    expect(brandBadgeColors('#abc').bg).toBe('rgba(94,103,113,0.12)');
    expect(brandBadgeColors(null)).toEqual({
      bg: 'var(--color-primary-light)',
      border: 'rgba(79,70,229,0.15)',
      text: 'var(--color-primary)',
    });
    expect(brandBadgeColors('rgb(1,2,3)').text).toBe('var(--color-primary)');
  });

  it('perturbs the palette per name so same-brand items differ', () => {
    const a = brandBadgeColors('linear-gradient(135deg, #4d6bfe, #44a3ec)', 'light', 'deepseek-chat');
    const b = brandBadgeColors('linear-gradient(135deg, #4d6bfe, #44a3ec)', 'light', 'deepseek-reasoner');
    expect(a.text).not.toBe(b.text);
    expect(a.bg).not.toBe(b.bg);
    // Perturbation stays in the same blue family (±20° hue).
    const parse = (hex: string) => hex.match(/#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i)!.slice(1).map((v) => Number.parseInt(v, 16));
    const [ar, ag] = parse(a.text);
    expect(ar).toBeLessThan(ag); // blue-dominant: red < green
  });

  it('lightens dark brand colors so the label stays readable on dark themes', () => {
    // xAI (Grok) brand color is near-black #111 — using it verbatim would make
    // the badge vanish on a dark background.
    const xai = brandBadgeColors('linear-gradient(135deg, #111, #444)', 'dark');
    expect(xai.text).not.toBe('#111111');
    // The lifted text must be a hex with noticeable luminance.
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(xai.text);
    expect(m).not.toBeNull();
    const luminance = 0.2126 * (Number.parseInt(m![1]!, 16) / 255)
      + 0.7152 * (Number.parseInt(m![2]!, 16) / 255)
      + 0.0722 * (Number.parseInt(m![3]!, 16) / 255);
    expect(luminance).toBeGreaterThan(0.18);
  });

  it('covers every registered brand so none fall back to the shared tint', () => {
    const brands = getAllBrands();
    expect(brands.length).toBeGreaterThan(60);

    const fellBack = brands.filter(
      (brand) => brandBadgeColors(brand.color).text === 'var(--color-primary)',
    );
    expect(fellBack).toEqual([]);
  });
});
