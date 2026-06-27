// 디직스코리아 임대관리 ↔ 접수관리툴(ASMS) Supabase 연동
// ASMS customers 테이블 (5,310건) 검색 → 임대거래처로 가져오기.
// RLS 적용되어 있어 ASMS 계정 로그인 필수 (admin / wolffox 등).
'use strict';

// ASMS Supabase (디직스 wghjnlhfqypamiwukeio — A/S 와 임대 동일 프로젝트 공용)
const ASMS_URL  = 'https://wghjnlhfqypamiwukeio.supabase.co';
const ASMS_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndnaGpubGhmcXlwYW1pd3VrZWlvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNTYyODAsImV4cCI6MjA5NjczMjI4MH0.sOjiDveMGn_uIt6fzu4fqQtlDwNWkkoXWrz6gxy0XZg';

// supabase-js v2 UMD 가 window.supabase 로 노출돼야 함
let _sbClient = null;
function asmsSb() {
  if (!_sbClient && window.supabase?.createClient) {
    _sbClient = window.supabase.createClient(ASMS_URL, ASMS_ANON, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: 'digix-rental-mgmt-asms-auth' },
    });
  }
  return _sbClient;
}

// 현재 로그인 상태
async function asmsCurrentUser() {
  const sb = asmsSb();
  if (!sb) return null;
  const { data: { session } } = await sb.auth.getSession();
  return session?.user || null;
}

async function asmsLogin(email, password) {
  const sb = asmsSb();
  if (!sb) throw new Error('Supabase 클라이언트 미로딩');
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.user;
}

async function asmsLogout() {
  const sb = asmsSb();
  if (!sb) return;
  await sb.auth.signOut();
}

// 고객 검색 (서버측 ilike). cu_name / cu_tel / cu_mobile 검색.
async function asmsSearchCustomers(keyword, limit = 50) {
  const sb = asmsSb();
  if (!sb) throw new Error('Supabase 미연결');
  const k = (keyword || '').trim();
  let q = sb.from('customers')
    .select('cu_number,cu_name,cu_kind,co_name,cu_tel,cu_mobile,cu_mail,co_fax,zipcode1')
    .order('cu_name', { ascending: true })
    .limit(limit);
  if (k) {
    q = q.or(`cu_name.ilike.%${k}%,cu_tel.ilike.%${k}%,cu_mobile.ilike.%${k}%,co_name.ilike.%${k}%`);
  }
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

// cu_number 로 단건 조회
async function asmsGetCustomer(cuNumber) {
  const sb = asmsSb();
  if (!sb) throw new Error('Supabase 미연결');
  const { data, error } = await sb.from('customers')
    .select('*').eq('cu_number', cuNumber).maybeSingle();
  if (error) throw error;
  return data;
}

// ASMS row → 임대거래처 객체 매핑
function asmsToRental(row) {
  return {
    company: row.cu_name || '',
    ceo: '',                              // ASMS 에는 대표자 컬럼 없음
    biz_no: '',                           // 사업자번호 별도 컬럼 없음
    phone: row.cu_mobile || row.cu_tel || '',
    fax: row.co_fax || '',
    email: row.cu_mail || '',
    address: row.zipcode1 || '',          // 주소(우편 포함)
    kakao: '',
    biz_type: '', biz_item: '', corp_no: '',
    memo: [
      row.cu_kind ? `임대제품: ${row.cu_kind}` : '',
      row.co_name ? `주판매: ${row.co_name}` : '',
    ].filter(Boolean).join('\n'),
    asms_cu_number: row.cu_number,        // 연동 식별자
  };
}

window.asmsSync = {
  currentUser: asmsCurrentUser,
  login: asmsLogin,
  logout: asmsLogout,
  search: asmsSearchCustomers,
  get: asmsGetCustomer,
  toRental: asmsToRental,
};
