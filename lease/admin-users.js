// ===========================================================
// totalas — 사용자 관리 (admin only)
// ===========================================================
'use strict';

const ADMIN_USER_FN = 'lease-admin-user';

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
  tbody.innerHTML = data.map(u => `
    <tr data-uid="${u.user_id}">
      <td><strong>${escapeHtml(u.display_id)}</strong></td>
      <td>${escapeHtml(u.full_name || '-')}</td>
      <td><span class="role-pill role-${u.role}">${u.role === 'admin' ? '👑 관리자' : '🛠 엔지니어'}</span></td>
      <td>${u.active ? '<span class="status-on">활성</span>' : '<span class="status-off">비활성</span>'}</td>
      <td class="muted-small">${(u.created_at || '').slice(0,10)}</td>
      <td class="row-actions">
        ${u.user_id === window.currentUser.id
          ? '<span class="muted-small">(나)</span>'
          : `<button class="btn ghost small btn-del" data-uid="${u.user_id}" data-display="${escapeAttr(u.display_id)}">삭제</button>`}
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('.btn-del').forEach(btn => {
    btn.addEventListener('click', () => deleteUser(btn.dataset.uid, btn.dataset.display));
  });
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
