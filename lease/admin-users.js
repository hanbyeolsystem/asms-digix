// ===========================================================
// totalas — 사용자 관리 (admin only)
// ===========================================================
'use strict';

const ADMIN_USER_FN = 'lease-admin-user';

let UROWS = [];

document.addEventListener('totalas:ready', async (e) => {
  const me = e.detail;
  if (me.role !== 'admin') {
    alert('관리자만 접근할 수 있습니다.');
    location.replace('index.html');
    return;
  }

  document.getElementById('btn-add-user').addEventListener('click', openAddModal);
  await renderUsers();
});

async function renderUsers() {
  const tbody = document.getElementById('user-tbody');
  const supa = window.totalasAuth;
  const { data, error } = await supa.from('rental_user_profiles')
    .select('*').order('role').order('display_id');
  if (error) {
    tbody.innerHTML = `<tr><td colspan="6" class="error" style="text-align:center;padding:20px;color:var(--danger);">조회 실패: ${escapeHtml(error.message)}</td></tr>`;
    return;
  }
  if (!data?.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="muted-small" style="text-align:center;padding:20px;">사용자가 없습니다.</td></tr>';
    return;
  }
  UROWS = data;
  tbody.innerHTML = data.map(u => `
    <tr data-uid="${u.user_id}">
      <td><strong>${escapeHtml(u.display_id)}</strong></td>
      <td>${escapeHtml(u.full_name || '-')}</td>
      <td><span class="role-pill role-${u.role}">${u.role === 'admin' ? '👑 관리자' : '🛠 엔지니어'}</span></td>
      <td>${u.active ? '<span class="status-on">활성</span>' : '<span class="status-off">비활성</span>'}</td>
      <td class="muted-small">${(u.created_at || '').slice(0,10)}</td>
      <td class="row-actions">
        <button class="btn ghost small btn-edituser" data-uid="${u.user_id}">수정</button>
        ${u.user_id === window.currentUser.id
          ? '<span class="muted-small">(나)</span>'
          : `<button class="btn ghost small btn-del" data-uid="${u.user_id}" data-display="${escapeAttr(u.display_id)}">삭제</button>`}
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('.btn-del').forEach(btn => {
    btn.addEventListener('click', () => deleteUser(btn.dataset.uid, btn.dataset.display));
  });
  tbody.querySelectorAll('.btn-edituser').forEach(btn => {
    btn.addEventListener('click', () => { const u = UROWS.find(x => x.user_id === btn.dataset.uid); if (u) openEditUser(u); });
  });
}

function openEditUser(u) {
  const box = document.getElementById('modal-box');
  box.innerHTML = `
    <h3>사용자 수정</h3>
    <p class="muted-small" style="margin:0 0 14px 0;">아이디 <b>${escapeHtml(u.display_id)}</b> · 저장하면 <b>접수관리툴</b>에도 함께 반영됩니다.</p>
    <div class="form-row"><label><span>이름</span><input id="eu-name" value="${escapeAttr(u.full_name || '')}" placeholder="성명"></label></div>
    <div class="form-row"><label><span>역할 *</span>
      <select id="eu-role"><option value="engineer">사용자</option><option value="admin">관리자</option></select>
    </label></div>
    <label style="display:flex;align-items:center;gap:6px;font-size:13px;margin-top:8px;"><input type="checkbox" id="eu-active"> 활성 계정</label>
    <div id="eu-msg" class="muted-small" style="color:var(--danger);margin-top:8px;"></div>
    <div class="modal-actions">
      <button class="btn ghost" type="button" data-close>취소</button>
      <button class="btn primary" id="eu-submit">저장</button>
    </div>`;
  document.getElementById('modal-backdrop').classList.remove('hidden');
  document.getElementById('eu-role').value = u.role || 'engineer';
  document.getElementById('eu-active').checked = u.active !== false;
  box.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModal));
  document.getElementById('eu-submit').addEventListener('click', () => saveEditUser(u));
}

async function saveEditUser(u) {
  const full_name = document.getElementById('eu-name').value.trim();
  const role = document.getElementById('eu-role').value;
  const active = document.getElementById('eu-active').checked;
  const msg = document.getElementById('eu-msg');
  const btn = document.getElementById('eu-submit');
  btn.disabled = true; msg.textContent = '';
  try {
    const supa = window.totalasAuth;
    // 1) 임대관리 프로필
    const { error } = await supa.from('rental_user_profiles')
      .update({ full_name, role, active }).eq('user_id', u.user_id);
    if (error) throw error;
    // 2) 접수관리툴(engineers) 동기화 — 이름/역할
    try { await supa.from('engineers').update({ en_name: full_name, en_role: role }).eq('user_id', u.user_id); } catch (e) {}
    closeModal();
    await renderUsers();
  } catch (err) {
    msg.textContent = err.message || String(err);
    btn.disabled = false;
  }
}

function openAddModal() {
  const tpl = document.getElementById('tpl-add-user');
  const node = tpl.content.cloneNode(true);
  const box = document.getElementById('modal-box');
  box.innerHTML = '';
  box.appendChild(node);
  document.getElementById('modal-backdrop').classList.remove('hidden');
  box.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModal));

  document.getElementById('add-user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const display_id = f.display_id.value.trim().toLowerCase();
    const password   = f.password.value;
    const full_name  = f.full_name.value.trim();
    const role       = f.role.value;
    const msg = document.getElementById('add-user-msg');
    const submitBtn = document.getElementById('add-user-submit');
    msg.textContent = '';
    submitBtn.disabled = true;
    submitBtn.textContent = '생성 중…';

    try {
      if (!/^[a-z0-9_]+$/i.test(display_id)) throw new Error('아이디는 영문/숫자/언더스코어만 사용 가능합니다.');

      // Edge Function 으로 생성 — service_role 키는 서버에만 있음 (로그인 관리자 세션으로 인증)
      const { data, error } = await window.totalasAuth.functions.invoke(ADMIN_USER_FN, {
        method: 'POST',
        body: { display_id, password, full_name, role },
      });
      if (error) throw new Error(await readFnError(error));
      if (data?.error) throw new Error(data.error);

      closeModal();
      alert(`✅ ${display_id} (${role}) 생성 완료`);
      await renderUsers();
    } catch (err) {
      console.error(err);
      msg.textContent = err.message || String(err);
      submitBtn.disabled = false;
      submitBtn.textContent = '생성';
    }
  });
}

// Edge Function 오류 메시지 추출 (FunctionsHttpError 는 본문에 상세가 들어있음)
async function readFnError(error) {
  try {
    const body = await error.context?.json?.();
    if (body?.error) return body.error;
  } catch (_) {}
  return error.message || '요청 실패';
}

async function deleteUser(uid, displayId) {
  if (!confirm(`'${displayId}' 계정을 영구 삭제할까요? 이 작업은 되돌릴 수 없습니다.`)) return;

  try {
    // Edge Function 으로 삭제 → 프로필도 ON DELETE CASCADE 로 자동 제거
    const { data, error } = await window.totalasAuth.functions.invoke(ADMIN_USER_FN, {
      method: 'DELETE',
      body: { user_id: uid },
    });
    if (error) throw new Error(await readFnError(error));
    if (data?.error) throw new Error(data.error);
    alert(`삭제됨: ${displayId}`);
    await renderUsers();
  } catch (err) {
    console.error(err);
    alert(err.message || String(err));
  }
}

function closeModal() {
  document.getElementById('modal-backdrop').classList.add('hidden');
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, m =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}
function escapeAttr(s) { return escapeHtml(s); }

document.getElementById('modal-backdrop').addEventListener('click', (e) => {
  if (e.target.id === 'modal-backdrop') closeModal();
});
