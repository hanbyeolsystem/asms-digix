// ===========================================================
// 자료실 (게시판) — 기본 자료 보관
// 의존: auth.js (window.totalasAuth, window.currentUser), Supabase
// 테이블 lease_board + 스토리지 버킷 board
// ===========================================================
'use strict';

const BD_BUCKET = 'board';
let BD_ROWS = [];      // 전체 로드된 글
let BD_CURRENT = null; // 보기 모달에 열린 글

const $ = (s) => document.querySelector(s);

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, m =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtSize(b) {
  if (!b && b !== 0) return '';
  if (b < 1024) return b + 'B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + 'KB';
  return (b / 1024 / 1024).toFixed(1) + 'MB';
}
function isAdmin() { return window.currentUser?.role === 'admin'; }

// ── 목록 로드 ──────────────────────────────────────────────
async function loadBoard() {
  const { data, error } = await window.totalasAuth
    .from('lease_board')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) {
    $('#bd-tbody').innerHTML = `<tr><td colspan="5" class="bd-empty" style="color:#dc2626;">불러오기 실패: ${esc(error.message)}</td></tr>`;
    return;
  }
  BD_ROWS = data || [];
  renderBoard();
}

function renderBoard() {
  const q = ($('#bd-search').value || '').trim().toLowerCase();
  const rows = q
    ? BD_ROWS.filter(r =>
        (r.title || '').toLowerCase().includes(q) ||
        (r.category || '').toLowerCase().includes(q) ||
        (r.author_name || '').toLowerCase().includes(q))
    : BD_ROWS;

  const tbody = $('#bd-tbody');
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="bd-empty">${q ? '검색 결과가 없습니다.' : '등록된 자료가 없습니다. 우측 상단 “＋ 글쓰기”로 추가하세요.'}</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(r => {
    const nFiles = Array.isArray(r.files) ? r.files.length : 0;
    return `
      <tr class="bd-row" data-id="${esc(r.id)}">
        <td class="bd-col-title">${esc(r.title)}</td>
        <td class="bd-hide-sm">${r.category ? `<span class="bd-cat">${esc(r.category)}</span>` : '<span class="bd-muted">-</span>'}</td>
        <td class="bd-hide-sm">${esc(r.author_name || '-')}</td>
        <td class="bd-muted">${esc(fmtDate(r.created_at))}</td>
        <td>${nFiles ? `<span class="bd-file-chip">📎 ${nFiles}</span>` : '<span class="bd-muted">-</span>'}</td>
      </tr>`;
  }).join('');

  tbody.querySelectorAll('.bd-row').forEach(tr => {
    tr.addEventListener('click', () => openView(tr.dataset.id));
  });
}

// ── 글쓰기 ─────────────────────────────────────────────────
function openWrite() {
  $('#bd-title').value = '';
  $('#bd-category').value = '';
  $('#bd-content').value = '';
  $('#bd-files').value = '';
  $('#bd-write-status').textContent = '';
  $('#bd-write-modal').setAttribute('open', '');
  setTimeout(() => $('#bd-title').focus(), 50);
}

async function submitWrite() {
  const title = $('#bd-title').value.trim();
  const category = $('#bd-category').value.trim();
  const content = $('#bd-content').value.trim();
  const fileInput = $('#bd-files');
  const status = $('#bd-write-status');
  const btn = $('#bd-submit');

  if (!title) { status.textContent = '제목을 입력하세요.'; $('#bd-title').focus(); return; }

  btn.disabled = true;
  status.style.color = '#475569';
  status.textContent = '등록 중…';

  try {
    // 1) 첨부 업로드
    const files = [];
    for (const f of Array.from(fileInput.files || [])) {
      const safe = f.name.replace(/[^\w.\-가-힣]/g, '_');
      const path = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safe}`;
      const { error: upErr } = await window.totalasAuth.storage
        .from(BD_BUCKET).upload(path, f, { upsert: false, contentType: f.type || undefined });
      if (upErr) throw new Error(`파일 업로드 실패(${f.name}): ${upErr.message}`);
      files.push({ name: f.name, path, size: f.size });
    }

    // 2) 글 등록
    const { error: insErr } = await window.totalasAuth.from('lease_board').insert({
      title, category: category || null, content: content || null, files,
      author_id: window.currentUser?.id || null,
      author_name: window.currentUser?.full_name || window.currentUser?.display_id || '사용자',
    });
    if (insErr) throw new Error(insErr.message);

    closeModals();
    await loadBoard();
  } catch (e) {
    console.error('[board] 등록 실패', e);
    status.style.color = '#dc2626';
    status.textContent = e.message || String(e);
  } finally {
    btn.disabled = false;
  }
}

// ── 보기 ───────────────────────────────────────────────────
async function openView(id) {
  const r = BD_ROWS.find(x => String(x.id) === String(id));
  if (!r) return;
  BD_CURRENT = r;

  $('#bd-view-title').textContent = r.title || '';
  $('#bd-view-meta').textContent =
    `${r.author_name || '-'} · ${fmtDate(r.created_at)}` + (r.category ? ` · ${r.category}` : '');
  $('#bd-view-content').textContent = r.content || '(내용 없음)';

  // 삭제 버튼: 작성자 또는 관리자만
  const canDelete = isAdmin() || (r.author_id && r.author_id === window.currentUser?.id);
  $('#bd-delete').style.display = canDelete ? '' : 'none';

  // 첨부 — 서명 URL 생성
  const wrap = $('#bd-view-files-wrap');
  const list = $('#bd-view-files');
  const files = Array.isArray(r.files) ? r.files : [];
  if (!files.length) {
    wrap.style.display = 'none';
    list.innerHTML = '';
  } else {
    wrap.style.display = '';
    list.innerHTML = files.map(f =>
      `<li><a data-path="${esc(f.path)}" data-name="${esc(f.name)}" href="#">⬇ ${esc(f.name)} <span class="bd-muted">${esc(fmtSize(f.size))}</span></a></li>`
    ).join('');
    list.querySelectorAll('a').forEach(a => {
      a.addEventListener('click', async (e) => {
        e.preventDefault();
        const { data, error } = await window.totalasAuth.storage
          .from(BD_BUCKET).createSignedUrl(a.dataset.path, 3600, { download: a.dataset.name });
        if (error) { alert('다운로드 링크 생성 실패: ' + error.message); return; }
        window.open(data.signedUrl, '_blank', 'noopener');
      });
    });
  }

  $('#bd-view-modal').setAttribute('open', '');
}

async function deleteCurrent() {
  const r = BD_CURRENT;
  if (!r) return;
  if (!confirm(`'${r.title}' 자료를 삭제할까요? 되돌릴 수 없습니다.`)) return;

  try {
    // 첨부파일 먼저 제거 (있으면)
    const paths = (Array.isArray(r.files) ? r.files : []).map(f => f.path).filter(Boolean);
    if (paths.length) {
      await window.totalasAuth.storage.from(BD_BUCKET).remove(paths);
    }
    const { error } = await window.totalasAuth.from('lease_board').delete().eq('id', r.id);
    if (error) throw new Error(error.message);
    closeModals();
    await loadBoard();
  } catch (e) {
    console.error('[board] 삭제 실패', e);
    alert('삭제 실패: ' + (e.message || e));
  }
}

// ── 모달 공통 ──────────────────────────────────────────────
function closeModals() {
  document.querySelectorAll('.bd-modal').forEach(m => m.removeAttribute('open'));
}

// ── 초기화 ─────────────────────────────────────────────────
function boot() {
  $('#bd-new').addEventListener('click', openWrite);
  $('#bd-submit').addEventListener('click', submitWrite);
  $('#bd-delete').addEventListener('click', deleteCurrent);
  $('#bd-search').addEventListener('input', renderBoard);
  document.querySelectorAll('.bd-modal [data-close], .bd-modal .bd-backdrop').forEach(el =>
    el.addEventListener('click', closeModals));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModals(); });
  loadBoard();
}

if (window.currentUser) boot();
else document.addEventListener('totalas:ready', boot, { once: true });
