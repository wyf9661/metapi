import { describe, expect, it } from 'vitest';
import { getAllBrands } from '../../server/shared/modelBrand.js';
import { brandBadgeColors } from './brandRegistry.js';

describe('brandBadgeColors', () => {
  it('derives tint, border, and text from the brand color', () => {
    // DeepSeek brand color starts at #4d6bfe (77,107,254).
    expect(brandBadgeColors('linear-gradient(135deg, #4d6bfe, #44a3ec)')).toEqual({
      bg: 'rgba(77,107,254,0.08)',
      border: 'rgba(77,107,254,0.2)',
      text: '#4d6bfe',
    });
  });

  it('gives GLM and Qwen their own tints instead of one shared theme color', () => {
    const zhipu = brandBadgeColors('linear-gradient(135deg, #3b6cf5, #6366f1)');
    const qwen = brandBadgeColors('linear-gradient(135deg, #615cf7, #9b8afb)');

    expect(zhipu.bg).toBe('rgba(59,108,245,0.08)');
    expect(qwen.bg).toBe('rgba(97,92,247,0.08)');
    expect(zhipu.bg).not.toBe(qwen.bg);
    expect(zhipu.text).not.toBe('var(--color-primary)');
    expect(qwen.text).not.toBe('var(--color-primary)');
  });

  it('darkens light brand colors so the label stays readable', () => {
    // NVIDIA green (#76b900) is bright enough that using it verbatim as label
    // text on an 8% tint is hard to read.
    const nvidia = brandBadgeColors('linear-gradient(135deg, #76b900, #4a8c0b)');
    expect(nvidia.bg).toBe('rgba(118,185,0,0.08)');
    expect(nvidia.text).not.toBe('#76b900');
    expect(nvidia.text).toBe('#507e00');
  });

  it('supports shorthand hex and falls back when no color is present', () => {
    expect(brandBadgeColors('#abc').bg).toBe('rgba(170,187,204,0.08)');
    expect(brandBadgeColors(null)).toEqual({
      bg: 'var(--color-primary-light)',
      border: 'rgba(79,70,229,0.15)',
      text: 'var(--color-primary)',
    });
    expect(brandBadgeColors('rgb(1,2,3)').text).toBe('var(--color-primary)');
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
