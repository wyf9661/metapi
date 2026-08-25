// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureFormFieldNames } from './ensureFormFieldNames.js';

function flush(): Promise<void> {
  // MutationObserver callbacks fire as microtasks.
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('ensureFormFieldNames', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('assigns a name to controls missing both id and name', () => {
    document.body.innerHTML = `
      <input class="a" />
      <textarea class="b"></textarea>
      <select class="c"></select>
    `;
    ensureFormFieldNames();

    for (const sel of ['.a', '.b', '.c']) {
      const el = document.querySelector(sel) as HTMLElement;
      expect(el.getAttribute('name')).toBeTruthy();
    }
  });

  it('never overrides an existing id or name', () => {
    document.body.innerHTML = `
      <input id="keep-id" />
      <input name="keep-name" />
    `;
    ensureFormFieldNames();

    const byId = document.getElementById('keep-id') as HTMLInputElement;
    expect(byId.getAttribute('name')).toBeNull();

    const byName = document.querySelector('[name="keep-name"]') as HTMLInputElement;
    expect(byName.id).toBe('');
    expect(byName.getAttribute('name')).toBe('keep-name');
  });

  it('names controls added to the DOM after the initial pass', async () => {
    ensureFormFieldNames();

    const added = document.createElement('input');
    added.className = 'late';
    document.body.appendChild(added);
    await flush();

    expect(added.getAttribute('name')).toBeTruthy();
  });

  it('names controls nested inside a later-added container', async () => {
    ensureFormFieldNames();

    const wrapper = document.createElement('div');
    wrapper.innerHTML = '<div><input class="nested" /></div>';
    document.body.appendChild(wrapper);
    await flush();

    const nested = document.querySelector('.nested') as HTMLInputElement;
    expect(nested.getAttribute('name')).toBeTruthy();
  });
});
