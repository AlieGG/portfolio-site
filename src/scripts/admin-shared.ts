/* ============================================================================
   Shared admin UI helpers, used by both the projects dashboard (admin.ts) and
   the image pipeline (admin-pipeline.ts). Vanilla TS — no framework.
   Extracted verbatim from admin.ts so behaviour is identical.
   ========================================================================== */

/* ---------- status line (#admin-status exists in both page shells) ---------- */
let statusT = 0;
export function setStatus(msg: string, kind: 'ok' | 'err' | '' = '') {
  const statusEl = document.getElementById('admin-status');
  if (!statusEl) return;
  statusEl.textContent = msg;
  statusEl.style.color = kind === 'err' ? '#ff5a6e' : kind === 'ok' ? '#15e0a0' : 'var(--muted)';
  clearTimeout(statusT);
  if (msg) statusT = window.setTimeout(() => (statusEl.textContent = ''), 3500);
}

/* ---------- fetch wrapper ---------- */
export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`${res.status} ${txt}`);
  }
  return res.status === 204 ? (undefined as T) : await res.json();
}

/* ---------- tiny DOM builder ---------- */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { style?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'style') node.setAttribute('style', v as string);
    else if (k in node) (node as any)[k] = v;
    else node.setAttribute(k, v as string);
  }
  for (const c of children) node.append(c);
  return node;
}

export function debounce<T extends (...a: any[]) => void>(fn: T, ms: number): T {
  let t = 0;
  return ((...a: any[]) => {
    clearTimeout(t);
    t = window.setTimeout(() => fn(...a), ms);
  }) as T;
}

/* ---------- native drag-reorder helper ---------- */
export function makeSortable(container: HTMLElement, onReorder: (ids: number[]) => void) {
  let dragEl: HTMLElement | null = null;
  container.addEventListener('dragstart', (e) => {
    const t = (e.target as HTMLElement).closest('[data-id]') as HTMLElement;
    if (!t) return;
    dragEl = t;
    t.style.opacity = '0.4';
    e.dataTransfer!.effectAllowed = 'move';
  });
  container.addEventListener('dragend', () => {
    if (dragEl) dragEl.style.opacity = '';
    dragEl = null;
    onReorder([...container.children].map((c) => Number((c as HTMLElement).dataset.id)));
  });
  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    const after = getDragAfter(container, (e as DragEvent).clientY);
    if (!dragEl) return;
    if (after == null) container.appendChild(dragEl);
    else container.insertBefore(dragEl, after);
  });
}
function getDragAfter(container: HTMLElement, y: number): HTMLElement | null {
  const els = [...container.querySelectorAll<HTMLElement>('[data-id]:not([style*="opacity: 0.4"])')];
  let closest: { offset: number; el: HTMLElement | null } = { offset: -Infinity, el: null };
  for (const child of els) {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) closest = { offset, el: child };
  }
  return closest.el;
}
