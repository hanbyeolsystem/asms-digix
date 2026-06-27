// ===========================================================
// totalas — 사용자 관리 (admin only)
// ===========================================================
'use strict';

const SECRET_SESSION_KEY = 'digix-lease-admin-secret';

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

  // 세션에 저장된 키 복원
  const savedKey = sessionStorage.getItem(SECRET_SESSION_KEY);
  if (savedKey) {
    box.querySelector('[name="secret_key"]').value = savedKey;
    box.querySelector('#ck-remember').checked = true;
  }

  document.getElementById('add-user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const display_id = f.display_id.value.trim().toLowerCase();
    const password   = f.password.value;
    const full_name  = f.full_name.value.trim();
    const role       = f.role.value;
    const secret     = f.secret_key.value.trim();
    const remember   = f.remember.checked;
    const msg = document.getElementById('add-user-msg');
    const submitBtn = document.getElementById('add-user-submit');
    msg.textContent = '';
    submitBtn.disabled = true;
    submitBtn.textContent = '생성 중…';

    try {
      if (!/^[a-z0-9_]+$/i.test(display_id)) throw new Error('아이디는 영문/숫자/언더스코어만 사용 가능합니다.');
      const email = `${display_id}${window.TOTALAS.EMAIL_DOMAIN}`;

      // 1. Supabase Auth admin createUser
      const r = await fetch(`${window.TOTALAS.URL}/auth/v1/admin/users`, {
        method: 'POST',
        headers: {
          'apikey': secret,
          'Authorization': `Bearer ${secret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email, password, email_confirm: true,
          user_metadata: { display_id, role, full_name },
        }),
      });
      if (!r.ok) {
        const txt = await r.text();
        throw new Error(`auth admin createUser 실패 ${r.status}: ${txt.slice(0, 200)}`);
      }
      const created = await r.json();
      const uid = created.id;

      // 2. rental_user_profiles INSERT
      const { error: pErr } = await window.totalasAuth.from('rental_user_profiles').insert({
        user_id: uid, display_id, full_name, role, active: true,
      });
      if (pErr) throw pErr;

      // 키 기억
      if (remember) sessionStorage.setItem(SECRET_SESSION_KEY, secret);
      else sessionStorage.removeItem(SECRET_SESSION_KEY);

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

async function deleteUser(uid, displayId) {
  let secret = sessionStorage.getItem(SECRET_SESSION_KEY);
  if (!secret) {
    secret = prompt(`'${displayId}' 사용자를 삭제합니다.\n\nSupabase Secret Key (sb_secret_… 또는 eyJ…)를 입력하세요:`);
    if (!secret) return;
  }
  if (!confirm(`'${displayId}' 계정을 영구 삭제할까요? 이 작업은 되돌릴 수 없습니다.`)) return;

  try {
    // auth admin deleteUser → 프로필도 ON DELETE CASCADE 로 자동 제거
    const r = await fetch(`${window.TOTALAS.URL}/auth/v1/admin/users/${uid}`, {
      method: 'DELETE',
      headers: { 'apikey': secret, 'Authorization': `Bearer ${secret}` },
    });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`삭제 실패 ${r.status}: ${txt.slice(0, 200)}`);
    }
    sessionStorage.setItem(SECRET_SESSION_KEY, secret);
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
