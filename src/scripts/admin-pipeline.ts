/* ============================================================================
   Image pipeline UI. Talks to /api/admin/pipeline/* (gated by Cloudflare Access).
   Four stacked stages: Groups → Cull+Caption → Review+Interview → Publish.
   Vanilla TS, shared helpers from admin-shared.ts.
   ========================================================================== */

import { el, api, setStatus, makeSortable } from './admin-shared';

/* ------------------------------- types ------------------------------- */
interface RawImage {
  id: number;
  original_filename: string;
  capture_ts: string | null;
  width: number | null;
  height: number | null;
  file_size_bytes: number | null;
  vlm_caption: string | null;
  vlm_quality_score: number | null;
  vlm_candidate_tags: string[];
  is_hero: number;
  pipeline_status: string;
}
interface Group {
  id: number;
  title: string | null;
  proposed_date_range: string | null;
  status: string;
  description_draft: string | null;
  description_final: string | null;
  tags_draft: string[];
  tags_final: string[];
  interview_questions: string[];
  interview_answers: string[];
  project_id: number | null;
  image_count?: number;
}

/* ------------------------------- state ------------------------------- */
let groups: Group[] = [];
let cullImages: RawImage[] = [];
let reviewImages: RawImage[] = [];
let reviewHeroes = new Set<number>();

const rawThumb = (id: number) => `/api/admin/pipeline/images/${id}/raw`;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/* ============================ Stage 1: Groups ============================ */

const groupsFilter = $<HTMLSelectElement>('groups-filter');
const groupsList = $('groups-list');

async function loadGroups() {
  const status = groupsFilter.value;
  const path = `/api/admin/pipeline/groups${status ? `?status=${status}` : ''}`;
  const res = await api<{ groups: Group[] }>('GET', path);
  groups = res.groups;
  renderGroups();
  refreshGroupSelectors();
}

function renderGroups() {
  groupsList.replaceChildren();
  if (!groups.length) {
    groupsList.append(
      el('p', {
        style: 'color:var(--muted);font-size:13px;',
        textContent: 'No groups. Run the upload script to ingest the archive.',
      })
    );
    return;
  }
  for (const g of groups) groupsList.append(renderGroupCard(g));
}

function renderGroupCard(g: Group): HTMLElement {
  const titleInput = el('input', {
    value: g.title || '',
    placeholder: g.proposed_date_range || `Group ${g.id}`,
    style:
      'background:var(--panel2);border:1px solid var(--line);color:var(--ink);font-family:inherit;font-size:14px;padding:7px 10px;border-radius:5px;flex:1;min-width:160px;',
  } as any);
  titleInput.addEventListener('change', async () => {
    try {
      await api('PUT', `/api/admin/pipeline/groups/${g.id}`, { title: titleInput.value || null });
      setStatus('Title saved', 'ok');
    } catch (e) {
      setStatus('Save failed', 'err');
    }
  });

  const badge = el('span', {
    style: `font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.1em;padding:4px 8px;border-radius:4px;border:1px solid var(--line);color:${statusColor(g.status)};`,
    textContent: g.status.toUpperCase(),
  });

  const meta = el('span', {
    style: "font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--muted);",
    textContent: `${g.image_count ?? 0} img · ${g.proposed_date_range || 'no date'}`,
  });

  const actions = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;' });
  if (g.status === 'proposed') {
    actions.append(
      btn('Confirm', 'var(--green)', async () => {
        await api('PUT', `/api/admin/pipeline/groups/${g.id}`, { status: 'confirmed' });
        setStatus('Group confirmed', 'ok');
        loadGroups();
      }),
      btn('Reject', '#ff8a80', async () => {
        await api('DELETE', `/api/admin/pipeline/groups/${g.id}`);
        setStatus('Group rejected', 'ok');
        loadGroups();
      })
    );
    // merge dropdown
    const mergeSel = el('select', {
      style:
        'background:var(--panel2);border:1px solid var(--line);color:var(--ink);font-family:inherit;font-size:11px;padding:5px 8px;border-radius:5px;',
    } as any);
    mergeSel.append(el('option', { value: '', textContent: 'Merge into…' } as any));
    for (const other of groups) {
      if (other.id === g.id) continue;
      mergeSel.append(
        el('option', {
          value: String(other.id),
          textContent: other.title || other.proposed_date_range || `Group ${other.id}`,
        } as any)
      );
    }
    mergeSel.addEventListener('change', async () => {
      const targetId = Number(mergeSel.value);
      if (!targetId) return;
      await api('POST', '/api/admin/pipeline/groups/merge', { sourceId: g.id, targetId });
      setStatus('Merged', 'ok');
      loadGroups();
    });
    actions.append(mergeSel);
  }

  const header = el(
    'div',
    { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;' },
    titleInput,
    badge,
    meta
  );

  // Expandable image grid (loaded lazily) so you can verify what's in the group
  // and split out photos that belong to a different project.
  const body = el('div', {
    style: 'display:none;flex-direction:column;gap:10px;border-top:1px solid var(--line);padding-top:10px;',
  });
  let loaded = false;
  const selected = new Set<number>();
  const count = g.image_count ?? 0;

  const viewBtn = btn(`View images (${count})`, 'var(--panel2)', async () => {
    if (body.style.display !== 'none') {
      body.style.display = 'none';
      viewBtn.textContent = `View images (${count})`;
      return;
    }
    body.style.display = 'flex';
    viewBtn.textContent = 'Hide images';
    if (!loaded) {
      body.replaceChildren(el('p', { style: 'color:var(--muted);font-size:12px;', textContent: 'Loading…' }));
      const res = await api<{ group: Group; images: RawImage[] }>(
        'GET',
        `/api/admin/pipeline/groups/${g.id}`
      );
      body.replaceChildren();
      renderGroupImages(g, res.images, body, selected);
      loaded = true;
    }
  });
  actions.append(viewBtn);

  return el(
    'div',
    {
      'data-id': String(g.id),
      style:
        'border:1px solid var(--line);border-radius:8px;padding:14px;background:var(--panel);display:flex;flex-direction:column;gap:10px;',
    } as any,
    header,
    actions,
    body
  );
}

// Thumbnail grid for one group. Click photos that belong to a different project,
// then "Split" moves them into a brand-new proposed group.
function renderGroupImages(g: Group, images: RawImage[], host: HTMLElement, selected: Set<number>) {
  const splitBtn = btn('Split selected → new group', 'var(--blue)', async () => {
    const ids = [...selected];
    if (!ids.length) return setStatus('Click the photos to split out first', 'err');
    if (ids.length >= images.length) return setStatus('Leave at least one photo in this group', 'err');
    await api('POST', `/api/admin/pipeline/groups/${g.id}/split`, { imageIds: ids });
    setStatus(`Split ${ids.length} photo(s) into a new group`, 'ok');
    loadGroups();
  });
  const updateSplit = () => {
    splitBtn.textContent = selected.size
      ? `Split ${selected.size} selected → new group`
      : 'Split selected → new group';
  };

  const grid = el('div', {
    style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px;',
  });
  for (const img of images) {
    const tile = el(
      'div',
      { style: 'position:relative;border:2px solid var(--line);border-radius:6px;overflow:hidden;cursor:pointer;' } as any,
      el('img', {
        src: rawThumb(img.id),
        loading: 'lazy',
        title: img.original_filename,
        style: 'width:100%;aspect-ratio:1/1;object-fit:cover;display:block;',
      } as any)
    );
    const mark = () => {
      const on = selected.has(img.id);
      tile.style.borderColor = on ? 'var(--red)' : 'var(--line)';
      tile.style.boxShadow = on ? 'inset 0 0 0 3px var(--red)' : 'none';
    };
    tile.addEventListener('click', () => {
      selected.has(img.id) ? selected.delete(img.id) : selected.add(img.id);
      mark();
      updateSplit();
    });
    mark();
    grid.append(tile);
  }

  host.append(
    el('p', {
      style: "font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--muted);",
      textContent: 'Tap photos that belong to a DIFFERENT project, then split them out.',
    }),
    grid,
    el('div', { style: 'display:flex;gap:8px;' }, splitBtn)
  );
}

/* ========================= Stage 2: Cull + caption ========================= */

const cullSel = $<HTMLSelectElement>('cull-group');
const cullActions = $('cull-actions');
const cullGrid = $('cull-grid');
let cullPollTimer = 0;

cullSel.addEventListener('change', () => loadCull());

async function loadCull() {
  const groupId = Number(cullSel.value);
  cullGrid.replaceChildren();
  cullActions.replaceChildren();
  if (!groupId) return;

  const res = await api<{ group: Group; images: RawImage[] }>(
    'GET',
    `/api/admin/pipeline/groups/${groupId}`
  );
  cullImages = res.images;

  cullActions.append(
    btn('Apply technical cull', 'var(--blue)', async () => {
      const r = await api<{ kept: number; rejected: number }>(
        'POST',
        `/api/admin/pipeline/groups/${groupId}/cull`
      );
      setStatus(`Cull: kept ${r.kept}, rejected ${r.rejected}`, 'ok');
      loadCull();
    }),
    btn('Submit to VLM', 'var(--red)', async () => {
      try {
        const r = await api<{ batchId: string; imageCount: number }>(
          'POST',
          `/api/admin/pipeline/groups/${groupId}/submit-batch`
        );
        setStatus(`Submitted ${r.imageCount} images (batch ${r.batchId.slice(0, 8)})`, 'ok');
        startBatchPoll(r.batchId);
      } catch (e) {
        setStatus(`Submit failed: ${(e as Error).message}`, 'err');
      }
    }),
    btn('Reconcile now', 'var(--panel2)', async () => {
      const s = await api('POST', '/api/admin/pipeline/reconcile');
      setStatus(`Reconciled (${JSON.stringify(s)})`, 'ok');
      loadCull();
    })
  );

  for (const img of cullImages) cullGrid.append(renderCullCard(img));
}

function renderCullCard(img: RawImage): HTMLElement {
  const out = img.pipeline_status === 'culled_out';
  const dim = out ? 'opacity:.4;' : '';
  const res = img.width && img.height ? `${img.width}×${img.height}` : '?';
  const kb = img.file_size_bytes ? `${Math.round(img.file_size_bytes / 1024)}KB` : '?';
  return el(
    'div',
    {
      style: `border:1px solid var(--line);border-radius:6px;overflow:hidden;background:var(--panel);${dim}`,
    },
    el('img', {
      src: rawThumb(img.id),
      loading: 'lazy',
      style: 'width:100%;aspect-ratio:4/3;object-fit:cover;display:block;',
    } as any),
    el(
      'div',
      { style: "padding:6px 8px;font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--muted);" },
      `${res} · ${kb} · ${img.pipeline_status}`
    )
  );
}

function startBatchPoll(batchId: string) {
  clearTimeout(cullPollTimer);
  const tick = async () => {
    if (document.hidden) return;
    try {
      await api('POST', '/api/admin/pipeline/reconcile');
      const { batch } = await api<{ batch: { status: string } }>(
        'GET',
        `/api/admin/pipeline/batches/${batchId}`
      );
      setStatus(`Batch ${batchId.slice(0, 8)}: ${batch.status}`);
      if (batch.status === 'complete' || batch.status === 'failed') {
        setStatus(`Batch ${batch.status}`, batch.status === 'complete' ? 'ok' : 'err');
        loadCull();
        refreshGroupSelectors();
        return;
      }
    } catch {
      /* keep polling */
    }
    cullPollTimer = window.setTimeout(tick, 15000);
  };
  cullPollTimer = window.setTimeout(tick, 4000);
}

/* ====================== Stage 3: Review + interview ====================== */

const reviewSel = $<HTMLSelectElement>('review-group');
const reviewGrid = $('review-grid');
const reviewInterview = $('review-interview');
let reviewGroupId = 0;

reviewSel.addEventListener('change', () => loadReview());

async function loadReview() {
  reviewGroupId = Number(reviewSel.value);
  reviewGrid.replaceChildren();
  reviewInterview.replaceChildren();
  reviewHeroes = new Set();
  if (!reviewGroupId) return;

  const res = await api<{ group: Group; images: RawImage[] }>(
    'GET',
    `/api/admin/pipeline/groups/${reviewGroupId}`
  );
  reviewImages = res.images.filter((i) =>
    ['vlm_done', 'embedded', 'published'].includes(i.pipeline_status)
  );
  for (const img of reviewImages) {
    if (img.is_hero) reviewHeroes.add(img.id);
    reviewGrid.append(renderReviewCard(img));
  }
  renderInterview(res.group);
}

function renderReviewCard(img: RawImage): HTMLElement {
  const heroBox = el('input', { type: 'checkbox', checked: reviewHeroes.has(img.id) } as any);
  heroBox.addEventListener('change', () => {
    if (heroBox.checked) reviewHeroes.add(img.id);
    else reviewHeroes.delete(img.id);
  });
  const q = img.vlm_quality_score != null ? img.vlm_quality_score.toFixed(2) : '–';
  return el(
    'div',
    { style: 'border:1px solid var(--line);border-radius:6px;overflow:hidden;background:var(--panel);' },
    el('img', {
      src: rawThumb(img.id),
      loading: 'lazy',
      style: 'width:100%;aspect-ratio:4/3;object-fit:cover;display:block;',
    } as any),
    el(
      'div',
      { style: 'padding:7px 8px;display:flex;flex-direction:column;gap:5px;' },
      el('div', {
        style: 'font-size:11px;color:var(--ink);line-height:1.3;max-height:48px;overflow:hidden;',
        textContent: img.vlm_caption || '(no caption)',
      }),
      el(
        'label',
        { style: "display:flex;align-items:center;gap:6px;font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--muted);" },
        heroBox,
        `hero · q=${q}`
      )
    )
  );
}

function renderInterview(group: Group) {
  if (!group.interview_questions.length) {
    reviewInterview.append(
      el('p', {
        style: 'color:var(--muted);font-size:13px;',
        textContent:
          reviewImages.length === 0
            ? 'No captioned images yet — submit this group to the VLM first.'
            : 'Questions are drafted after captioning completes. Click "Reconcile now" in stage 02.',
      })
    );
    return;
  }
  const answerInputs: HTMLTextAreaElement[] = [];
  group.interview_questions.forEach((q, i) => {
    const ta = el('textarea', {
      value: group.interview_answers[i] || '',
      rows: 2,
      placeholder: 'Your answer…',
      style:
        'background:var(--panel2);border:1px solid var(--line);color:var(--ink);font-family:inherit;font-size:13px;padding:8px 10px;border-radius:6px;width:100%;resize:vertical;',
    } as any);
    answerInputs.push(ta);
    reviewInterview.append(
      el(
        'div',
        { style: 'display:flex;flex-direction:column;gap:5px;' },
        el('span', { style: 'font-size:13px;color:var(--ink);', textContent: `Q${i + 1}. ${q}` }),
        ta
      )
    );
  });

  const finalArea = el('textarea', {
    value: group.description_final || '',
    rows: 3,
    placeholder: 'Synthesized description appears here (editable).',
    style:
      'background:var(--panel2);border:1px solid var(--line);color:var(--ink);font-family:inherit;font-size:13px;padding:8px 10px;border-radius:6px;width:100%;resize:vertical;',
  } as any);
  const tagsInput = el('input', {
    value: group.tags_final.join(', '),
    placeholder: 'TAG1, TAG2',
    style:
      'background:var(--panel2);border:1px solid var(--line);color:var(--ink);font-family:inherit;font-size:13px;padding:8px 10px;border-radius:6px;width:100%;',
  } as any);

  reviewInterview.append(
    btn('Synthesize with Kimi', 'var(--green)', async () => {
      setStatus('Synthesizing…');
      try {
        const r = await api<{ description: string; tags: string[] }>(
          'POST',
          `/api/admin/pipeline/groups/${group.id}/interview`,
          { answers: answerInputs.map((a) => a.value) }
        );
        finalArea.value = r.description;
        tagsInput.value = r.tags.join(', ');
        setStatus('Synthesized', 'ok');
      } catch (e) {
        setStatus(`Synthesis failed: ${(e as Error).message}`, 'err');
      }
    }),
    el('span', { style: 'font-size:12px;color:var(--muted);margin-top:6px;', textContent: 'Final description' }),
    finalArea,
    el('span', { style: 'font-size:12px;color:var(--muted);', textContent: 'Final tags' }),
    tagsInput,
    btn('Save description + tags', 'var(--blue)', async () => {
      await api('PUT', `/api/admin/pipeline/groups/${group.id}`, {
        description_final: finalArea.value,
        tags_final: tagsInput.value.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean),
      });
      setStatus('Saved', 'ok');
      refreshGroupSelectors();
    })
  );
}

/* ============================ Stage 4: Publish ============================ */

const publishPanel = $('publish-panel');

function renderPublish() {
  publishPanel.replaceChildren();
  const ready = groups.filter((g) => g.status === 'confirmed' && g.description_final);
  const sel = el('select', {
    style:
      'background:var(--panel2);border:1px solid var(--line);color:var(--ink);font-family:inherit;font-size:12px;padding:6px 10px;border-radius:6px;min-width:220px;',
  } as any);
  sel.append(el('option', { value: '', textContent: 'Choose a confirmed group…' } as any));
  for (const g of ready) {
    sel.append(
      el('option', {
        value: String(g.id),
        textContent: g.title || g.proposed_date_range || `Group ${g.id}`,
      } as any)
    );
  }
  const detail = el('div', { style: 'display:flex;flex-direction:column;gap:12px;' });
  sel.addEventListener('change', () => renderPublishDetail(Number(sel.value), detail));
  publishPanel.append(sel, detail);
}

async function renderPublishDetail(groupId: number, host: HTMLElement) {
  host.replaceChildren();
  if (!groupId) return;
  const res = await api<{ group: Group; images: RawImage[] }>(
    'GET',
    `/api/admin/pipeline/groups/${groupId}`
  );
  const g = res.group;
  const heroes = res.images.filter((i) => i.is_hero || reviewHeroes.has(i.id));
  const heroSource = heroes.length ? heroes : res.images.filter((i) => i.pipeline_status === 'vlm_done' || i.pipeline_status === 'embedded');

  const titleInput = el('input', {
    value: g.title || '',
    placeholder: 'Project title',
    style:
      'background:var(--panel2);border:1px solid var(--line);color:var(--ink);font-family:inherit;font-size:14px;padding:9px 12px;border-radius:6px;width:100%;',
  } as any);
  const kickerInput = el('input', {
    placeholder: 'INSTALLATION · 2025',
    style:
      'background:var(--panel2);border:1px solid var(--line);color:var(--ink);font-family:inherit;font-size:14px;padding:9px 12px;border-radius:6px;width:100%;',
  } as any);

  // Hero order (drag to reorder).
  const heroOrder = el('div', {
    id: 'hero-order',
    style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px;',
  });
  for (const img of heroSource) {
    heroOrder.append(
      el(
        'div',
        {
          'data-id': String(img.id),
          draggable: true,
          style: 'border:1px solid var(--line);border-radius:6px;overflow:hidden;background:var(--panel);cursor:grab;',
        } as any,
        el('img', {
          src: rawThumb(img.id),
          loading: 'lazy',
          style: 'width:100%;aspect-ratio:4/3;object-fit:cover;display:block;',
        } as any)
      )
    );
  }
  let heroIds = heroSource.map((i) => i.id);
  makeSortable(heroOrder, (ids) => (heroIds = ids));

  host.append(
    el('div', { style: 'font-size:13px;color:var(--ink);line-height:1.5;', textContent: g.description_final || '' }),
    el('div', { style: "font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--muted);", textContent: g.tags_final.join(' · ') }),
    labelled('Title', titleInput),
    labelled('Kicker', kickerInput),
    el('span', { style: 'font-size:12px;color:var(--muted);', textContent: 'Hero images (drag to order)' }),
    heroOrder,
    btn('Publish to portfolio', 'var(--red)', async () => {
      if (!titleInput.value.trim()) return setStatus('Title required', 'err');
      setStatus('Publishing…');
      try {
        const r = await api<{ projectId: number }>(
          'POST',
          `/api/admin/pipeline/groups/${groupId}/publish`,
          { heroImageIds: heroIds, title: titleInput.value.trim(), kicker: kickerInput.value || null }
        );
        host.append(
          el(
            'p',
            { style: 'color:var(--green);font-size:13px;' },
            `Published as project #${r.projectId}. `,
            el('a', { href: '/admin', style: 'color:var(--red);', textContent: 'Open in /admin to set Published →' } as any)
          )
        );
        setStatus('Published (hidden until you toggle it live)', 'ok');
        loadGroups();
      } catch (e) {
        setStatus(`Publish failed: ${(e as Error).message}`, 'err');
      }
    })
  );
}

/* ------------------------------- helpers ------------------------------- */

function btn(label: string, bg: string, onClick: () => void | Promise<void>): HTMLButtonElement {
  const dark = bg === 'var(--panel2)';
  const b = el('button', {
    type: 'button',
    textContent: label,
    style: `background:${bg};border:1px solid ${dark ? 'var(--line)' : bg};color:${dark ? 'var(--ink)' : '#070709'};font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.06em;font-weight:600;padding:8px 14px;border-radius:6px;cursor:pointer;`,
  } as any);
  b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      await onClick();
    } catch (e) {
      setStatus((e as Error).message, 'err');
    } finally {
      b.disabled = false;
    }
  });
  return b;
}

function labelled(label: string, input: HTMLElement): HTMLElement {
  return el(
    'label',
    { style: 'display:flex;flex-direction:column;gap:5px;' },
    el('span', {
      style: "font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.1em;color:var(--muted);",
      textContent: label,
    }),
    input
  );
}

function statusColor(status: string): string {
  switch (status) {
    case 'confirmed':
      return 'var(--blue)';
    case 'published':
      return 'var(--green)';
    case 'rejected':
      return '#ff8a80';
    default:
      return 'var(--muted)';
  }
}

// Populate the Cull / Review group dropdowns from confirmed groups, then re-render publish.
function refreshGroupSelectors() {
  const confirmed = groups.filter((g) => g.status === 'confirmed' || g.status === 'published');
  for (const [sel, keep] of [
    [cullSel, Number(cullSel.value)],
    [reviewSel, Number(reviewSel.value)],
  ] as [HTMLSelectElement, number][]) {
    sel.replaceChildren(el('option', { value: '', textContent: '— select group —' } as any));
    for (const g of confirmed) {
      sel.append(
        el('option', {
          value: String(g.id),
          textContent: g.title || g.proposed_date_range || `Group ${g.id}`,
        } as any)
      );
    }
    if (keep && confirmed.some((g) => g.id === keep)) sel.value = String(keep);
  }
  renderPublish();
}

/* -------------------------------- boot -------------------------------- */
groupsFilter.addEventListener('change', loadGroups);
loadGroups().catch((e) => setStatus('Failed to load: ' + e.message, 'err'));
