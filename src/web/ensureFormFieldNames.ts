// Ensures every form control has an `id` or `name` attribute.
//
// Chrome DevTools raises an advisory ("A form field element should have an id
// or name attribute") for any <input>/<textarea>/<select> lacking both. The app
// has dozens of such controls (search boxes, numeric limits, notes) that are
// React-controlled and never autofilled, so hand-adding names to each is high
// churn for a cosmetic advisory. Instead we assign a stable synthetic name at
// runtime to any control missing both attributes — existing ones on first paint
// and any added later via a MutationObserver. Controls that already declare an
// id or name are never touched, so no real form behavior changes.

const NAME_PREFIX = 'f_';
let counter = 0;

function needsName(el: Element): el is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const tag = el.tagName;
  if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') return false;
  const field = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  // Skip when the control already has an id or a name — DevTools is satisfied
  // by either, and we must not clobber a real, meaningful name.
  return !field.id && !field.getAttribute('name');
}

function assignName(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): void {
  counter += 1;
  el.setAttribute('name', `${NAME_PREFIX}${counter}`);
}

function scan(root: ParentNode): void {
  const fields = root.querySelectorAll('input, textarea, select');
  fields.forEach((field) => {
    if (needsName(field)) assignName(field);
  });
}

export function ensureFormFieldNames(): void {
  if (typeof document === 'undefined') return;

  const run = () => scan(document);
  // Initial pass once the DOM is ready.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    run();
  }

  // Catch controls added by later React renders (modals, expanded panels, …).
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const el = node as Element;
        if (needsName(el)) {
          assignName(el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement);
        }
        // The added node may be a container that holds fields.
        if (typeof (el as ParentNode).querySelectorAll === 'function') {
          scan(el as ParentNode);
        }
      });
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
