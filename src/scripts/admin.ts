/* ============================================================================
   Admin dashboard logic. Talks to /api/admin/* (gated by Cloudflare Access).
   Vanilla TS — no framework — to keep the bundle small.
   Shared helpers (el/api/setStatus/debounce/makeSortable) live in admin-shared.ts.
   ========================================================================== */

import { el, api, setStatus, debounce, makeSortable } from './admin-shared';

interface Img {
  id: number;
  cf_image_id: string;
  subtitle: string | null;
  sort_order: number;
}
interface Project {
  id: number;
  title: string;
  kicker: string | null;
  index_label: string | null;
  summary: string | null;
  tags: string[];
  accent: string | null;
  sort_order: number;
  published: number;
  images: Img[];
}

const root = document.getElementById('admin')!;
const ACCOUNT_HASH = root.dataset.accountHash || '';
const listEl = document.getElementById('project-list') as HTMLOListElement;
const emptyEl = document.getElementById('editor-empty') as HTMLElement;
const formEl = document.getElementById('editor-form') as HTMLFormElement;

let projects: Project[] = [];
let currentId: number | null = null;
let draft: Partial<Project> & { tags: string[] } = { tags: [] };

/* ---------- helpers ---------- */
// Project images are served from Cloudflare Images (imagedelivery.net).
function imageUrl(id: string, w = 200): string {
  return `https://imagedelivery.net/${ACCOUNT_HASH}/${id}/w=${w},q=82,fit=cover,f=auto`;
}

/* ---------- project list ---------- */
async function loadProjects() {
  projects = await api<Project[]>('GET', '/api/admin/projects');
  renderList();
}
function renderList() {
  listEl.replaceChildren();
  for (const p of projects) {
    const thumb = p.images[0]
      ? el('img', {
          src: imageUrl(p.images[0].cf_image_id, 80),
          style: 'width:40px;height:40px;object-fit:cover;border-radius:4px;flex:none;',
        })
      : el('div', {
          style:
            'width:40px;height:40px;border-radius:4px;flex:none;background:repeating-linear-gradient(45deg,#16171d 0 6px,#0e0f14 6px 12px);',
        });
    const li = el(
      'li',
      {
        'data-id': String(p.id),
        draggable: true,
        style: `display:flex;align-items:center;gap:10px;padding:9px;border:1px solid ${
          currentId === p.id ? 'var(--red)' : 'var(--line)'
        };border-radius:6px;cursor:pointer;background:var(--panel);`,
      } as any,
      thumb,
      el(
        'div',
        { style: 'flex:1;min-width:0;' },
        el('div', {
          style: 'font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
          textContent: p.title,
        }),
        el('div', {
          style: "font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--muted);",
          textContent: `${p.index_label || ''} · ${p.images.length} img`,
        })
      ),
      el('span', {
        title: p.published ? 'Published' : 'Hidden',
        style: `width:9px;height:9px;border-radius:50%;flex:none;background:${
          p.published ? 'var(--red)' : 'var(--ledoff)'
        };box-shadow:${p.published ? '0 0 7px var(--red)' : 'none'};`,
      })
    );
    li.addEventListener('click', () => selectProject(p.id));
    listEl.append(li);
  }
  makeSortable(listEl, async (ids) => {
    try {
      await api('POST', '/api/admin/projects/reorder', { ids });
      projects.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
      setStatus('Order saved', 'ok');
    } catch (e) {
      setStatus('Reorder failed', 'err');
    }
  });
}

/* ---------- editor ---------- */
function blankDraft(): typeof draft {
  return { title: '', kicker: '', index_label: '', summary: '', tags: [], accent: '', published: 1 };
}
function selectProject(id: number) {
  currentId = id;
  const p = projects.find((x) => x.id === id)!;
  draft = { ...p, tags: [...p.tags] };
  renderEditor(p);
  renderList();
}
function newProject() {
  currentId = null;
  draft = blankDraft();
  renderEditor(null);
  renderList();
}

function field(label: string, input: HTMLElement, hint = ''): HTMLElement {
  return el(
    'label',
    { style: 'display:flex;flex-direction:column;gap:6px;' },
    el('span', {
      style: "font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.12em;color:var(--muted);",
      textContent: label,
    }),
    input,
    ...(hint ? [el('span', { style: 'font-size:11px;color:var(--muted);opacity:.7;', textContent: hint })] : [])
  );
}
const inputStyle =
  'background:var(--panel2);border:1px solid var(--line);color:var(--ink);font-family:inherit;font-size:14px;padding:10px 12px;border-radius:6px;width:100%;';

function renderEditor(project: Project | null) {
  emptyEl.hidden = true;
  formEl.hidden = false;
  formEl.replaceChildren();
  formEl.setAttribute('style', 'display:flex;flex-direction:column;gap:18px;');

  // Title row + delete
  const titleInput = el('input', { value: draft.title || '', style: inputStyle, required: true } as any);
  titleInput.addEventListener('input', () => (draft.title = titleInput.value));

  const kickerInput = el('input', {
    value: draft.kicker || '',
    placeholder: 'INSTALLATION · 2025',
    style: inputStyle,
  } as any);
  kickerInput.addEventListener('input', () => (draft.kicker = kickerInput.value));

  const idxInput = el('input', { value: draft.index_label || '', placeholder: '/01', style: inputStyle } as any);
  idxInput.addEventListener('input', () => (draft.index_label = idxInput.value));

  const summaryInput = el('textarea', {
    value: draft.summary || '',
    rows: 3,
    placeholder: 'Short description shown on hover.',
    style: inputStyle + 'resize:vertical;',
  } as any);
  summaryInput.addEventListener('input', () => (draft.summary = summaryInput.value));

  const tagsWrap = el('div', {
    style: 'display:flex;flex-wrap:wrap;gap:7px;align-items:center;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--panel2);',
  });
  const renderTags = () => {
    tagsWrap.replaceChildren();
    draft.tags.forEach((tag, i) => {
      const chip = el(
        'span',
        {
          style:
            "display:inline-flex;align-items:center;gap:6px;font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--ink);border:1px solid var(--line);padding:5px 8px;border-radius:4px;",
        },
        tag,
        el('button', {
          type: 'button',
          textContent: '×',
          style: 'background:none;border:none;color:var(--red);cursor:pointer;font-size:14px;line-height:1;padding:0;',
          onclick: () => {
            draft.tags.splice(i, 1);
            renderTags();
          },
        } as any)
      );
      tagsWrap.append(chip);
    });
    tagsWrap.append(tagInput);
  };
  const tagInput = el('input', {
    placeholder: draft.tags.length ? 'add tag…' : 'type a tag, Enter',
    style: 'flex:1;min-width:90px;background:none;border:none;outline:none;color:var(--ink);font-family:inherit;font-size:13px;',
  } as any);
  tagInput.addEventListener('keydown', (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key === 'Enter' || ke.key === ',') {
      ke.preventDefault();
      const v = tagInput.value.trim();
      if (v) {
        draft.tags.push(v);
        tagInput.value = '';
        renderTags();
      }
    } else if (ke.key === 'Backspace' && !tagInput.value && draft.tags.length) {
      draft.tags.pop();
      renderTags();
    }
  });
  renderTags();

  const publishedInput = el('input', { type: 'checkbox', checked: draft.published !== 0 } as any);
  publishedInput.addEventListener('change', () => (draft.published = publishedInput.checked ? 1 : 0));
  const publishedLabel = el(
    'label',
    { style: 'display:flex;align-items:center;gap:9px;cursor:pointer;font-size:13px;' },
    publishedInput,
    'Published (visible on the site)'
  );

  const saveBtn = el('button', {
    type: 'submit',
    textContent: project ? 'Save changes' : 'Create project',
    style:
      'background:var(--red);border:none;color:#070709;font-weight:600;font-family:inherit;font-size:14px;padding:12px 22px;border-radius:6px;cursor:pointer;',
  } as any);

  const headerRow = el(
    'div',
    { style: 'display:flex;align-items:center;justify-content:space-between;gap:12px;' },
    el('h2', { style: 'margin:0;font-size:18px;', textContent: project ? 'Edit project' : 'New project' }),
    ...(project
      ? [
          el('button', {
            type: 'button',
            textContent: 'Delete',
            style:
              'background:none;border:1px solid #5c2b2e;color:#ff8a80;font-family:inherit;font-size:12px;padding:8px 14px;border-radius:6px;cursor:pointer;',
            onclick: () => deleteProject(project.id),
          } as any),
        ]
      : [])
  );

  formEl.append(
    headerRow,
    field('Title *', titleInput),
    el(
      'div',
      { style: 'display:grid;grid-template-columns:1fr 1fr;gap:14px;' },
      field('Kicker', kickerInput, 'Category · year'),
      field('Index label', idxInput)
    ),
    field('Summary', summaryInput),
    field('Tags', tagsWrap, 'Enter or comma to add'),
    publishedLabel,
    el('div', { style: 'display:flex;gap:12px;align-items:center;' }, saveBtn)
  );

  // Image manager (only when project exists)
  formEl.append(renderImageManager(project));

  formEl.onsubmit = (e) => {
    e.preventDefault();
    save();
  };
}

/* ---------- image manager ---------- */
function renderImageManager(project: Project | null): HTMLElement {
  const wrap = el('div', { style: 'border-top:1px solid var(--line);padding-top:18px;display:flex;flex-direction:column;gap:14px;' });
  wrap.append(
    el('h3', {
      style: "margin:0;font-size:13px;font-family:'JetBrains Mono',monospace;letter-spacing:.12em;color:var(--muted);",
      textContent: 'IMAGES',
    })
  );
  if (!project) {
    wrap.append(
      el('p', {
        style: 'color:var(--muted);font-size:13px;margin:0;',
        textContent: 'Save the project first, then add images.',
      })
    );
    return wrap;
  }

  // drop zone
  const drop = el(
    'div',
    {
      style:
        'border:1.5px dashed var(--line);border-radius:8px;padding:22px;text-align:center;color:var(--muted);font-size:13px;cursor:pointer;transition:border-color .2s,background .2s;',
    },
    'Drop images here, or click to choose'
  );
  const fileInput = el('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true } as any);
  drop.append(fileInput);
  drop.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => handleFiles([...(fileInput.files || [])], project.id));
  ['dragenter', 'dragover'].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.style.borderColor = 'var(--red)';
      drop.style.background = 'rgba(255,42,69,.05)';
    })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.style.borderColor = 'var(--line)';
      drop.style.background = 'none';
    })
  );
  drop.addEventListener('drop', (e) => {
    const files = [...((e as DragEvent).dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
    handleFiles(files, project.id);
  });

  const grid = el('div', {
    id: 'image-grid',
    style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;',
  });
  renderImages(grid, project);

  wrap.append(drop, grid);
  return wrap;
}

function renderImages(grid: HTMLElement, project: Project) {
  grid.replaceChildren();
  for (const img of project.images) {
    const subtitleInput = el('input', {
      value: img.subtitle || '',
      placeholder: 'Caption…',
      style:
        'width:100%;background:var(--panel2);border:1px solid var(--line);color:var(--ink);font-family:inherit;font-size:12px;padding:6px 8px;border-radius:4px;',
    } as any);
    const saveSub = debounce(async () => {
      try {
        await api('PATCH', `/api/admin/images/${img.id}`, { subtitle: subtitleInput.value || null });
        img.subtitle = subtitleInput.value || null;
        setStatus('Caption saved', 'ok');
      } catch {
        setStatus('Caption save failed', 'err');
      }
    }, 700);
    subtitleInput.addEventListener('input', saveSub);

    const card = el(
      'div',
      {
        'data-id': String(img.id),
        draggable: true,
        style: 'border:1px solid var(--line);border-radius:6px;overflow:hidden;background:var(--panel);display:flex;flex-direction:column;',
      } as any,
      el('div', { style: 'position:relative;' },
        el('img', { src: imageUrl(img.cf_image_id, 300), style: 'width:100%;aspect-ratio:4/3;object-fit:cover;display:block;cursor:grab;' } as any),
        el('button', {
          type: 'button',
          textContent: '×',
          title: 'Delete image',
          style:
            'position:absolute;top:6px;right:6px;width:24px;height:24px;border-radius:50%;border:none;background:rgba(7,7,9,.8);color:#ff8a80;cursor:pointer;font-size:15px;line-height:1;',
          onclick: () => deleteImage(img.id, project.id),
        } as any)
      ),
      el('div', { style: 'padding:8px;' }, subtitleInput)
    );
    grid.append(card);
  }
  makeSortable(grid, async (ids) => {
    try {
      await api('POST', `/api/admin/projects/${project.id}/images/reorder`, { ids });
      project.images.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
      setStatus('Image order saved', 'ok');
    } catch {
      setStatus('Reorder failed', 'err');
    }
  });
}

async function handleFiles(files: File[], projectId: number) {
  if (!files.length) return;
  for (const file of files) {
    setStatus(`Uploading ${file.name}…`);
    try {
      const { uploadURL, id } = await api<{ uploadURL: string; id: string }>('POST', '/api/admin/upload');
      await uploadToCf(uploadURL, file);
      await api('POST', `/api/admin/projects/${projectId}/images`, { cf_image_id: id });
    } catch (e) {
      setStatus(`Upload failed: ${(e as Error).message}`, 'err');
      return;
    }
  }
  await refreshProject(projectId);
  setStatus('Images added', 'ok');
}

function uploadToCf(url: string, file: File): Promise<void> {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('file', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setStatus(`Uploading ${file.name} ${Math.round((e.loaded / e.total) * 100)}%`);
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error('upload ' + xhr.status)));
    xhr.onerror = () => reject(new Error('network error'));
    xhr.send(fd);
  });
}

/* ---------- mutations ---------- */
async function save() {
  if (!draft.title || !draft.title.trim()) {
    setStatus('Title is required', 'err');
    return;
  }
  const body = {
    title: draft.title,
    kicker: draft.kicker || null,
    index_label: draft.index_label || null,
    summary: draft.summary || null,
    tags: draft.tags,
    accent: draft.accent || null,
    published: draft.published !== 0,
  };
  try {
    if (currentId == null) {
      const { id } = await api<{ id: number }>('POST', '/api/admin/projects', body);
      await loadProjects();
      selectProject(id);
      setStatus('Project created', 'ok');
    } else {
      await api('PUT', `/api/admin/projects/${currentId}`, body);
      await refreshProject(currentId);
      setStatus('Saved', 'ok');
    }
  } catch (e) {
    setStatus('Save failed: ' + (e as Error).message, 'err');
  }
}
async function deleteProject(id: number) {
  if (!confirm('Delete this project and its images? This cannot be undone.')) return;
  try {
    await api('DELETE', `/api/admin/projects/${id}`);
    currentId = null;
    draft = blankDraft();
    formEl.hidden = true;
    emptyEl.hidden = false;
    await loadProjects();
    setStatus('Deleted', 'ok');
  } catch (e) {
    setStatus('Delete failed', 'err');
  }
}
async function deleteImage(imageId: number, projectId: number) {
  try {
    await api('DELETE', `/api/admin/images/${imageId}`);
    await refreshProject(projectId);
    setStatus('Image deleted', 'ok');
  } catch {
    setStatus('Delete failed', 'err');
  }
}
async function refreshProject(id: number) {
  await loadProjects();
  if (currentId === id) {
    const p = projects.find((x) => x.id === id);
    if (p) {
      draft = { ...p, tags: [...p.tags] };
      renderEditor(p);
      renderList();
    }
  }
}

/* ---------- boot ---------- */
document.getElementById('new-project')!.addEventListener('click', newProject);
loadProjects().catch((e) => setStatus('Failed to load: ' + e.message, 'err'));
