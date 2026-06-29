// ===========================================================
// totalas — 임대거래처 (Growth CRM)
// rental_customers + rental_assignments + rental_items + rental_counters
// Cross-sell 인사이트 · NAS 잠재고객 · 품목별 AS 주기
// ===========================================================
'use strict';

// 품목 마스터 (rental_item_types) — boot 시점에 로드됨. 모든 모듈 공유.
let ITEM_TYPES = [];   // [{ id, label, category, icon, sort_order, form_label, is_print, active }, ...]

const STATE = {
  customers: [],         // 가공된 거래처 배열 (각 c 에 _group 매핑 포함)
  billingGroups: [],     // 청구 그룹 마스터 (rental_billing_groups)
  groupById: {},         // { group_id: group } — 빠른 조회용
  countersByItem: {},    // { item_id: [{ym, bw, color}, ...] }
  rateHistoryByItem: {}, // { item_id: [{effective_date, ...}, ...] } — 자산 카드 이력 요약 캐시
  selectedId: null,
  collapsedGroups: {},   // { group_id: true } — 좌측 리스트 그룹 접기 상태
  filters: {
    q: '',
    sort: 'name',
    mode: 'active',      // 'active' | 'archived'
  },
};

// 카테고리 분류 (item.subtype 매칭)
const CAT_MAP = {
  // IT
  'PC': 'IT', 'pc': 'IT', '컴퓨터': 'IT', '데스크탑': 'IT', '노트북': 'IT',
  'monitor': 'IT', '모니터': 'IT', 'NAS': 'IT', 'nas': 'IT',
  'PC유지보수': 'IT', '유지보수': 'IT',
  // 출력
  '잉크젯': '출력', 'inkjet': '출력',
  '레이저': '출력', 'laser': '출력',
  '복합기': '출력', 'mfp': '출력', '복사기': '출력',
  // 위생
  '웰리스': '위생', 'wellis': '위생', '제균기': '위생', '필터': '위생',
};

// AS 주기 (개월) — claude.md 정책
const AS_SCHEDULE = {
  '잉크젯': { months: 3, task: '프린터 헤드 점검·세척' },
  'inkjet': { months: 3, task: '프린터 헤드 점검·세척' },
  '레이저': { months: 6, task: '드럼·롤러 점검' },
  'laser':  { months: 6, task: '드럼·롤러 점검' },
  '복합기': { months: 6, task: '드럼·스캐너 점검' },
  'mfp':    { months: 6, task: '드럼·스캐너 점검' },
  'PC':     { months: 12, task: 'OS 최적화·청소' },
  'pc':     { months: 12, task: 'OS 최적화·청소' },
  '컴퓨터': { months: 12, task: 'OS 최적화·청소' },
  '데스크탑': { months: 12, task: 'OS 최적화·청소' },
  '노트북':   { months: 12, task: 'OS 최적화·청소' },
  'PC유지보수': { months: 6, task: 'PC 점검·청소·업데이트' },
  '유지보수':  { months: 6, task: 'PC 점검·청소·업데이트' },
  'monitor': { months: 24, task: '패널·케이블 점검' },
  '모니터':  { months: 24, task: '패널·케이블 점검' },
  '웰리스': { months: 2, task: '필터 교체' },
  'wellis': { months: 2, task: '필터 교체' },
  '제균기': { months: 2, task: '필터 교체' },
  'NAS':    { months: 6, task: '디스크 SMART·백업 점검' },
  'nas':    { months: 6, task: '디스크 SMART·백업 점검' },
};

function categoryOf(subtype) {
  if (!subtype) return '기타';
  const s = String(subtype).trim();
  if (CAT_MAP[s]) return CAT_MAP[s];
  // 키워드 부분일치
  for (const k of Object.keys(CAT_MAP)) {
    if (s.includes(k)) return CAT_MAP[k];
  }
  return '기타';
}

// 표시용 subtype 정규화 — 동의어(영문/한글) 를 같은 그룹으로 묶기 위함
// (DB 의 실제 값은 보존, 그룹화/표시에만 사용)
function normalizeSubtype(subtype) {
  const s = String(subtype || '').trim();
  if (!s) return '기타';
  const lower = s.toLowerCase();
  // 컴퓨터 (PC / 데스크탑 등) — 단 '노트북' 은 별도
  if (/노트북|notebook|laptop/i.test(s)) return '노트북';
  if (/^pc$|^컴퓨터$|^데스크탑$/i.test(s) || /\bpc\b/i.test(lower) || /컴퓨터|데스크탑/.test(s)) return '컴퓨터';
  // 모니터 (monitor / 모니터)
  if (/^monitor$|^모니터$/i.test(s) || /\bmonitor\b/i.test(lower) || /모니터/.test(s)) return '모니터';
  // 나스 / NAS
  if (/^nas$|^나스$/i.test(s) || /\bnas\b/i.test(lower) || /나스/.test(s)) return '나스';
  // PC유지보수
  if (/유지보수|maintenance|maintain/i.test(s)) return 'PC유지보수';
  // 웰리스
  if (/웰리스|wellis|wellness|제균기/i.test(s)) return '웰리스';
  // 출력기기는 그대로 (흑백복합기/컬러복합기/...)
  return s;
}

function asScheduleOf(subtype) {
  if (!subtype) return null;
  const s = String(subtype).trim();
  if (AS_SCHEDULE[s]) return AS_SCHEDULE[s];
  for (const k of Object.keys(AS_SCHEDULE)) {
    if (s.includes(k)) return AS_SCHEDULE[k];
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// 브랜드 / 모델 프리셋 — Supabase rental_item_presets 로 로드됨
// Supabase 로드 실패 시 아래 상수를 fallback 으로 사용
// ─────────────────────────────────────────────────────────────

// 런타임 캐시 (loadItemPresets() 가 채움)
let _presetsLoaded = false;
let _brandList  = [];  // [{value, usage_count}, ...]
let _modelList  = [];  // [{value, parent_brand, usage_count}, ...]
// 브랜드 → 모델 목록 맵 (동적 구성)
let _brandModelMap = {};  // { 브랜드: [모델명, ...] }

const BRAND_PRESETS = [
  '교세라',
  '엡손',
  '브라더',
  '캐논',
  '조립',
  '위더스',
  '삼성',
  '유디아',
  '삼보',
  '시놀로지',
  '웰리스',
  '기타',
];

const MODEL_PRESETS = [
  'TASKalfa 251ci',
  'TASKalfa 351ci',
  'TASKalfa 2553ci',
  'TASKalfa 2552ci',
  'TASKalfa 3252ci',
  'TASKalfa 3253ci',
  'ECOSYS M5526cdn',
  'Brother MFC-J2740DW',
  '기타',
];

// 브랜드별 추천 모델 매핑 (브랜드 선택 시 datalist 내용 교체)
const BRAND_MODEL_MAP = {
  '교세라': [
    'TASKalfa 251ci',
    'TASKalfa 351ci',
    'TASKalfa 2553ci',
    'TASKalfa 2552ci',
    'TASKalfa 3252ci',
    'TASKalfa 3253ci',
    'ECOSYS M5526cdn',
  ],
  '엡손': [
    'EcoTank L3250',
    'EcoTank L5290',
    'WorkForce WF-2930',
  ],
  '브라더': [
    'Brother MFC-J2740DW',
    'Brother MFC-L2700DW',
    'Brother DCP-L2550DW',
  ],
  '캐논': [
    'imageRUNNER 2206N',
    'imageRUNNER 2425',
    'MF445dw',
  ],
  '시놀로지': [
    'DS220+',
    'DS420+',
    'DS720+',
    'DS920+',
    'DS1621+',
  ],
  '웰리스': [
    'Wellis W100',
    'Wellis W200',
  ],
  '조립': [],
  '위더스': [],
  '삼성': [],
  '유디아': [],
  '삼보': [],
  '기타': [],
};

/**
 * 브랜드에 따라 모델 datalist 옵션을 교체한다.
 * Supabase 로드 캐시(_brandModelMap) 우선, 없으면 BRAND_MODEL_MAP fallback.
 * 브랜드가 없거나 매핑이 없으면 전체 모델 목록을 사용한다.
 */
function updateModelDatalist(datalistEl, brand) {
  let models;
  if (_presetsLoaded) {
    // Supabase 캐시 사용
    if (brand && _brandModelMap[brand] && _brandModelMap[brand].length > 0) {
      models = _brandModelMap[brand];
    } else {
      // 브랜드 미지정 or 매핑 없음 → usage_count 내림차순 전체 모델
      models = _modelList.map(r => r.value);
    }
  } else {
    // Fallback: 하드코딩 상수
    models = (brand && BRAND_MODEL_MAP[brand] && BRAND_MODEL_MAP[brand].length > 0)
      ? BRAND_MODEL_MAP[brand]
      : MODEL_PRESETS;
  }
  datalistEl.innerHTML = models
    .map(m => `<option value="${escapeAttr(m)}">`)
    .join('');
}

/**
 * Supabase rental_item_presets 에서 브랜드/모델 목록을 로드해 캐시에 저장.
 * 실패해도 예외를 외부로 전파하지 않는다 (fallback 상수로 동작).
 */
async function loadItemPresets() {
  const supa = window.totalasAuth;
  if (!supa) return;
  try {
    const { data, error } = await supa
      .from('rental_item_presets')
      .select('type, value, parent_brand, usage_count')
      .order('usage_count', { ascending: false });
    if (error) throw error;
    if (!data || !data.length) return;

    _brandList = data.filter(r => r.type === 'brand');
    _modelList = data.filter(r => r.type === 'model');

    // 브랜드 → 모델 맵 재구성
    _brandModelMap = {};
    for (const r of _modelList) {
      const key = r.parent_brand || '';
      if (!_brandModelMap[key]) _brandModelMap[key] = [];
      _brandModelMap[key].push(r.value);
    }
    _presetsLoaded = true;
  } catch (e) {
    console.warn('[loadItemPresets] Supabase 로드 실패, fallback 사용', e);
  }
}

/**
 * 자산 저장 후 brand/model 값을 rental_item_presets 에 upsert (무음 학습).
 * 2글자 미만이거나 공백만인 경우는 건너뜀.
 */
async function upsertItemPreset(brand, model) {
  const supa = window.totalasAuth;
  if (!supa) return;

  const rows = [];
  const b = (brand || '').trim();
  const m = (model || '').trim();

  if (b.length >= 2) {
    rows.push({ type: 'brand', value: b, parent_brand: null });
  }
  if (m.length >= 2) {
    rows.push({ type: 'model', value: m, parent_brand: b || null });
  }
  if (!rows.length) return;

  try {
    for (const row of rows) {
      // 이미 있으면 usage_count + 1, 없으면 신규 INSERT
      const { data: existing } = await supa
        .from('rental_item_presets')
        .select('id, usage_count')
        .eq('type', row.type)
        .eq('value', row.value)
        .eq('parent_brand', row.parent_brand === null ? '' : row.parent_brand)
        .maybeSingle();

      // parent_brand NULL 처리: eq('parent_brand', null) 은 IS NULL 이므로
      // 테이블 COALESCE 제약에 맞춰 '' 로 저장된 경우를 포함해 두 가지로 조회
      if (existing) {
        await supa
          .from('rental_item_presets')
          .update({ usage_count: (existing.usage_count || 1) + 1, updated_at: new Date().toISOString() })
          .eq('id', existing.id);
        // 캐시도 즉시 반영
        if (row.type === 'brand') {
          const cached = _brandList.find(r => r.value === row.value);
          if (cached) cached.usage_count = (existing.usage_count || 1) + 1;
        } else {
          const cached = _modelList.find(r => r.value === row.value && r.parent_brand === row.parent_brand);
          if (cached) cached.usage_count = (existing.usage_count || 1) + 1;
        }
      } else {
        const insertRow = {
          type: row.type,
          value: row.value,
          parent_brand: row.parent_brand,
          usage_count: 1,
        };
        const { error: insErr } = await supa
          .from('rental_item_presets')
          .insert(insertRow);
        if (!insErr) {
          // 캐시에 추가
          if (row.type === 'brand') {
            _brandList.unshift({ value: row.value, usage_count: 1 });
          } else {
            _modelList.unshift({ value: row.value, parent_brand: row.parent_brand, usage_count: 1 });
            // _brandModelMap 갱신
            const mapKey = row.parent_brand || '';
            if (!_brandModelMap[mapKey]) _brandModelMap[mapKey] = [];
            if (!_brandModelMap[mapKey].includes(row.value)) {
              _brandModelMap[mapKey].unshift(row.value);
            }
          }
        }
      }
    }
  } catch (e) {
    // 학습 실패는 조용히 무시 (저장 자체는 성공)
    console.warn('[upsertItemPreset] 실패 (무시)', e);
  }
}

// ─────────────────────────────────────────────────────────────
// 프리셋 관리 모달 (브랜드 / 모델 공통)
// ─────────────────────────────────────────────────────────────

/**
 * _presetsLoaded / _brandList / _modelList / _brandModelMap 을 갱신한 뒤
 * 현재 열린 자산 폼의 datalist 를 즉시 재구성한다.
 */
function _refreshDatalistsInForm() {
  const body = document.getElementById('rc-modal-body');
  if (!body) return;
  const brandDl = body.querySelector('#dl-brand-presets');
  const modelDl = body.querySelector('#dl-model-presets');
  const brandInput = body.querySelector('#asset-brand-input');
  if (brandDl) {
    const brands = _presetsLoaded && _brandList.length
      ? _brandList.map(r => r.value)
      : BRAND_PRESETS;
    brandDl.innerHTML = brands.map(b => `<option value="${escapeAttr(b)}">`).join('');
  }
  if (modelDl) {
    updateModelDatalist(modelDl, brandInput ? brandInput.value.trim() : '');
  }
}

/* PM = Preset Manager */
const _PM = {
  mode: 'brand',          // 'brand' | 'model'
  showAll: false,         // 모델 모달: 전체 보기 여부
  currentBrand: '',       // 모델 모달: 현재 선택 브랜드
  editingValue: null,     // 인라인 수정 중인 값 (null = 비편집)
};

function openPresetManager(mode) {
  _PM.mode = mode;
  _PM.showAll = false;
  _PM.editingValue = null;

  // 현재 브랜드 input 값 스냅샷
  const body = document.getElementById('rc-modal-body');
  _PM.currentBrand = body
    ? (body.querySelector('#asset-brand-input') || {}).value?.trim() || ''
    : '';

  // 모달 헤더
  const titleEl = document.getElementById('pm-title');
  if (titleEl) titleEl.textContent = mode === 'brand' ? '브랜드 목록 관리' : '모델 목록 관리';

  // "전체 모델 보기" 토글 — 모델 모달에서만, 브랜드가 선택된 경우만 표시
  const toggleBtn = document.getElementById('pm-toggle-all');
  if (toggleBtn) {
    if (mode === 'model' && _PM.currentBrand) {
      toggleBtn.style.display = '';
      toggleBtn.textContent = '전체 모델 보기';
    } else {
      toggleBtn.style.display = 'none';
    }
  }

  // 검색창 초기화
  const searchEl = document.getElementById('pm-search');
  if (searchEl) {
    searchEl.value = '';
    searchEl.placeholder = mode === 'brand' ? '브랜드 검색...' : '모델 검색...';
  }

  // 추가 인풋 placeholder
  const addInput = document.getElementById('pm-add-input');
  if (addInput) {
    addInput.value = '';
    addInput.placeholder = mode === 'brand' ? '새 브랜드 이름...' : '새 모델 이름...';
  }

  _renderPresetList('');

  const backdrop = document.getElementById('pm-modal');
  if (backdrop) backdrop.classList.add('show');
  if (searchEl) setTimeout(() => searchEl.focus(), 80);
}

function closePresetManager() {
  const backdrop = document.getElementById('pm-modal');
  if (backdrop) backdrop.classList.remove('show');
  _PM.editingValue = null;
}

function _getPresetRows(filterQ) {
  const q = (filterQ || '').toLowerCase();
  let rows;
  if (_PM.mode === 'brand') {
    rows = _presetsLoaded ? [..._brandList] : BRAND_PRESETS.map(v => ({ value: v, usage_count: 0 }));
  } else {
    if (_presetsLoaded) {
      if (!_PM.showAll && _PM.currentBrand) {
        rows = _modelList.filter(r => r.parent_brand === _PM.currentBrand);
      } else {
        rows = [..._modelList];
      }
    } else {
      const all = _PM.currentBrand && BRAND_MODEL_MAP[_PM.currentBrand]
        ? BRAND_MODEL_MAP[_PM.currentBrand]
        : MODEL_PRESETS;
      rows = all.map(v => ({ value: v, parent_brand: _PM.currentBrand, usage_count: 0 }));
    }
  }
  // 검색 필터
  if (q) rows = rows.filter(r => r.value.toLowerCase().includes(q));
  // usage_count 내림차순
  rows.sort((a, b) => (b.usage_count || 0) - (a.usage_count || 0));
  return rows;
}

function _renderPresetList(filterQ) {
  const listEl = document.getElementById('pm-list');
  if (!listEl) return;
  const rows = _getPresetRows(filterQ);

  if (!rows.length) {
    listEl.innerHTML = `<div class="pm-empty">항목이 없습니다.</div>`;
    return;
  }

  listEl.innerHTML = rows.map(r => {
    const dim = (r.usage_count || 0) <= 1 ? ' dim' : '';
    const isEditing = _PM.editingValue === r.value;
    const valHtml = isEditing
      ? `<span class="pm-item-val editing"><input id="pm-edit-input" value="${escapeAttr(r.value)}" autocomplete="off"></span>`
      : `<span class="pm-item-val">${escapeHtml(r.value)}</span>`;
    const editIcon = isEditing ? '&#10003;' : '&#9998;';
    return `<div class="pm-item${dim}" data-val="${escapeAttr(r.value)}" data-pb="${escapeAttr(r.parent_brand || '')}">
      ${valHtml}
      <span class="pm-item-cnt">${r.usage_count || 0}회</span>
      <button class="pm-item-edit" type="button" data-action="edit" title="${isEditing ? '저장' : '이름 수정'}">${editIcon}</button>
      <button class="pm-item-del" type="button" data-action="del" title="삭제">&#10005;</button>
    </div>`;
  }).join('');

  // 편집 모드 진입 시 인풋 포커스
  if (_PM.editingValue !== null) {
    const inp = listEl.querySelector('#pm-edit-input');
    if (inp) { inp.focus(); inp.select(); }
  }
}

async function _deletePreset(value, parentBrand) {
  const supa = window.totalasAuth;
  if (!supa) { toast('인증 정보 없음', 'err'); return; }
  const label = _PM.mode === 'model' && parentBrand ? `${parentBrand} / ${value}` : value;
  if (!confirm(`'${label}'을(를) 목록에서 삭제할까요?\n(이미 저장된 자산 데이터에는 영향 없음)`)) return;

  try {
    let query = supa.from('rental_item_presets')
      .delete()
      .eq('type', _PM.mode)
      .eq('value', value);
    if (_PM.mode === 'model') {
      query = query.eq('parent_brand', parentBrand || '');
    }
    const { error } = await query;
    if (error) throw error;

    // 캐시에서 제거
    if (_PM.mode === 'brand') {
      _brandList = _brandList.filter(r => r.value !== value);
      // 해당 브랜드의 모델 맵도 정리
      delete _brandModelMap[value];
    } else {
      _modelList = _modelList.filter(r => !(r.value === value && (r.parent_brand || '') === (parentBrand || '')));
      const mapKey = parentBrand || '';
      if (_brandModelMap[mapKey]) {
        _brandModelMap[mapKey] = _brandModelMap[mapKey].filter(v => v !== value);
      }
    }

    // datalist 즉시 갱신
    _refreshDatalistsInForm();
    toast(`'${value}' 삭제 완료`, 'ok');
    const searchEl = document.getElementById('pm-search');
    _renderPresetList(searchEl ? searchEl.value : '');
  } catch (e) {
    console.error('[deletePreset]', e);
    toast('삭제 실패: ' + (e.message || e), 'err');
  }
}

async function _savePresetEdit(oldValue, newValue, parentBrand) {
  const nv = (newValue || '').trim();
  if (!nv) { toast('값을 입력하세요.', 'err'); return; }
  if (nv === oldValue) { _PM.editingValue = null; _renderPresetList(''); return; }
  const supa = window.totalasAuth;
  if (!supa) { toast('인증 정보 없음', 'err'); return; }

  try {
    let query = supa.from('rental_item_presets')
      .update({ value: nv, updated_at: new Date().toISOString() })
      .eq('type', _PM.mode)
      .eq('value', oldValue);
    if (_PM.mode === 'model') {
      query = query.eq('parent_brand', parentBrand || '');
    }
    const { error } = await query;
    if (error) throw error;

    // 캐시 갱신
    if (_PM.mode === 'brand') {
      const cached = _brandList.find(r => r.value === oldValue);
      if (cached) cached.value = nv;
      // brandModelMap key 도 변경
      if (_brandModelMap[oldValue] !== undefined) {
        _brandModelMap[nv] = _brandModelMap[oldValue];
        delete _brandModelMap[oldValue];
      }
    } else {
      const cached = _modelList.find(r => r.value === oldValue && (r.parent_brand || '') === (parentBrand || ''));
      if (cached) cached.value = nv;
      const mapKey = parentBrand || '';
      if (_brandModelMap[mapKey]) {
        const idx = _brandModelMap[mapKey].indexOf(oldValue);
        if (idx !== -1) _brandModelMap[mapKey][idx] = nv;
      }
    }

    _PM.editingValue = null;
    _refreshDatalistsInForm();
    toast(`'${oldValue}' → '${nv}' 수정 완료`, 'ok');
    const searchEl = document.getElementById('pm-search');
    _renderPresetList(searchEl ? searchEl.value : '');
  } catch (e) {
    console.error('[savePresetEdit]', e);
    toast('수정 실패: ' + (e.message || e), 'err');
  }
}

async function _addPreset(value) {
  const v = (value || '').trim();
  if (v.length < 2) { toast('2글자 이상 입력하세요.', 'err'); return; }
  const supa = window.totalasAuth;
  if (!supa) { toast('인증 정보 없음', 'err'); return; }

  const pb = _PM.mode === 'model' ? (_PM.showAll ? null : (_PM.currentBrand || null)) : null;
  const row = {
    type: _PM.mode,
    value: v,
    parent_brand: pb,
    usage_count: 0,
  };

  try {
    const { error } = await supa.from('rental_item_presets').insert(row);
    if (error) throw error;

    // 캐시에 추가
    if (_PM.mode === 'brand') {
      if (!_brandList.find(r => r.value === v)) {
        _brandList.push({ value: v, usage_count: 0 });
      }
    } else {
      if (!_modelList.find(r => r.value === v && (r.parent_brand || '') === (pb || ''))) {
        _modelList.push({ value: v, parent_brand: pb, usage_count: 0 });
        const mapKey = pb || '';
        if (!_brandModelMap[mapKey]) _brandModelMap[mapKey] = [];
        if (!_brandModelMap[mapKey].includes(v)) _brandModelMap[mapKey].push(v);
      }
    }

    const addInput = document.getElementById('pm-add-input');
    if (addInput) addInput.value = '';
    _refreshDatalistsInForm();
    toast(`'${v}' 추가 완료`, 'ok');
    const searchEl = document.getElementById('pm-search');
    _renderPresetList(searchEl ? searchEl.value : '');
  } catch (e) {
    // UNIQUE 충돌 등
    toast('추가 실패: ' + (e.message || e), 'err');
  }
}

function _bindPresetManagerEvents() {
  // 닫기
  document.getElementById('pm-close-btn')?.addEventListener('click', closePresetManager);
  document.getElementById('pm-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closePresetManager();
  });

  // 검색
  document.getElementById('pm-search')?.addEventListener('input', (e) => {
    _renderPresetList(e.target.value);
  });

  // "전체 모델 보기" 토글
  document.getElementById('pm-toggle-all')?.addEventListener('click', () => {
    _PM.showAll = !_PM.showAll;
    const btn = document.getElementById('pm-toggle-all');
    if (btn) btn.textContent = _PM.showAll ? '브랜드 필터 적용' : '전체 모델 보기';
    const searchEl = document.getElementById('pm-search');
    _renderPresetList(searchEl ? searchEl.value : '');
  });

  // 목록 이벤트 위임 (삭제 / 수정)
  document.getElementById('pm-list')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const item = btn.closest('.pm-item');
    if (!item) return;
    const val = item.dataset.val;
    const pb  = item.dataset.pb || '';
    const action = btn.dataset.action;

    if (action === 'del') {
      await _deletePreset(val, pb);
    } else if (action === 'edit') {
      if (_PM.editingValue === val) {
        // 저장 확인
        const inp = item.querySelector('#pm-edit-input');
        await _savePresetEdit(val, inp ? inp.value : val, pb);
      } else {
        _PM.editingValue = val;
        const searchEl = document.getElementById('pm-search');
        _renderPresetList(searchEl ? searchEl.value : '');
      }
    }
  });

  // 편집 인풋에서 Enter 키
  document.getElementById('pm-list')?.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const inp = e.target.closest('#pm-edit-input');
    if (!inp) return;
    const item = inp.closest('.pm-item');
    if (!item) return;
    await _savePresetEdit(item.dataset.val, inp.value, item.dataset.pb || '');
  });

  // 추가
  document.getElementById('pm-add-btn')?.addEventListener('click', async () => {
    const addInput = document.getElementById('pm-add-input');
    await _addPreset(addInput ? addInput.value : '');
  });
  document.getElementById('pm-add-input')?.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      await _addPreset(e.target.value);
    }
  });
}

// ─────────────────────────────────────────────────────────────
// 부팅
// ─────────────────────────────────────────────────────────────
async function boot() {
  bindUI();
  // 품목 마스터 먼저 — 자산 폼 렌더링/카테고리 분류에 사용
  try {
    ITEM_TYPES = await window.loadItemTypes();
  } catch (e) {
    console.warn('[boot] loadItemTypes 실패 (시드 모드)', e);
    ITEM_TYPES = [];
  }
  // 브랜드/모델 프리셋 로드 (실패해도 fallback 상수로 동작)
  await loadItemPresets();
  // 프리셋 관리 모달 이벤트 등록 (DOM 준비 후 1회)
  _bindPresetManagerEvents();
  await loadAll();
}
if (window.totalasAuth) {
  boot();
} else {
  document.addEventListener('totalas:ready', boot, { once: true });
  // 안전망: 2초 안에도 미준비면 그대로 부팅 시도 (loadAll 내부에서 에러 표시)
  setTimeout(() => { if (!STATE.customers.length) boot(); }, 2000);
}

function bindUI() {
  document.getElementById('rc-search').addEventListener('input', (e) => {
    STATE.filters.q = e.target.value.trim();
    renderList();
  });
  document.getElementById('rc-sort').addEventListener('change', (e) => {
    STATE.filters.sort = e.target.value;
    renderList();
  });

  // ☰ 전체메뉴 — 검색 리셋 + 전체 거래처 보기로 복원 + 부모 사이드바 토글
  const menuBtn = document.getElementById('rc-toggle-menu');
  if (menuBtn) menuBtn.addEventListener('click', () => {
    // 1) 검색 / 선택 리셋 + 좌측 리스트 + 우측 전체 보기
    const searchEl = document.getElementById('rc-search');
    if (searchEl) searchEl.value = '';
    STATE.filters.q = '';
    STATE.selectedId = null;
    renderList();
    renderDetail();
    // 2) 부모 asms.html 사이드바 토글 (iframe 안일 때만)
    try {
      const parentDoc = (window.parent && window.parent !== window) ? window.parent.document : null;
      if (!parentDoc) return;
      const mb = parentDoc.getElementById('mobile-menu-btn');
      if (mb) { mb.click(); return; }
      parentDoc.getElementById('sidebar')?.classList.toggle('open');
      parentDoc.getElementById('sidebar-backdrop')?.classList.toggle('show');
    } catch (err) {
      console.warn('[rental-customers] 사이드바 토글 실패:', err);
    }
  });
  // 활성/만기 모드 토글
  document.querySelectorAll('input[name="rc-mode"]').forEach(r => {
    r.addEventListener('change', async (e) => {
      if (!e.target.checked) return;
      STATE.filters.mode = e.target.value;
      STATE.selectedId = null;
      await loadAll();
      renderDetail();
    });
  });
  document.getElementById('btn-add').addEventListener('click', () => openForm(null));
  document.getElementById('btn-item-types')?.addEventListener('click', () => openItemTypesModal());

  // 상단 "새 계약서 작성" 버튼
  // copy-rental-contract 자식 페이지를 새 창으로 열고, 활성 거래처 정보를 URL 해시로 전달
  const topCtBtn = document.getElementById('btn-ct-new-top');
  if (topCtBtn) {
    topCtBtn.addEventListener('click', () => {
      const sel = STATE.selectedId
        ? STATE.customers.find(x => x.id === STATE.selectedId)
        : null;
      const params = new URLSearchParams();
      if (sel) {
        params.set('customer_id', sel.id || '');
        if (sel.company)          params.set('name',         sel.company);
        if (sel.trade_name)       params.set('trade_name',   sel.trade_name);
        if (sel.biz_no)           params.set('reg',          sel.biz_no);
        if (sel.ceo)              params.set('ceo',          sel.ceo);
        if (sel.contact_name)     params.set('person',       sel.contact_name);
        if (sel.biz_type)         params.set('biz',          sel.biz_type);
        if (sel.biz_item)         params.set('item',         sel.biz_item);
        if (sel.address)          params.set('addr',         sel.address);
        if (sel.install_address)  params.set('install_addr', sel.install_address);
        if (sel.phone)            params.set('tel',          sel.phone);
        if (sel.fax)              params.set('fax',          sel.fax);
        if (sel.mobile)           params.set('mobile',       sel.mobile);
        if (sel.email)            params.set('email',        sel.email);
        if (sel.billing_type)     params.set('billing',      sel.billing_type);
        if (sel.deposit)          params.set('deposit',      sel.deposit);
        if (sel.period_years)     params.set('period',       sel.period_years);
      }
      const url = './copy-rental-contract/index.html' + (params.toString() ? '#' + params.toString() : '');
      window.open(url, '_blank');
    });
  }

  // 모달 외부(backdrop) 클릭으로 닫히지 않도록 — 입력 중 실수 방지
  // 닫기는 「✕」 버튼 또는 ESC 키로만 가능
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('rc-modal').classList.contains('show')) {
      closeModal();
    }
  });

  // copy-rental-contract 자식 창에서 보내는 저장 요청 수신
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.type !== 'rental-contract-save') return;
    handleChildContractSave(m, e.source);
  });

  // 고객 카운터프로그램 — 버전 정보 로드 (업데이트 날짜 표시 + 캐시 우회)
  loadCollectorVersion();
}

// ─────────────────────────────────────────────────────────────
// 고객 카운터프로그램 버전 표시
// downloads/collector-version.json 을 읽어 버튼에 업데이트 날짜 표시.
// release.bat 실행 시 JSON 이 자동 갱신됨.
// ─────────────────────────────────────────────────────────────
async function loadCollectorVersion() {
  const btn = document.getElementById('btn-collector-download');
  if (!btn) return;
  try {
    const res = await fetch('../../downloads/collector-version.json?ts=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return;
    const v = await res.json();
    if (!v || !v.updated_at) return;
    const fname = v.filename || 'digix-collector.zip';
    const isZip = /\.zip$/i.test(fname);
    const label = isZip ? '고객 카운터프로그램 (ZIP)' : '고객 카운터프로그램';
    btn.innerHTML = `⬇ ${label} <span style="opacity:.7;font-size:11px;font-weight:500;">(${v.updated_at})</span>`;
    btn.title = (
      `업데이트: ${v.updated_at} · 크기: ${v.size_mb}MB · 페어링 코드: digix\n` +
      (isZip ? '설치: ZIP 압축 풀기 → 안의 digix-collector 폴더의 EXE 더블클릭\n' : '') +
      '안랩 V3 가 차단하면 digix-collector 폴더를 V3 예외에 추가'
    );
    btn.setAttribute('download', fname);
    // 버전 쿼리스트링으로 브라우저 캐시 우회 (새 빌드 받도록)
    btn.href = `../../downloads/${fname}?v=${encodeURIComponent(v.version || v.updated_at)}`;
  } catch (e) {
    console.warn('[collector-version] 로드 실패 (캐시 미반영 가능):', e);
  }
}

// ─────────────────────────────────────────────────────────────
// 자식 페이지(copy-rental-contract)에서 받은 저장 요청 처리
// 활성 거래처에 회사 정보 동기화 + rental_contracts 에 계약 + 임대 물품 저장
// ─────────────────────────────────────────────────────────────
async function handleChildContractSave(msg, sourceWin) {
  const reply = (ok, message, extra) => {
    try { sourceWin && sourceWin.postMessage(Object.assign({
      type: 'rental-contract-save-result', ok, message
    }, extra || {}), '*'); } catch (_) {}
  };
  const supa = window.totalasAuth;
  if (!supa) { reply(false, '인증이 준비되지 않았습니다.'); return; }

  const cu = msg.customer || {};
  const company = (cu.name || '').trim();
  if (!company) { reply(false, '회사명을 입력하세요.'); return; }
  const ri = msg.rentalInfo || {};

  // ── 1) 대상 거래처 결정 ──
  //   ① msg.customer_id 가 STATE에 있으면 사용 (부모가 선택해서 자식을 열었을 때)
  //   ② STATE.selectedId 가 있으면 그 거래처 사용 (자식 열린 사이 선택이 바뀌었을 때 대비)
  //   ③ DB에서 회사명으로 조회 후 첫 매치
  //   ④ 없으면 신규 INSERT
  let targetId = null;
  let created = false;
  try {
    const candIds = [msg.customer_id, STATE.selectedId].filter(Boolean);
    for (const cid of candIds) {
      if (STATE.customers.some(x => x.id === cid)) { targetId = cid; break; }
    }
    if (!targetId) {
      const { data: found, error: fErr } = await supa
        .from('rental_customers').select('id').eq('company', company).limit(1);
      if (fErr) throw fErr;
      if (found && found.length) targetId = found[0].id;
    }
    if (!targetId) {
      targetId = 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      const { error: insErr } = await supa.from('rental_customers').insert({
        id: targetId,
        company,
        trade_name:      (cu.trade_name || '').trim() || null,
        ceo:             (cu.ceo || '').trim() || null,
        contact_name:    (cu.person || '').trim() || null,
        biz_no:          (cu.reg || '').trim() || null,
        biz_type:        (cu.biz || '').trim() || null,
        biz_item:        (cu.item || '').trim() || null,
        address:         (cu.addr || '').trim() || null,
        install_address: (cu.install_addr || '').trim() || null,
        phone:           (cu.tel || '').trim() || null,
        fax:             (cu.fax || '').trim() || null,
        mobile:          (cu.mobile || '').trim() || null,
        email:           (cu.email || '').trim() || null,
        billing_type: (ri && ri.rBilling) || '전자세금계산서',
        deposit:      parseInt(ri && ri.rDeposit, 10) || null,
        period_years: parseInt(ri && ri.rPeriod, 10) || null,
        active: true
      });
      if (insErr) throw insErr;
      created = true;
    } else {
      // 기존 거래처: 입력된 값으로 업데이트 (빈 값은 덮어쓰지 않음)
      const patch = {};
      if (company)           patch.company         = company;
      if (cu.trade_name)     patch.trade_name      = cu.trade_name.trim();
      if (cu.ceo)            patch.ceo             = cu.ceo.trim();
      if (cu.person)         patch.contact_name    = cu.person.trim();
      if (cu.reg)            patch.biz_no          = cu.reg.trim();
      if (cu.biz)            patch.biz_type        = cu.biz.trim();
      if (cu.item)           patch.biz_item        = cu.item.trim();
      if (cu.addr)           patch.address         = cu.addr.trim();
      if (cu.install_addr)   patch.install_address = cu.install_addr.trim();
      if (cu.tel)            patch.phone           = cu.tel.trim();
      if (cu.fax)            patch.fax             = cu.fax.trim();
      if (cu.mobile)         patch.mobile          = cu.mobile.trim();
      if (cu.email)          patch.email           = cu.email.trim();
      if (ri && ri.rBilling)  patch.billing_type = ri.rBilling;
      if (ri && ri.rDeposit)  patch.deposit      = parseInt(ri.rDeposit, 10) || 0;
      if (ri && ri.rPeriod)   patch.period_years = parseInt(ri.rPeriod, 10) || null;
      if (Object.keys(patch).length) {
        const { error: upErr } = await supa.from('rental_customers')
          .update(patch).eq('id', targetId);
        if (upErr) throw upErr;
      }
    }
  } catch (err) {
    console.error(err);
    reply(false, '거래처 저장 실패: ' + (err.message || err));
    return;
  }

  // ── 2) rental_contracts insert (버전 관리 — 항상 새 id, 이전 row 보존) ──
  const items = Array.isArray(msg.rentalItems) ? msg.rentalItems : [];
  // 매 저장마다 새 id 생성 (수정해도 이전 계약서 row 그대로 남음)
  const contractId = 'ct_' + targetId + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const contractPayload = {
    id: contractId,
    customer_id: targetId,
    contract_no: ri.docNum || null,
    contract_date: ri.docDate || new Date().toISOString().slice(0,10),
    period_years: parseInt(ri.rPeriod, 10) || null,
    deposit: parseInt(ri.rDeposit, 10) || 0,
    install_fee: 0,
    company_snapshot:      company,
    contact_name_snapshot: cu.person || cu.ceo || '',
    biz_no_snapshot:       cu.reg || '',
    address_snapshot:      cu.addr || '',
    phone_snapshot:        cu.tel || '',
    email_snapshot:        cu.email || '',
    items: items,                                    // 임대 물품 내역 (JSON)
    terms: [ri.rt1, ri.rt2, ri.rt3, ri.rt4, ri.rt5].filter(Boolean),
    extras: [ri.re1, ri.re2, ri.re3, ri.re4].filter(Boolean),
    special_terms: [ri.rcSpecial1, ri.rcSpecial2].filter(Boolean).join('\n') || null,
    payment_method: ri.rPayMethod || 'account',
    payment_info: {
      bank: ri.rBank || '', account: ri.rAccount || '',
      holder: ri.rHolder || '', resid: ri.rResid || '',
      debit_day: ri.rDebitDay || '', debit_amt: parseInt(ri.rDebitAmt, 10) || 0,
      bank_memo: ri.rBankMemo || '', card_exp: ri.rCardExp || '',
      bill_type: ri.rBilling || '', bill_email: ri.rBillEmail || '',
      person: ri.rPerson || '', mobile: ri.rMobile || ''
    },
    sign_supplier:  null,
    sign_applicant: ri.customerSig || null,
    signature_type: ri.customerSig ? 'digital' : 'paper',
    status: 'draft',
    updated_at: new Date().toISOString()
  };

  try {
    const { error: ctErr } = await supa.from('rental_contracts').upsert(contractPayload);
    if (ctErr) throw ctErr;
  } catch (err) {
    console.error(err);
    reply(false, '계약 저장 실패: ' + (err.message || err), { customer_id: targetId });
    // 거래처는 살아 있으니 customer_id 회신은 해줌
    await loadAll(); renderList();
    return;
  }

  // ── 3) UI 갱신 ──
  // 정책: 임대 물품 내역(rental_items + rental_assignments)은 "임대추가" 버튼으로만 추가됨.
  // 임대계약서 저장은 rental_contracts 만 다루고, 자산 자동 등록은 하지 않는다.
  try {
    await loadAll();
    STATE.selectedId = targetId;
    renderList();
    renderDetail();
    if (typeof loadContractsFor === 'function') {
      await loadContractsFor(targetId);
      renderDetail();
    }
  } catch (err) { console.error(err); }

  toast(created ? '신규 거래처 + 계약 저장 완료' : '계약 + 거래처 동기화 완료', 'ok');
  reply(true, created ? '신규 거래처 등록 + 계약 저장 완료' : '활성 거래처에 저장 완료', { customer_id: targetId, contract_id: contractId });
}

// ─────────────────────────────────────────────────────────────
// 임대계약서(자식) 창 열기 — 수정/인쇄용
// 큰 페이로드는 localStorage 토큰으로 전달 (URL 해시 한도 회피)
// ─────────────────────────────────────────────────────────────
function openChildContractWindow(customer, ct, autoPrint) {
  const token = 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  // 부모의 ct 객체 → 자식이 기대하는 payload 모양으로 변환
  const pi = (ct && ct.payment_info) || {};
  const payload = {
    customer_id: customer.id,
    contract_id: ct ? ct.id : null,
    customer: {
      name:         customer.company         || '',
      trade_name:   customer.trade_name      || '',
      reg:          customer.biz_no          || '',
      ceo:          customer.ceo             || '',
      person:       customer.contact_name    || '',
      biz:          customer.biz_type        || '',
      item:         customer.biz_item        || '',
      addr:         customer.address         || '',
      install_addr: customer.install_address || '',
      tel:          customer.phone           || '',
      fax:          customer.fax             || '',
      mobile:       customer.mobile          || '',
      email:        customer.email           || ''
    },
    rentalItems: (ct && Array.isArray(ct.items)) ? ct.items : [],
    rentalInfo: ct ? {
      docNum:    ct.contract_no    || '',
      docDate:   ct.contract_date  || '',
      rPeriod:   ct.period_years   || customer.period_years || 3,
      rDeposit:  ct.deposit        || customer.deposit || 0,
      rMobile:   pi.mobile         || customer.mobile || '',
      rBilling:  pi.bill_type      || customer.billing_type || '전자세금계산서',
      rBank:     pi.bank           || '',
      rAccount:  pi.account        || '',
      rHolder:   pi.holder         || '',
      rResid:    pi.resid          || '',
      rDebitDay: pi.debit_day      || '',
      rDebitAmt: pi.debit_amt      || '',
      rPayMethod: ct.payment_method || 'account',
      rBankMemo: pi.bank_memo      || '',
      rCardExp:  pi.card_exp       || '',
      rt1: (ct.terms||[])[0] || '',
      rt2: (ct.terms||[])[1] || '',
      rt3: (ct.terms||[])[2] || '',
      rt4: (ct.terms||[])[3] || '',
      rt5: (ct.terms||[])[4] || '',
      re1: (ct.extras||[])[0] || '',
      re2: (ct.extras||[])[1] || '',
      re3: (ct.extras||[])[2] || '',
      re4: (ct.extras||[])[3] || '',
      rcSpecial1: ((ct.special_terms || '').split('\n')[0] || '').trim(),
      rcSpecial2: ((ct.special_terms || '').split('\n')[1] || '').trim(),
      customerSig: ct.sign_applicant || ''
    } : null
  };
  try {
    localStorage.setItem('hbs_pending_contract_' + token, JSON.stringify(payload));
    setTimeout(() => { try { localStorage.removeItem('hbs_pending_contract_' + token); } catch (_) {} }, 120000);
  } catch (e) {
    console.error('payload 저장 실패:', e);
    toast('계약 데이터 전달 실패: ' + (e?.message || e), 'err');
    return;
  }
  const params = new URLSearchParams();
  params.set('token', token);
  if (autoPrint) params.set('action', 'print');
  // URL hash 거래처 기본 정보도 함께 — 토큰 로드 실패 시 fallback
  // (14개 필드 전부 포함 — rental_customers 컬럼과 1:1 매핑)
  if (customer.id)               params.set('customer_id',   customer.id);
  if (customer.company)          params.set('name',         customer.company);
  if (customer.trade_name)       params.set('trade_name',   customer.trade_name);
  if (customer.biz_no)           params.set('reg',          customer.biz_no);
  if (customer.ceo)              params.set('ceo',          customer.ceo);
  if (customer.contact_name)     params.set('person',       customer.contact_name);
  if (customer.biz_type)         params.set('biz',          customer.biz_type);
  if (customer.biz_item)         params.set('item',         customer.biz_item);
  if (customer.address)          params.set('addr',         customer.address);
  if (customer.install_address)  params.set('install_addr', customer.install_address);
  if (customer.phone)            params.set('tel',          customer.phone);
  if (customer.fax)              params.set('fax',          customer.fax);
  if (customer.mobile)           params.set('mobile',       customer.mobile);
  if (customer.email)            params.set('email',        customer.email);
  if (customer.billing_type)     params.set('billing',      customer.billing_type);
  if (customer.deposit)          params.set('deposit',      customer.deposit);
  if (customer.period_years)     params.set('period',       customer.period_years);

  window.open('./copy-rental-contract/index.html#' + params.toString(), '_blank');
}

// ─────────────────────────────────────────────────────────────
// 계약서 출력 창 열기 — 임대계약내역 카드의 그룹핑 데이터로 prefill
// openChildContractWindow 와 달리 ct 없이 assignments 기반으로 rentalItems 를 구성
// ─────────────────────────────────────────────────────────────
function openPrintContractWindow(customer) {
  if (!customer) return;

  const assignments = customer._assignments || [];
  if (!assignments.length) {
    toast('등록된 자산이 없습니다.', 'err');
    return;
  }

  // renderContractItemsCard 와 동일한 그룹핑 로직으로 rentalItems 배열 생성
  // counter_mode='total' 자산은 통합매수/초과단가를 별도 필드로 전달
  const groups = new Map();
  for (const a of assignments) {
    const it = a.rental_items || {};
    const subtype          = it.subtype || '';
    const model            = ((it.brand || '') + ' ' + (it.model || '')).trim();
    const counter_mode     = (it.counter_mode === 'total') ? 'total' : 'split';
    const total_free_count = Number(it.total_free_count) || 0;
    const total_unit_price = Number(it.total_unit_price) || 0;
    const bw_free          = Number(a.bw_free)    || 0;
    const co_free          = Number(a.co_free)    || 0;
    const bw_rate          = Number(a.bw_rate)    || 0;
    const co_rate          = Number(a.co_rate)    || 0;
    const monthly_fee      = Number(a.monthly_fee) || 0;
    const start_date       = (a.start_date || it.install_date || '').slice(0, 10);
    const notes            = (it.notes || '').trim();
    const key = [subtype, model, counter_mode, total_free_count, total_unit_price,
                 bw_free, co_free, bw_rate, co_rate, monthly_fee, start_date, notes].join('|');
    if (!groups.has(key)) {
      groups.set(key, {
        subtype,                                   // 품목 분류 (자식 페이지 select 에 매핑)
        name:    model,                            // 모델명
        counter_mode,                              // 'split' | 'total'
        total_free_count,                          // 통합 기본매수
        total_unit_price,                          // 통합 초과단가
        bcount:  bw_free,
        ccount:  co_free,
        bprice:  bw_rate,
        cprice:  co_rate,
        monthly: monthly_fee,
        qty:     0,
        install: '무료'
      });
    }
    groups.get(key).qty++;
  }

  // 시작일 내림차순 정렬 (renderContractItemsCard 와 동일)
  const rentalItems = [...groups.values()].sort((a, b) =>
    (b.start_date || '').localeCompare(a.start_date || '') ||
    (a.subtype    || '').localeCompare(b.subtype    || '', 'ko') ||
    (a.name       || '').localeCompare(b.name       || '', 'ko')
  );

  // 계약서 문서 날짜 = 출력일이 아닌 임대 시작일 기준 (자산 중 가장 이른 시작일)
  const leaseStart = assignments
    .map(a => (a.start_date || (a.rental_items || {}).install_date || '').slice(0, 10))
    .filter(Boolean)
    .sort()[0] || '';

  const token = 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const payload = {
    customer_id:  customer.id,
    contract_id:  null,          // 기존 계약서가 아닌 출력 전용 — DB 저장 시 신규 생성
    customer: {
      name:         customer.company         || '',
      trade_name:   customer.trade_name      || '',
      reg:          customer.biz_no          || '',
      ceo:          customer.ceo             || '',
      person:       customer.contact_name    || '',
      biz:          customer.biz_type        || '',
      item:         customer.biz_item        || '',
      addr:         customer.address         || '',
      install_addr: customer.install_address || '',
      tel:          customer.phone           || '',
      fax:          customer.fax             || '',
      mobile:       customer.mobile          || '',
      email:        customer.email           || ''
    },
    rentalItems,
    rentalInfo: {
      docDate:  leaseStart || undefined,             // 임대 시작일 (없으면 자식 페이지가 오늘로 fallback)
      rPeriod:  customer.period_years  || 3,
      rDeposit: customer.deposit       || 0,
      rBilling: customer.billing_type  || '전자세금계산서',
      // 거래처 내역의 발행구분(다중)·결제방법(다중) → 계약서 상단 표시용
      rBillingText: (Array.isArray(customer.billing_types) && customer.billing_types.length
                      ? customer.billing_types : [customer.billing_type])
                      .filter(Boolean).join(', '),
      rPayText: (Array.isArray(customer.payment_methods) ? customer.payment_methods : [])
                  .filter(Boolean).join(', '),
      rMobile:  customer.mobile        || ''
    }
  };

  try {
    localStorage.setItem('hbs_pending_contract_' + token, JSON.stringify(payload));
    setTimeout(() => { try { localStorage.removeItem('hbs_pending_contract_' + token); } catch (_) {} }, 120000);
  } catch (e) {
    console.error('payload 저장 실패:', e);
    toast('계약 데이터 전달 실패: ' + (e?.message || e), 'err');
    return;
  }

  const params = new URLSearchParams();
  params.set('token',       token);
  params.set('mode',        'print');           // 출력 전용 구분 플래그
  params.set('customer_id', customer.id);
  if (customer.company)          params.set('name',         customer.company);
  if (customer.trade_name)       params.set('trade_name',   customer.trade_name);
  if (customer.biz_no)           params.set('reg',          customer.biz_no);
  if (customer.ceo)              params.set('ceo',          customer.ceo);
  if (customer.contact_name)     params.set('person',       customer.contact_name);
  if (customer.biz_type)         params.set('biz',          customer.biz_type);
  if (customer.biz_item)         params.set('item',         customer.biz_item);
  if (customer.address)          params.set('addr',         customer.address);
  if (customer.install_address)  params.set('install_addr', customer.install_address);
  if (customer.phone)            params.set('tel',          customer.phone);
  if (customer.fax)              params.set('fax',          customer.fax);
  if (customer.mobile)           params.set('mobile',       customer.mobile);
  if (customer.email)            params.set('email',        customer.email);
  if (customer.billing_type)     params.set('billing',      customer.billing_type);
  if (customer.deposit)          params.set('deposit',      customer.deposit);
  if (customer.period_years)     params.set('period',       customer.period_years);

  window.open('./copy-rental-contract/index.html#' + params.toString(), '_blank');
}

// ─────────────────────────────────────────────────────────────
// 계약서 row 삭제 — rental_contracts.delete + UI 갱신
// (연결된 rental_assignments 는 보존 — 이력 유지)
// ─────────────────────────────────────────────────────────────
async function deleteContractRow(customer, ct) {
  if (!confirm(`이 계약서를 삭제할까요?\n\n계약번호: ${ct.contract_no || '-'}\n작성일: ${ct.contract_date || '-'}\n\n※ 이 계약으로 등록된 임대 물품 자산은 그대로 남습니다.\n   필요 시 "임대 물품 내역"에서 따로 삭제하세요.`)) return;
  const supa = window.totalasAuth;
  if (!supa) { toast('인증이 준비되지 않았습니다.', 'err'); return; }
  try {
    const { error } = await supa.from('rental_contracts').delete().eq('id', ct.id);
    if (error) throw error;
    await loadContractsFor(customer.id);
    renderDetail();
    toast('계약서가 삭제되었습니다.', 'ok');
  } catch (err) {
    console.error(err);
    toast('계약서 삭제 실패: ' + (err.message || err), 'err');
  }
}

// ─────────────────────────────────────────────────────────────
// 데이터 로드
// ─────────────────────────────────────────────────────────────
async function loadAll() {
  const supa = window.totalasAuth;
  const listEl = document.getElementById('rc-cust-list');
  listEl.innerHTML = `<div class="muted" style="text-align:center; padding:20px; font-size:12px;">로딩 중…</div>`;

  try {
    // 1. 거래처 + 할당(자산) JOIN — 활성/만기 모드에 따라 분기
    const wantActive = STATE.filters.mode !== 'archived';
    const { data: custs, error: cErr } = await supa
      .from('rental_customers')
      .select(`
        *,
        rental_assignments(
          id, item_id, start_date, end_date, monthly_fee,
          bw_free, co_free, bw_rate, co_rate, notes,
          rental_items(id, category, subtype, brand, model, asset_number, serial, install_date, status, storage_gb, notes, counter_mode, total_free_count, total_unit_price, rental_type)
        )
      `)
      .eq('active', wantActive)
      .range(0, 999);
    if (cErr) throw cErr;

    // 2. 카운터 데이터 (전체 — NAS 후보 판정용 월평균 계산)
    const { data: counters, error: ctrErr } = await supa
      .from('rental_counters')
      .select('item_id, ym, bw, color, uptime_hours')
      .range(0, 9999);
    if (ctrErr) throw ctrErr;

    STATE.countersByItem = {};
    (counters || []).forEach(c => {
      (STATE.countersByItem[c.item_id] = STATE.countersByItem[c.item_id] || []).push(c);
    });

    // 2.5 청구 그룹 마스터 (rental_billing_groups)
    try {
      const { data: groups, error: gErr } = await supa
        .from('rental_billing_groups')
        .select('*')
        .eq('active', true)
        .order('name');
      if (gErr) throw gErr;
      STATE.billingGroups = groups || [];
      STATE.groupById = {};
      STATE.billingGroups.forEach(g => { STATE.groupById[g.id] = g; });
    } catch (gErr) {
      // 그룹 테이블 미존재(스키마 미적용) 환경에서는 빈 배열로 진행 — 기존 동작 유지
      console.warn('billing_groups 로드 실패(무시):', gErr.message || gErr);
      STATE.billingGroups = []; STATE.groupById = {};
    }

    // 3. 가공: 각 거래처에 자산 카테고리/Cross-sell 점수 부여 + 그룹 매핑
    STATE.customers = (custs || []).map(c => {
      const enr = enrichCustomer(c);
      enr._group = c.billing_group_id ? (STATE.groupById[c.billing_group_id] || null) : null;
      return enr;
    });

    // 4. 리스트 렌더 (카테고리 통계는 임대현황에서 표시)
    renderList();
    // 거래처가 선택되지 않은 경우에만 '제품별 전체 보기' 즉시 표시
    // 선택 상태에서 저장/재로드 시 renderDetail()은 호출부에서 직접 호출
    if (!STATE.selectedId) renderDetail();
  } catch (err) {
    console.error(err);
    listEl.innerHTML = `<div class="rc-error" style="text-align:center; padding:20px;">조회 실패: ${escapeHtml(err.message || String(err))}</div>`;
  }
}

function enrichCustomer(c) {
  const assignments = (c.rental_assignments || []).filter(a => a.rental_items);
  // 종료된 계약 제외
  const active = assignments.filter(a => !a.end_date || new Date(a.end_date) >= new Date());

  // 보유 카테고리/소분류 집합
  const subtypes = new Set();
  const cats = new Set();
  active.forEach(a => {
    const st = a.rental_items.subtype || '';
    subtypes.add(st);
    cats.add(categoryOf(st));
  });

  const hasPC      = [...subtypes].some(s => /pc|컴퓨터|데스크탑|노트북/i.test(s));
  const hasMonitor = [...subtypes].some(s => /monitor|모니터/i.test(s));
  const hasOutput  = cats.has('출력');
  const hasWellis  = cats.has('위생');
  const hasNAS     = [...subtypes].some(s => /nas/i.test(s));
  const hasMFP     = [...subtypes].some(s => /복합기|mfp/i.test(s));

  // 기기 세분류 (출력기기는 흑백/컬러 분리 — assignment.co_rate>0 또는 co_free>0 이면 컬러)
  let hasBwMfp = false, hasColorMfp = false;
  let hasBwLaser = false, hasColorLaser = false;
  let hasInkjet = false;
  active.forEach(a => {
    const it = a.rental_items;
    const sub = (it.subtype || '').toLowerCase();
    const isColor = ((a.co_rate || 0) > 0) || ((a.co_free || 0) > 0);
    if (/복합기|mfp|복사/.test(sub)) {
      if (isColor) hasColorMfp = true; else hasBwMfp = true;
    } else if (/laser|레이저/.test(sub)) {
      if (isColor) hasColorLaser = true; else hasBwLaser = true;
    } else if (/inkjet|잉크젯/.test(sub)) {
      hasInkjet = true;
    }
  });

  // 월평균 출력량 (활성 자산의 카운터 합산 — 최근 6개월)
  const recentYm = recentMonths(6);
  let totalPages = 0;
  let monthsCovered = 0;
  active.forEach(a => {
    const ctrs = (STATE.countersByItem[a.item_id] || []).filter(x => recentYm.includes(x.ym));
    ctrs.forEach(x => {
      totalPages += (x.bw || 0) + (x.color || 0);
      monthsCovered++;
    });
  });
  const avgPagesPerMonth = monthsCovered > 0 ? totalPages / monthsCovered : 0;

  // Cross-sell 점수 (0~100): 제안 가능 항목이 많을수록 높음
  let score = 0;
  if (hasPC && !hasMonitor) score += 25;          // 모니터 제안
  if (hasOutput && !hasWellis) score += 20;        // 웰리스 제안
  if (!hasNAS && (avgPagesPerMonth >= 3000 || hasMFP)) score += 30; // NAS 제안
  if (cats.size <= 1 && active.length > 0) score += 15;            // 라인업 다양화
  if (active.length === 0) score = 0;

  const isNasCandidate = !hasNAS && (avgPagesPerMonth >= 3000 || hasMFP);

  return {
    ...c,
    _assignments: active,
    _allAssignments: assignments,
    _subtypes: subtypes,
    _cats: cats,
    _hasPC: hasPC,
    _hasMonitor: hasMonitor,
    _hasOutput: hasOutput,
    _hasWellis: hasWellis,
    _hasNAS: hasNAS,
    _hasMFP: hasMFP,
    _hasBwMfp: hasBwMfp,
    _hasColorMfp: hasColorMfp,
    _hasBwLaser: hasBwLaser,
    _hasColorLaser: hasColorLaser,
    _hasInkjet: hasInkjet,
    _avgPages: avgPagesPerMonth,
    _score: score,
    _isNasCandidate: isNasCandidate,
  };
}

function recentMonths(n) {
  const out = [];
  const now = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 좌측 거래처 리스트
// ─────────────────────────────────────────────────────────────
function renderList() {
  const listEl = document.getElementById('rc-cust-list');
  const { q, sort } = STATE.filters;

  let arr = STATE.customers.slice();
  if (q) {
    const lq = q.toLowerCase();
    arr = arr.filter(c => {
      if ((c.company    || '').toLowerCase().includes(lq)) return true;
      if ((c.trade_name || '').toLowerCase().includes(lq)) return true;
      // 보유 자산의 브랜드/모델 매칭 (활성 자산 기준)
      return (c._assignments || []).some(a => {
        const it = a.rental_items || {};
        return (it.brand || '').toLowerCase().includes(lq)
            || (it.model || '').toLowerCase().includes(lq);
      });
    });
  }

  arr.sort((a, b) => {
    switch (sort) {
      case 'recent': return new Date(b.created_at || 0) - new Date(a.created_at || 0);
      case 'assets': return b._assignments.length - a._assignments.length;
      case 'score':  return b._score - a._score;
      case 'name':
      default: {
        // 거래처상호(trade_name) 우선, 없으면 사업자상호(company) 로 fallback
        const aName = (a.trade_name || a.company || '');
        const bName = (b.trade_name || b.company || '');
        return aName.localeCompare(bName, 'ko');
      }
    }
  });

  if (!arr.length) {
    listEl.innerHTML = `<div class="muted" style="text-align:center; padding:20px; font-size:12px;">결과 없음</div>`;
    return;
  }

  const archived = STATE.filters.mode === 'archived';

  // 거래처 1개 카드 HTML 생성 헬퍼 (그룹/단독 공통 사용)
  const renderCustomerCard = (c) => {
    const tags = [];
    if (archived) {
      const ad = c.archived_at ? String(c.archived_at).slice(0, 10) : '';
      tags.push(`<span class="rc-tag" style="background:#fee2e2;color:#991b1b;">만기${ad ? ' ' + ad : ''}</span>`);
    } else {
      if (c._score >= 50) tags.push(`<span class="rc-tag score-hot">🔥 ${c._score}</span>`);
      else if (c._score >= 25) tags.push(`<span class="rc-tag score-mid">${c._score}</span>`);
      else if (c._score > 0) tags.push(`<span class="rc-tag score-low">${c._score}</span>`);
      // 그룹 묶여 있지만 이 사업장만 따로 발행되는 경우 → 표시
      if (c._group && c._group.bill_combined !== false && c.billing_individual) {
        tags.push(`<span class="rc-bg-badge rc-bg-split">📑 단독</span>`);
      }
    }
    const actions = archived
      ? `<button class="rc-item-action" data-action="edit" title="수정">✏</button>
         <button class="rc-item-action" data-action="restore" title="활성으로 복원">🔄</button>`
      : `<button class="rc-item-action" data-action="edit" title="수정">✏</button>
         <button class="rc-item-action" data-action="archive" title="만기 처리(보관)">🗑</button>`;
    const listName = (c.trade_name || c.company || '').split('\n')[0];
    const listBizName = c.trade_name && c.trade_name !== c.company
      ? `<span style="font-size:11px;color:var(--muted);font-weight:400;"> · ${escapeHtml((c.company || '').split('\n')[0])}</span>`
      : '';
    const listAddr = (c.install_address || c.address || '').slice(0, 24);
    const indentCls = c._group ? ' rc-cust-item-grouped' : '';
    // 품목별 건수 — rental_items.subtype 별로 카운트, ITEM_TYPES sort_order 기준 정렬
    const byType = new Map();
    c._assignments.forEach(a => {
      const st = (a.rental_items?.subtype || '').trim();
      if (!st) return;
      byType.set(st, (byType.get(st) || 0) + 1);
    });
    const orderIdx = new Map(ITEM_TYPES.map((t, i) => [t.label || t.id, i]));
    const itemsLine = [...byType.entries()]
      .sort((a, b) => {
        const ia = orderIdx.has(a[0]) ? orderIdx.get(a[0]) : 999;
        const ib = orderIdx.has(b[0]) ? orderIdx.get(b[0]) : 999;
        return ia - ib;
      })
      .map(([label, n]) => `<span class="rc-cust-item-chip">${escapeHtml(label)} ${n}</span>`)
      .join('');
    // 품목 칩 + 점수/만기 태그를 같은 줄(3째 줄)에 이어붙임. 칩이 많으면 wrap.
    const itemsBody = itemsLine
      ? itemsLine
      : `<span style="color:#9ca3af;">자산 없음</span>`;
    const itemsHtml = `<div class="rc-cust-items">${itemsBody}${tags.join('')}</div>`;
    return `
      <div class="rc-cust-item${indentCls} ${STATE.selectedId === c.id ? 'active' : ''} ${archived ? 'archived' : ''}" data-id="${escapeAttr(c.id)}">
        <div class="rc-cust-actions">${actions}</div>
        <div class="rc-cust-name">${escapeHtml(listName)}${listBizName}</div>
        <div class="rc-cust-sub">${escapeHtml(listAddr)}</div>
        ${itemsHtml}
      </div>`;
  };

  // 그룹별 묶음 + 단독 거래처 섹션 — 정렬은 그룹 내에서 유지
  const groupBuckets = new Map();   // groupId -> [customers]
  const solo = [];
  arr.forEach(c => {
    if (c._group && c._group.id) {
      const arr2 = groupBuckets.get(c._group.id) || [];
      arr2.push(c);
      groupBuckets.set(c._group.id, arr2);
    } else {
      solo.push(c);
    }
  });

  // 그룹 헤더 정렬 키 = 그룹명
  const groupIds = [...groupBuckets.keys()].sort((a, b) => {
    const ga = STATE.groupById[a]?.name || '';
    const gb = STATE.groupById[b]?.name || '';
    return ga.localeCompare(gb, 'ko');
  });

  // 선택된 거래처가 속한 그룹은 자동 펼침(보임 유지). 검색어가 있을 때도 모든 그룹 펼침(매칭 결과 가시화).
  const _selCust  = STATE.selectedId ? STATE.customers.find(x => x.id === STATE.selectedId) : null;
  const _selGid   = _selCust?._group?.id || null;
  const _expandAll = !!q;

  const _prevScrollTop = listEl.scrollTop;
  const groupsHtml = groupIds.map(gid => {
    const g = STATE.groupById[gid];
    const list = groupBuckets.get(gid) || [];
    const totalAssets = list.reduce((s, c) => s + c._assignments.length, 0);
    // 기본 접힘: STATE.collapsedGroups[gid] === false 일 때만 펼침
    // 선택된 거래처 그룹 / 검색 모드는 강제 펼침
    const collapsed = (gid === _selGid || _expandAll)
      ? false
      : (STATE.collapsedGroups[gid] !== false);

    // 자식 카드: 그룹이 '통합'이면 [합산 사업장 묶음] + [단독 사업장 묶음] 미니헤더로 분리.
    //   - 합산이 있으면 '📄 통합 합산 (N곳, 1장)' 박스
    //   - 단독이 있으면 '📑 단독 발행 (M곳, M장)' 박스
    // 그룹 자체가 '사업장별 분리(bill_combined=false)' 이면 미니헤더 없이 평면 나열.
    let childHtml = '';
    if (!collapsed) {
      const isCombinedMode = g?.bill_combined !== false;
      if (isCombinedMode) {
        const combinedList = list.filter(c => !c.billing_individual);
        const individualList = list.filter(c => c.billing_individual);
        const parts = [];
        if (combinedList.length) {
          parts.push(`<div class="rc-group-subheader rc-sub-combined">📄 통합 합산 <span class="rc-sub-meta">${combinedList.length}곳 → 1장</span></div>`);
          parts.push(combinedList.map(renderCustomerCard).join(''));
        }
        if (individualList.length) {
          parts.push(`<div class="rc-group-subheader rc-sub-split">📑 단독 발행 <span class="rc-sub-meta">${individualList.length}곳 → ${individualList.length}장</span></div>`);
          parts.push(individualList.map(renderCustomerCard).join(''));
        }
        childHtml = parts.join('');
      } else {
        childHtml = list.map(renderCustomerCard).join('');
      }
    }
    // 발행방식 배지: 그룹 옵션 + 사업장별 개별 발행 반영해서 총 장수 계산
    //   - 그룹 bill_combined=false  → 모든 사업장 따로 (N장)
    //   - 그룹 bill_combined=true   → 단독발행 사업장 K + (나머지 N-K 가 1장으로 합산) → 단독K + 합산있으면 1
    let billBadge;
    if (g?.bill_combined === false) {
      billBadge = `<span class="rc-bg-badge rc-bg-split" title="사업장별 ${list.length}장 발행">📑 ${list.length}장</span>`;
    } else {
      const indivCount = list.filter(c => c.billing_individual).length;
      const groupedCount = list.length - indivCount;
      if (indivCount === 0) {
        billBadge = `<span class="rc-bg-badge rc-bg-combined" title="그룹 통합 1장 발행">📄 통합 1장</span>`;
      } else if (groupedCount === 0) {
        // 통합 모드인데 모든 사업장이 단독 발행 — 실질적으로 분리와 같음
        billBadge = `<span class="rc-bg-badge rc-bg-split" title="사업장별 ${list.length}장 발행 (모두 단독)">📑 ${list.length}장</span>`;
      } else {
        const total = 1 + indivCount; // 통합 1 + 단독 N
        billBadge = `<span class="rc-bg-badge rc-bg-mixed" title="통합 1장 + 단독 ${indivCount}장 = ${total}장">📄+📑 ${total}장</span>`;
      }
    }
    return `
      <div class="rc-group-block" data-gid="${escapeAttr(gid)}">
        <div class="rc-group-header" data-toggle-gid="${escapeAttr(gid)}" title="클릭하면 접기/펼침">
          <span class="rc-group-arrow">${collapsed ? '▶' : '▼'}</span>
          <span class="rc-group-name">🏢 ${escapeHtml(g?.name || '(이름없음)')}</span>
          <span class="rc-group-meta">${list.length}곳 · 자산 ${totalAssets}</span>
          ${billBadge}
        </div>
        ${childHtml}
      </div>`;
  }).join('');

  const soloHtml = solo.length
    ? `<div class="rc-group-block rc-group-solo">
         <div class="rc-group-header rc-group-header-solo">
           <span class="rc-group-name">📌 단독 거래처</span>
           <span class="rc-group-meta">${solo.length}곳</span>
         </div>
         ${solo.map(renderCustomerCard).join('')}
       </div>`
    : '';

  listEl.innerHTML = groupsHtml + soloHtml;

  // 그룹 헤더 토글 (접기/펼침)
  listEl.querySelectorAll('[data-toggle-gid]').forEach(hdr => {
    hdr.addEventListener('click', () => {
      const gid = hdr.dataset.toggleGid;
      STATE.collapsedGroups[gid] = !STATE.collapsedGroups[gid];
      renderList();
    });
  });

  listEl.querySelectorAll('.rc-cust-item').forEach(el => {
    // 액션 버튼 클릭 — 상위 선택 이벤트 방지
    el.querySelectorAll('.rc-item-action').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const cid = el.dataset.id;
        const action = btn.dataset.action;
        const cust = STATE.customers.find(x => x.id === cid);
        if (!cust) return;
        if (action === 'edit') openForm(cust);
        else if (action === 'archive') archiveCustomer(cust);
        else if (action === 'restore') restoreCustomer(cust);
      });
    });

    el.addEventListener('click', () => {
      STATE.selectedId = el.dataset.id;
      // 선택한 사업장의 그룹은 펼침 상태 유지 (사용자가 명시적으로 접지 않는 한)
      const _c = STATE.customers.find(x => x.id === STATE.selectedId);
      if (_c && _c._group && _c._group.id) {
        STATE.collapsedGroups[_c._group.id] = false;
      }
      renderList();
      renderDetail();
      // 모바일: 상세 화면으로 전환
      _mobileOpenDetail();
      // 변경이력 비동기 프리로드 후 자산 카드 갱신 (이력 있으면 인라인 표시)
      const _selC = STATE.customers.find(x => x.id === STATE.selectedId);
      if (_selC) {
        loadRateHistoryForCustomer(_selC).then(() => {
          if (STATE.selectedId === _selC.id) renderDetail();
        });
      }
    });
  });

  // 스크롤 위치 복원 (innerHTML 재할당으로 초기화되는 것을 방지)
  listEl.scrollTop = _prevScrollTop;
}

// 만기 처리 (active=false, archived_at, archived_reason 기록)
async function archiveCustomer(c) {
  const name = (c.company || '').split('\n')[0];
  if (!confirm(`'${name}' 거래처를 만기 처리합니다.\n\n만기 거래처 목록으로 이동되며 데이터는 보존됩니다.\n진행할까요?`)) return;
  try {
    const supa = window.totalasAuth;
    const { error } = await supa.from('rental_customers').update({
      active: false,
      archived_at: new Date().toISOString(),
      archived_reason: '임대 만기',
    }).eq('id', c.id);
    if (error) throw error;
    toast('만기 처리 완료', 'ok');
    if (STATE.selectedId === c.id) STATE.selectedId = null;
    await loadAll();
    renderDetail();
  } catch (err) {
    console.error(err);
    toast('만기 처리 실패: ' + (err.message || err), 'err');
  }
}

// 만기 → 활성 복원
async function restoreCustomer(c) {
  const name = (c.company || '').split('\n')[0];
  if (!confirm(`'${name}' 거래처를 활성으로 복원할까요?`)) return;
  try {
    const supa = window.totalasAuth;
    const { error } = await supa.from('rental_customers').update({
      active: true,
      archived_at: null,
      archived_reason: null,
    }).eq('id', c.id);
    if (error) throw error;
    toast('활성으로 복원되었습니다.', 'ok');
    if (STATE.selectedId === c.id) STATE.selectedId = null;
    await loadAll();
    renderDetail();
  } catch (err) {
    console.error(err);
    toast('복원 실패: ' + (err.message || err), 'err');
  }
}

// ─────────────────────────────────────────────────────────────
// 우측 상세 패널 — 거래처 미선택 시 "품목별 전체 보기"
// 1단계: 품목(subtype) 섹션 — 클릭으로 펼침/접힘
// 2단계: 섹션 내 제품(브랜드+모델) 카드 — 클릭으로 보유 거래처 펼침
// ─────────────────────────────────────────────────────────────
function renderAllCustomersOverview(detail) {
  const archived = STATE.filters.mode === 'archived';
  const arr = STATE.customers.slice();
  if (!arr.length) {
    detail.innerHTML = archived
      ? `<div class="card rc-detail-empty"><p style="font-size:14px; margin:0;">만기 처리된 거래처가 없습니다.</p><p class="muted" style="font-size:12px; margin-top:8px;">활성 거래처 목록의 🗑 아이콘으로 만기 처리할 수 있습니다.</p></div>`
      : `<div class="card rc-detail-empty"><p style="font-size:14px; margin:0;">등록된 거래처가 없습니다.</p></div>`;
    return;
  }

  // 1) 자산을 품목(subtype) → 제품(브랜드+모델) 2단계로 그룹화
  //    pc/PC/컴퓨터, monitor/모니터 등 동의어는 normalizeSubtype 으로 같은 그룹으로 묶음
  // subtypeGroups: Map<subtype, { cat, totalCount, modelGroups: Map<key, {brand,model,totalCount,customers}> }>
  const subtypeGroups = new Map();
  for (const c of arr) {
    for (const a of (c._assignments || [])) {
      const it      = a.rental_items || {};
      const rawSub  = (it.subtype || '').trim();
      const subtype = normalizeSubtype(rawSub) || '기타';
      const cat     = categoryOf(subtype);
      const brand   = (it.brand || '').trim();
      const model   = (it.model || '').trim() || '(모델 미상)';
      const mkey    = brand + '||' + model;

      let sg = subtypeGroups.get(subtype);
      if (!sg) {
        sg = { subtype, cat, totalCount: 0, modelGroups: new Map() };
        subtypeGroups.set(subtype, sg);
      }
      sg.totalCount++;

      let mg = sg.modelGroups.get(mkey);
      if (!mg) {
        mg = { key: mkey, brand, model, totalCount: 0, customers: new Map() };
        sg.modelGroups.set(mkey, mg);
      }
      mg.totalCount++;
      const cur = mg.customers.get(c.id) || { customer: c, count: 0 };
      cur.count++;
      mg.customers.set(c.id, cur);
    }
  }

  // 통계
  let totalAssets  = 0;
  let totalModels  = 0;
  subtypeGroups.forEach(sg => {
    totalAssets += sg.totalCount;
    totalModels += sg.modelGroups.size;
  });
  const totalCustomers = arr.length;

  if (!subtypeGroups.size) {
    detail.innerHTML = `<div class="card rc-detail-empty"><p style="font-size:14px;margin:0;">${archived ? '만기 거래처에' : ''} 등록된 자산이 없습니다.</p></div>`;
    return;
  }

  // 2) 품목 정렬 순서 — 마스터의 sort_order 기준 (호환성 위해 흑백복합기/컬러복합기 도 포함)
  const subtypeOrderArr = [];
  for (const t of (ITEM_TYPES || [])) {
    subtypeOrderArr.push(t.label);
    if (t.label === '흑백복사기') subtypeOrderArr.push('흑백복합기');
    if (t.label === '컬러복사기') subtypeOrderArr.push('컬러복합기');
  }
  subtypeOrderArr.push('기타');
  const SUBTYPE_ORDER = subtypeOrderArr;
  const subtypeArr = Array.from(subtypeGroups.values()).sort((a, b) => {
    const ai = SUBTYPE_ORDER.indexOf(a.subtype);
    const bi = SUBTYPE_ORDER.indexOf(b.subtype);
    if (ai !== bi) return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    return b.totalCount - a.totalCount;
  });

  // 품목별 아이콘 매핑 — 마스터에서 동적 생성
  const SUBTYPE_ICON = { '기타': '📎', '흑백복합기': '🖨', '컬러복합기': '🖨' };
  for (const t of (ITEM_TYPES || [])) SUBTYPE_ICON[t.label] = t.icon || '📎';

  // 3) 섹션 + 제품 카드 렌더
  const sectionsHtml = subtypeArr.map((sg, sIdx) => {
    const icon = SUBTYPE_ICON[sg.subtype] || '📎';

    // 제품(모델) 카드 정렬: 대수 내림차순 → 브랜드+모델명
    const modelArr = Array.from(sg.modelGroups.values()).sort((a, b) =>
      b.totalCount - a.totalCount || (a.brand + a.model).localeCompare(b.brand + b.model, 'ko')
    );

    const cardsHtml = modelArr.map(mg => {
      const custCount = mg.customers.size;
      const custList  = Array.from(mg.customers.values())
        .sort((x, y) => y.count - x.count || (x.customer.company || '').localeCompare(y.customer.company || '', 'ko'))
        .map(({ customer, count }) => {
          const dn = (customer.trade_name || customer.company || '').split('\n')[0] || '(이름 없음)';
          return `<li><button type="button" class="rc-ov-cust" data-id="${escapeAttr(customer.id)}">
            ${escapeHtml(dn)} <span class="rc-ov-cust-cnt">${count}대</span>
          </button></li>`;
        }).join('');
      const brandModel = [mg.brand, mg.model].filter(Boolean).join(' ') || mg.model;
      return `
        <div class="rc-ov-card rc-ov-product" data-key="${escapeAttr(mg.key)}" title="클릭하면 보유 거래처 펼침">
          <div class="name">${escapeHtml(brandModel)}</div>
          <div class="meta">
            <span class="badge">${mg.totalCount}대</span>
            <span class="badge">${custCount}개 거래처</span>
            <span class="rc-ov-chevron">▼</span>
          </div>
          <ul class="rc-ov-cust-list">${custList}</ul>
        </div>`;
    }).join('');

    // 모든 품목 섹션은 기본 접힘 — 사용자가 화살표(헤더)를 클릭해야 펼쳐짐
    return `
      <div class="rc-ov-section" data-subtype="${escapeAttr(sg.subtype)}" data-cat="${escapeAttr(sg.cat)}">
        <div class="rc-ov-section-head">
          <span class="rc-ov-section-icon">${icon}</span>
          <span class="rc-ov-section-title">${escapeHtml(sg.subtype)}</span>
          <div class="rc-ov-section-badges">
            <span class="badge" style="background:#f1f5f9;color:#475569;padding:1px 8px;border-radius:999px;font-size:11px;">${sg.totalCount}대</span>
            <span class="badge" style="background:#f1f5f9;color:#475569;padding:1px 8px;border-radius:999px;font-size:11px;">${sg.modelGroups.size}모델</span>
          </div>
          <span class="rc-ov-section-chevron">▼</span>
        </div>
        <div class="rc-ov-section-body">
          <div class="rc-ov-section-inner">
            <div class="rc-overview-grid">${cardsHtml}</div>
          </div>
        </div>
      </div>`;
  }).join('');

  detail.innerHTML = `
    <div class="card" style="padding:14px;">
      <div class="rc-overview-head">
        <h2>${archived ? '만기 거래처 — 품목별' : '품목별 전체 보기'}</h2>
        <div class="sub">
          품목 ${subtypeArr.length}종 · 모델 ${totalModels}종 · 자산 ${totalAssets}건 · 거래처 ${totalCustomers}개
          <span class="muted" style="margin-left:6px;">(품목 클릭 → 제품 목록 펼침 / 제품 클릭 → 거래처 펼침 / 거래처명 클릭 → 상세 보기)</span>
        </div>
      </div>
      <div class="rc-ov-sections" style="margin-top:10px;">${sectionsHtml}</div>
    </div>`;

  // 품목 섹션 헤더 클릭 → 펼침/접힘 토글
  detail.querySelectorAll('.rc-ov-section-head').forEach(head => {
    head.addEventListener('click', () => {
      head.closest('.rc-ov-section').classList.toggle('open');
    });
  });

  // 제품 카드 클릭 → 거래처 펼침/접힘 토글
  detail.querySelectorAll('.rc-ov-product').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.rc-ov-cust')) return;
      card.classList.toggle('expanded');
    });
  });

  // 거래처명 클릭 → 해당 거래처 상세 진입 + 좌측 active 스크롤
  detail.querySelectorAll('.rc-ov-cust').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      STATE.selectedId = btn.dataset.id;
      renderList();
      renderDetail();
      requestAnimationFrame(() => {
        const activeEl = document.querySelector('.rc-cust-item.active');
        if (activeEl) activeEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });
  });
}

// ─────────────────────────────────────────────────────────────
// 모바일 풀스크린 전환 헬퍼
// ─────────────────────────────────────────────────────────────
function _isMobile() {
  return window.innerWidth <= 768;
}

function _mobileOpenDetail() {
  if (!_isMobile()) return;
  const layout = document.querySelector('.rc-layout');
  if (layout) layout.classList.add('detail-open');
}

function _mobileCloseDetail() {
  const layout = document.querySelector('.rc-layout');
  if (layout) layout.classList.remove('detail-open');
  STATE.selectedId = null;
  renderList();
  renderDetail();
}

function _renderMobileBackBtn() {
  if (!_isMobile() || !STATE.selectedId) return '';
  return `<button class="rc-mobile-back" id="rc-mobile-back-btn">&#8592; 거래처 목록으로</button>`;
}

function _bindMobileBackBtn(container) {
  const btn = (container || document).querySelector('#rc-mobile-back-btn');
  if (!btn) return;
  btn.addEventListener('click', () => _mobileCloseDetail());
}

// 선택된 거래처의 모든 자산 이력을 미리 로드하여 STATE.rateHistoryByItem 에 캐싱
async function loadRateHistoryForCustomer(customer) {
  const supa = window.totalasAuth;
  if (!supa || !customer) return;
  const itemIds = (customer._assignments || []).map(a => a.rental_items && a.rental_items.id).filter(Boolean);
  if (!itemIds.length) return;
  try {
    const { data, error } = await supa
      .from('rental_item_rate_history')
      .select('id, item_id, effective_date, bw_free, co_free, bw_rate, co_rate, total_free_count, total_unit_price, note')
      .in('item_id', itemIds)
      .order('effective_date', { ascending: true });
    if (error) throw error;
    // item_id 별로 그룹화
    const byItem = {};
    for (const h of (data || [])) {
      if (!byItem[h.item_id]) byItem[h.item_id] = [];
      byItem[h.item_id].push(h);
    }
    // 기존 캐시에 병합
    Object.assign(STATE.rateHistoryByItem, byItem);
  } catch (err) {
    console.warn('[customers] 이력 프리로드 실패:', err.message || err);
  }
}

// 📁 청구 정보 카드 — 거래처에 그룹이 연결된 경우만 표시.
// 그룹의 청구 관련 마스터 정보(사업자번호/대표/세금계산서/CMS) + 같은 그룹의 다른 사업장 링크.
// 단독 거래처는 기존 청구 필드를 거래처 자체에 보관 — 별도 카드 없이 모달에서 편집.
function renderBillingInfoCard(c) {
  const g = c._group;
  if (!g) return '';
  const sameGroup = STATE.customers.filter(x => x._group && x._group.id === g.id && x.id !== c.id);
  const sameGroupLinks = sameGroup.map(x => {
    const nm = (x.trade_name || x.company || '').split('\n')[0];
    return `<a href="#" data-rc-goto="${escapeAttr(x.id)}" style="color:#1e40af;text-decoration:underline;font-size:11.5px;margin-right:10px;">▸ ${escapeHtml(nm)}</a>`;
  }).join('');

  // 그룹 편집 모달과 동일 항목 노출: 그룹명/사업자번호/대표/팩스/업태/종목/발행구분(다중)/결제방법(다중)/청구일/그룹발행/메모
  const bts = Array.isArray(g.billing_types) && g.billing_types.length
    ? g.billing_types
    : (g.billing_type ? [g.billing_type] : []);
  const pms = Array.isArray(g.payment_methods) ? g.payment_methods : [];
  const bizTypeItem = [g.biz_type, g.biz_item].filter(Boolean).join(' / ');

  return `
    <div class="card" style="background:#f8fafc;border-left:3px solid #1e40af;">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:8px;">
        <h3 style="margin:0;">📁 청구 정보 <span class="muted-small" style="font-weight:400;">(${escapeHtml(g.name)} 그룹 공통)</span></h3>
        <button class="btn small" data-rc-act="edit-group" data-gid="${escapeAttr(g.id)}" style="font-size:11px;">⚙ 그룹 편집</button>
      </div>
      <table style="width:100%;font-size:12px;border-collapse:collapse;">
        <tr><td class="muted-small" style="width:30%;padding:3px 0;">그룹명</td><td>${escapeHtml(g.name || '-')}</td></tr>
        <tr><td class="muted-small" style="padding:3px 0;">사업자번호</td><td>${escapeHtml(g.biz_no || '-')}</td></tr>
        <tr><td class="muted-small" style="padding:3px 0;">대표자</td><td>${escapeHtml(g.ceo || '-')}</td></tr>
        <tr><td class="muted-small" style="padding:3px 0;">팩스</td><td>${escapeHtml(g.fax || '-')}</td></tr>
        <tr><td class="muted-small" style="padding:3px 0;">업태/종목</td><td>${escapeHtml(bizTypeItem || '-')}</td></tr>
        <tr><td class="muted-small" style="padding:3px 0;">발행 구분</td><td>${bts.length ? bts.map(v => `<span class="rc-tag" style="margin-right:4px;">${escapeHtml(v)}</span>`).join('') : '-'}</td></tr>
        <tr><td class="muted-small" style="padding:3px 0;">결제방법</td><td>${pms.length ? pms.map(v => `<span class="rc-tag" style="margin-right:4px;">${escapeHtml(v)}</span>`).join('') : '-'}</td></tr>
        <tr><td class="muted-small" style="padding:3px 0;">청구일</td><td>${g.invoice_day ? escapeHtml(g.invoice_day) + '일' : '-'}</td></tr>
        <tr><td class="muted-small" style="padding:3px 0;">그룹 발행</td><td>${g.bill_combined === false
          ? '<span class="rc-bg-badge rc-bg-split">📑 사업장별 따로</span> <span class="muted-small" style="font-size:11px;">(각 사업장마다 1장씩)</span>'
          : '<span class="rc-bg-badge rc-bg-combined">📄 그룹 통합 1장</span> <span class="muted-small" style="font-size:11px;">(그룹 전체 합산 1장)</span>'}</td></tr>
        ${g.bill_combined !== false ? `
        <tr><td class="muted-small" style="padding:3px 0;">이 사업장</td><td>${c.billing_individual
          ? '<span class="rc-bg-badge rc-bg-split">📑 단독 발행</span> <span class="muted-small" style="font-size:11px;">(그룹과 별도로 1장 발행)</span>'
          : '<span class="rc-bg-badge rc-bg-combined">📄 그룹 합산</span> <span class="muted-small" style="font-size:11px;">(그룹 통합 청구에 포함)</span>'}</td></tr>
        ` : ''}
        ${g.notes ? `<tr><td class="muted-small" style="padding:3px 0;vertical-align:top;">메모</td><td style="white-space:pre-wrap;">${escapeHtml(g.notes)}</td></tr>` : ''}
      </table>
      ${sameGroup.length ? `
        <div style="margin-top:10px;padding-top:8px;border-top:1px dashed #cbd5e1;">
          <div style="font-size:11.5px;font-weight:600;color:#1e3a8a;margin-bottom:4px;">같은 그룹의 다른 사업장 (${sameGroup.length}곳)</div>
          ${sameGroupLinks}
        </div>
      ` : '<div style="margin-top:8px;font-size:11px;color:var(--muted);">이 그룹에는 사업장이 1곳뿐입니다.</div>'}
    </div>
  `;
}

function renderDetail() {
  const detail = document.getElementById('rc-detail');
  const c = STATE.customers.find(x => x.id === STATE.selectedId);
  if (!c) {
    // 모바일: 상세가 닫히면 layout 클래스도 제거
    const layout = document.querySelector('.rc-layout');
    if (layout) layout.classList.remove('detail-open');
    renderAllCustomersOverview(detail);
    return;
  }

  // 거래처 표시명: 거래처상호(trade_name) 우선, 없으면 사업자상호(company)
  const displayName = (c.trade_name || c.company || '').split('\n')[0];
  const bizName     = (c.company || '').split('\n')[0];
  const nameHtml = c.trade_name && c.trade_name !== c.company
    ? `${escapeHtml(displayName)} <span style="font-size:11.5px;font-weight:400;color:var(--muted);">(${escapeHtml(bizName)})</span>`
    : escapeHtml(displayName);

  // 설치주소: 있으면 우선, 없으면 사업자주소
  const showAddr = c.install_address || c.address || '-';
  const addrLabel = c.install_address ? '설치주소' : '사업자주소';

  // 1) 기본 정보 카드 — 숨김 처리 (수정/삭제 버튼은 assetCard 헤더로 이동)
  const infoCard = `<!-- infoCard hidden -->`;

  // 2) Cross-sell 인사이트
  const insights = buildInsights(c);
  const insightCard = `
    <div class="card">
      <h3>💡 Cross-sell 인사이트 <span class="muted-small" style="font-weight:400;">(점수 ${c._score}/100)</span></h3>
      ${insights.length
        ? insights.map(i => `
            <div class="rc-insight ${i.level}">
              <div class="rc-insight-title">${i.icon} ${escapeHtml(i.title)}</div>
              <div class="rc-insight-body">${escapeHtml(i.body)}</div>
            </div>
          `).join('')
        : '<p class="muted" style="margin:0; font-size:12.5px;">현재 추가 제안할 항목이 없습니다.</p>'
      }
    </div>
  `;

  // 3) 보유 자산 표 (카테고리별 정렬)
  const sorted = c._assignments.slice().sort((a, b) => {
    const ca = categoryOf(a.rental_items.subtype);
    const cb = categoryOf(b.rental_items.subtype);
    if (ca !== cb) return ca.localeCompare(cb, 'ko');
    return (a.rental_items.subtype || '').localeCompare(b.rental_items.subtype || '', 'ko');
  });

  const assetCard = `
    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:8px;">
        <h3 style="margin:0;">${escapeHtml(displayName)} - 임대 물품 내역 <span class="muted-small" style="font-weight:400;">${sorted.length}건</span></h3>
        <div style="display:flex; gap:6px; align-items:center;">
          <button class="btn small" id="btn-edit" title="거래처 기본 정보 수정" style="font-size:11.5px;">✏ 거래처 수정</button>
          <button class="btn small danger" id="btn-delete" title="거래처 삭제" style="font-size:11.5px;">🗑 삭제</button>
          <button class="btn small primary" id="btn-asset-add">+ 임대추가</button>
        </div>
      </div>
      ${sorted.length ? `
        <div style="overflow-x:auto;">
          <table class="rc-asset-table">
            <thead>
              <tr>
                <th>분류</th><th>품목</th><th>모델</th><th>🏷자산번호</th><th>시리얼</th>
                <th>설치일</th><th>월 임대료</th><th>임대유형</th><th>상태</th><th class="act">관리</th>
              </tr>
            </thead>
            <tbody>
              ${sorted.map(a => {
                const it = a.rental_items;
                const cat = categoryOf(it.subtype);
                const memoHtml = it.notes
                  ? `<div style="font-size:11px;color:var(--muted);margin-top:2px;">📝 ${escapeHtml(it.notes)}</div>`
                  : '';
                // 변경이력 요약 (최근 3건, 캐시에 있을 때만)
                const rhItems = (STATE.rateHistoryByItem[it.id] || []);
                const rhRecent = rhItems.slice(-3).reverse();
                const rhHtml = rhRecent.length ? `
                  <div class="rc-rh-inline" style="margin-top:3px;">
                    ${rhRecent.map((h, idx) => {
                      const isLatest = idx === 0;
                      const vals = h.total_unit_price != null || h.total_free_count != null
                        ? [h.total_free_count != null ? `무료${h.total_free_count}장` : null,
                           h.total_unit_price != null ? `${Number(h.total_unit_price).toLocaleString()}원` : null]
                            .filter(Boolean).join(' / ')
                        : [h.bw_free != null ? `BW${h.bw_free}` : null,
                           h.bw_rate != null ? `${Number(h.bw_rate).toLocaleString()}원` : null]
                            .filter(Boolean).join(' / ');
                      return `<span style="font-size:10px;${isLatest ? 'color:#16a34a;font-weight:600;' : 'color:var(--muted);'}">
                        ${h.effective_date.slice(0, 7)} ${vals}${isLatest ? ' ★' : ''}</span>`;
                    }).join('<br>')}
                    <button type="button" class="rc-rh-all-btn" data-aid="${escapeAttr(a.id)}"
                      style="font-size:10px;background:none;border:none;color:#6366f1;cursor:pointer;padding:0;margin-top:1px;display:block;">
                      전체 이력</button>
                  </div>` : '';
                return `<tr>
                  <td data-label="분류"><span class="rc-cat-pill rc-cat-${cat}">${cat}</span></td>
                  <td data-label="품목">${escapeHtml(it.subtype || '-')}</td>
                  <td data-label="모델">${escapeHtml(((it.brand || '') + ' ' + (it.model || '')).trim() || '-')}${memoHtml}${rhHtml}</td>
                  <td data-label="자산번호" style="font-weight:600;${it.asset_number && it.asset_number.length >= 2 ? 'color:#0369a1;' : 'color:#9ca3af;'}">${escapeHtml(it.asset_number || '–')}</td>
                  <td data-label="시리얼" class="muted-small">${escapeHtml(it.serial || '-')}</td>
                  <td data-label="설치일" class="muted-small">${escapeHtml((it.install_date || '').slice(0, 10))}</td>
                  <td data-label="월임대료" style="text-align:right;">${a.monthly_fee ? Number(a.monthly_fee).toLocaleString() : '-'}</td>
                  <td data-label="임대유형" style="text-align:center;">${it.rental_type === 'free'
                    ? '<span style="font-size:11px;background:#dcfce7;color:#15803d;border-radius:10px;padding:2px 8px;font-weight:600;white-space:nowrap;">무상</span>'
                    : '<span style="font-size:11px;background:#e0f2fe;color:#0369a1;border-radius:10px;padding:2px 8px;font-weight:600;white-space:nowrap;">유상</span>'
                  }</td>
                  <td data-label="상태">${escapeHtml(it.status || '-')}</td>
                  <td class="act">
                    <button class="rc-icon-btn" title="수정" data-act="edit" data-aid="${escapeAttr(a.id)}">✏</button>
                    <button class="rc-icon-btn danger" title="삭제" data-act="del" data-aid="${escapeAttr(a.id)}">🗑</button>
                  </td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      ` : `<p class="muted" style="margin:0; font-size:12.5px;">등록된 자산이 없습니다.</p>`}
    </div>
  `;

  // 3-2) 임대 계약 내역 카드 — 임대계약서에 입력한 임대 물품 표시 (계약별 그룹)
  const contractItemsCard = renderContractItemsCard(c);

  // 3-3) 카운터 12개월 카드 — 거래처 자산의 최근 1년치 흑백/컬러 카운터
  const counters12mCard = renderCounters12mCard(c);

  // 4) 수리내역(지출) + 판매/수리(수익) 카드 — hook 에서 데이터 로드 후 채워짐
  const expenseCard = renderRepairCard(c, 'expense');
  const incomeCard  = renderRepairCard(c, 'income');

  // 4-1) 월 합계 카드 — 월 임대료 + 이번달 유상 − 이번달 무상
  const monthlyBalanceCard = renderMonthlyBalanceCard(c);

  // 📁 청구 정보 카드 (그룹 연결된 경우만) — assetCard 직전 삽입
  const billingCard = renderBillingInfoCard(c);

  // 순서: [모바일 뒤로가기] → 청구정보(그룹) → 보유자산 → 임대 계약 내역 → 카운터 12개월 → 수리(지출/수익) → 월 합계 → 기본정보 → 계약서 → Cross-sell
  detail.innerHTML = _renderMobileBackBtn() + billingCard + assetCard + contractItemsCard + counters12mCard + expenseCard + incomeCard + monthlyBalanceCard + infoCard + insightCard;
  _bindMobileBackBtn(detail);

  // 청구정보 카드 이벤트 — 그룹 편집, 같은그룹 사업장 이동
  detail.querySelectorAll('[data-rc-act="edit-group"]').forEach(btn => {
    btn.addEventListener('click', () => openGroupForm(btn.dataset.gid));
  });
  detail.querySelectorAll('[data-rc-goto]').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      STATE.selectedId = a.dataset.rcGoto;
      renderList(); renderDetail(); _mobileOpenDetail();
    });
  });

  document.getElementById('btn-edit').addEventListener('click', () => openForm(c));
  document.getElementById('btn-delete').addEventListener('click', () => deleteCustomer(c));

  const addBtn = document.getElementById('btn-asset-add');
  if (addBtn) addBtn.addEventListener('click', () => openAssetForm(c, null));

  const printCtBtn = document.getElementById('btn-print-contract');
  if (printCtBtn && !printCtBtn.disabled) {
    printCtBtn.addEventListener('click', () => openPrintContractWindow(c));
  }

  detail.querySelectorAll('.rc-asset-table .rc-icon-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const aid = btn.dataset.aid;
      const a = c._assignments.find(x => x.id === aid);
      if (!a) return;
      if (btn.dataset.act === 'edit') openAssetForm(c, a);
      else if (btn.dataset.act === 'del') deleteAsset(c, a);
    });
  });

  // "전체 이력" 버튼: 자산 수정 폼을 열고 변경이력 섹션 펼침
  detail.querySelectorAll('.rc-rh-all-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const aid = btn.dataset.aid;
      const a = c._assignments.find(x => x.id === aid);
      if (!a) return;
      openAssetForm(c, a, { openRateHistory: true });
    });
  });
}

function buildInsights(c) {
  const out = [];
  // 1. PC+모니터 세트
  if (c._hasPC && !c._hasMonitor) {
    out.push({
      level: 'warn',
      icon: '🖥',
      title: 'PC 단독 보유 — 모니터 제안 기회',
      body: 'PC는 임대 중이나 모니터가 없습니다. PC+모니터 세트 구성을 제안하면 월 임대료 +20% 인상 가능.',
    });
  } else if (c._hasPC && c._hasMonitor) {
    out.push({
      level: 'ok',
      icon: '✅',
      title: 'PC+모니터 세트 구성 완료',
      body: '표준 IT 패키지가 구성되어 있습니다.',
    });
  }

  // 2. 출력기기 → 웰리스 제균기
  if (c._hasOutput && !c._hasWellis) {
    out.push({
      level: 'warn',
      icon: '🌬',
      title: '출력기기 사용처 — 웰리스 제균기 제안',
      body: '토너/잉크 분진이 발생하는 공간입니다. 웰리스 제균기 설치로 실내 공기질 개선 + 추가 매출 확보.',
    });
  }

  // 3. NAS 후보
  if (c._isNasCandidate) {
    const reason = c._hasMFP
      ? `복합기 보유 + 월평균 ${Math.round(c._avgPages).toLocaleString()}장 출력`
      : `월평균 ${Math.round(c._avgPages).toLocaleString()}장 출력 (3,000장 이상)`;
    out.push({
      level: 'hot',
      icon: '💾',
      title: 'NAS 렌탈 우선 타겟',
      body: `${reason} — 대량 문서 스캔/보관 수요 예상. NAS 도입 제안 우선순위 상위.`,
    });
  }

  // 4. 라인업 다양화
  if (c._assignments.length > 0 && c._cats.size <= 1) {
    out.push({
      level: 'info',
      icon: '📊',
      title: '단일 카테고리 의존',
      body: '현재 한 가지 카테고리만 임대 중입니다. 타 카테고리(IT/출력/위생) 확장 여지가 큽니다.',
    });
  }

  return out;
}

function buildAsRows(c) {
  // subtype별 그룹핑
  const groups = {};
  c._assignments.forEach(a => {
    const st = a.rental_items.subtype || '기타';
    if (!groups[st]) groups[st] = { count: 0, items: [] };
    groups[st].count++;
    groups[st].items.push(a.rental_items);
  });

  const rows = [];
  Object.entries(groups).forEach(([subtype, g]) => {
    const sched = asScheduleOf(subtype);
    if (!sched) return;
    // 다음 점검일 = 가장 오래된 설치일 기준
    const installDates = g.items
      .map(it => it.install_date)
      .filter(Boolean)
      .map(d => new Date(d))
      .sort((a, b) => a - b);
    let nextDate = '-';
    let overdue = false;
    if (installDates.length) {
      const oldest = installDates[0];
      // 다음 점검: 현재까지 경과한 사이클의 다음 회차
      const now = new Date();
      const monthsElapsed = (now.getFullYear() - oldest.getFullYear()) * 12 + (now.getMonth() - oldest.getMonth());
      const nextCycle = Math.ceil((monthsElapsed + 0.01) / sched.months);
      const next = new Date(oldest.getFullYear(), oldest.getMonth() + nextCycle * sched.months, oldest.getDate());
      overdue = next < now;
      nextDate = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
    }
    rows.push({
      subtype, count: g.count, months: sched.months, task: sched.task, nextDate, overdue,
    });
  });

  return rows.sort((a, b) => a.months - b.months);
}

// ─────────────────────────────────────────────────────────────
// 동일 체크박스 바인딩 (사업자상호↔거래처상호 / 사업자주소↔설치주소)
// ─────────────────────────────────────────────────────────────
function _bindSameCheckboxes(container) {
  // 상호 동일 체크
  const chkName  = container.querySelector('#chk-same-name');
  const inpComp  = container.querySelector('[name="company"]');
  const inpTrade = container.querySelector('[name="trade_name"]');
  if (chkName && inpComp && inpTrade) {
    // 기존 값이 동일하면 체크 켬
    if (inpComp.value && inpComp.value === inpTrade.value) {
      chkName.checked = true;
      inpTrade.disabled = true;
      inpTrade.style.background = '#f1f5f9';
      inpTrade.style.color = '#94a3b8';
    }
    chkName.addEventListener('change', () => {
      if (chkName.checked) {
        inpTrade.value = inpComp.value;
        inpTrade.disabled = true;
        inpTrade.style.background = '#f1f5f9';
        inpTrade.style.color = '#94a3b8';
      } else {
        inpTrade.disabled = false;
        inpTrade.style.background = '';
        inpTrade.style.color = '';
      }
    });
    inpComp.addEventListener('input', () => {
      if (chkName.checked) inpTrade.value = inpComp.value;
    });
  }

  // 주소 동일 체크
  const chkAddr    = container.querySelector('#chk-same-addr');
  const inpAddress = container.querySelector('[name="address"]');
  const inpInstall = container.querySelector('[name="install_address"]');
  if (chkAddr && inpAddress && inpInstall) {
    // 기존 값이 동일하면 체크 켬
    if (inpAddress.value && inpAddress.value === inpInstall.value) {
      chkAddr.checked = true;
      inpInstall.disabled = true;
      inpInstall.style.background = '#f1f5f9';
      inpInstall.style.color = '#94a3b8';
    }
    chkAddr.addEventListener('change', () => {
      if (chkAddr.checked) {
        inpInstall.value = inpAddress.value;
        inpInstall.disabled = true;
        inpInstall.style.background = '#f1f5f9';
        inpInstall.style.color = '#94a3b8';
      } else {
        inpInstall.disabled = false;
        inpInstall.style.background = '';
        inpInstall.style.color = '';
      }
    });
    inpAddress.addEventListener('input', () => {
      if (chkAddr.checked) inpInstall.value = inpAddress.value;
    });
  }
}

// ─────────────────────────────────────────────────────────────
// CRUD: 추가/수정/삭제
// ─────────────────────────────────────────────────────────────
function openForm(existing) {
  const tpl = document.getElementById('tpl-customer-form');
  const body = document.getElementById('rc-modal-body');
  body.innerHTML = '';
  body.appendChild(tpl.content.cloneNode(true));

  // 청구 그룹 선택 영역 — 옵션 채우기 + 라디오 토글
  const _bgSelect = body.querySelector('select[name="billing_group_id"]');
  if (_bgSelect) {
    STATE.billingGroups.forEach(g => {
      const opt = document.createElement('option');
      opt.value = g.id;
      opt.textContent = `${g.name}${g.biz_no ? ' · '+g.biz_no : ''}`;
      _bgSelect.appendChild(opt);
    });
  }
  const _bgExistingRow = body.querySelector('#bg-existing-row');
  const _bgNewRow = body.querySelector('#bg-new-row');
  const _bgIndivRow = body.querySelector('#bg-individual-row');
  const _refreshBgRows = (val) => {
    if (_bgExistingRow) _bgExistingRow.style.display = (val === 'existing') ? '' : 'none';
    if (_bgNewRow)      _bgNewRow.style.display      = (val === 'new')      ? '' : 'none';
    // '이 사업장 발행 방식' 은 그룹 소속(existing/new)일 때만 의미 있음
    if (_bgIndivRow)    _bgIndivRow.style.display    = (val === 'none')     ? 'none' : '';
  };
  body.querySelectorAll('input[name="bg_choice"]').forEach(r => {
    r.addEventListener('change', () => _refreshBgRows(r.value));
  });

  if (existing) {
    body.querySelector('#form-title').textContent = `거래처 수정 — ${(existing.company || '').split('\n')[0]}`;
    const f = body.querySelector('#customer-form');
    [
      'company','biz_no','ceo','contact_name','biz_type','biz_item',
      'address','install_address','trade_name',
      'phone','fax','mobile','email',
      'deposit','period_years','invoice_day','notes'
    ].forEach(k => {
      if (f[k] != null) f[k].value = existing[k] == null ? '' : existing[k];
    });
    // 청구 그룹 prefill — billing_group_id 가 있으면 'existing' 라디오 + 선택
    if (existing.billing_group_id) {
      const exR = body.querySelector('input[name="bg_choice"][value="existing"]');
      if (exR) exR.checked = true;
      if (_bgSelect) _bgSelect.value = existing.billing_group_id;
      _refreshBgRows('existing');
    }
    // 사업장 개별 발행 prefill
    if (existing.billing_individual) {
      const indR = body.querySelector('input[name="billing_individual"][value="true"]');
      if (indR) indR.checked = true;
    }
    // 발행 구분 체크박스 — billing_types 배열 우선, 없으면 단일 billing_type 으로 폴백
    const bts = Array.isArray(existing.billing_types) && existing.billing_types.length
      ? existing.billing_types
      : (existing.billing_type ? [existing.billing_type] : []);
    body.querySelectorAll('input[name="billing_types"]').forEach(el => {
      el.checked = bts.includes(el.value);
    });
    // 옵션에 없는 옛 값(종이세금계산서/현금영수증 등)도 칩으로 추가해 데이터 보존
    const billingGroup = body.querySelector('input[name="billing_types"]')?.closest('.payment-methods');
    if (billingGroup) {
      const knownVals = Array.from(billingGroup.querySelectorAll('input[name="billing_types"]')).map(x => x.value);
      bts.filter(v => v && !knownVals.includes(v)).forEach(v => {
        const lbl = document.createElement('label');
        lbl.className = 'pm-chk';
        lbl.innerHTML = `<input type="checkbox" name="billing_types" value="${v.replace(/"/g, '&quot;')}" checked> ${v} (예전)`;
        billingGroup.appendChild(lbl);
      });
    }
    // 결제방법 체크박스 — 기존 배열에 포함된 값만 체크
    const pms = Array.isArray(existing.payment_methods) ? existing.payment_methods : [];
    body.querySelectorAll('input[name="payment_methods"]').forEach(el => {
      el.checked = pms.includes(el.value);
    });
    if (f.active) f.active.value = existing.active === false ? 'false' : 'true';
  }

  // 동일 체크박스 로직 바인딩
  _bindSameCheckboxes(body);

  body.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModal));
  body.querySelector('#customer-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const errEl = body.querySelector('#form-error');
    const btn = body.querySelector('#form-submit');
    errEl.textContent = '';
    btn.disabled = true;
    btn.textContent = '저장 중…';

    try {
      const company = f.company.value.trim();
      // 거래처상호: 체크박스 동일이면 사업자상호 값, 아니면 입력값 (비어 있으면 null)
      const tradeNameRaw = f.trade_name ? f.trade_name.value.trim() : '';
      const payload = {
        company,
        trade_name:    tradeNameRaw || null,
        biz_no:        f.biz_no.value.trim() || null,
        ceo:           f.ceo.value.trim() || null,
        contact_name:  f.contact_name.value.trim() || null,
        biz_type:      f.biz_type.value.trim() || null,
        biz_item:      f.biz_item.value.trim() || null,
        address:       f.address.value.trim() || null,
        install_address: f.install_address ? f.install_address.value.trim() || null : null,
        phone:         f.phone.value.trim() || null,
        fax:           f.fax.value.trim() || null,
        mobile:        f.mobile.value.trim() || null,
        email:         f.email.value.trim() || null,
        billing_types: (() => {
          const checked = Array.from(f.querySelectorAll('input[name="billing_types"]:checked')).map(x => x.value);
          return checked.length ? checked : null;
        })(),
        // 호환성 — 기존 단일 컬럼은 첫 번째 체크값으로 동기화
        billing_type: (() => {
          const first = f.querySelector('input[name="billing_types"]:checked');
          return first ? first.value : null;
        })(),
        payment_methods: (() => {
          const checked = Array.from(f.querySelectorAll('input[name="payment_methods"]:checked')).map(x => x.value);
          return checked.length ? checked : null;
        })(),
        deposit:       f.deposit.value ? Number(f.deposit.value) : null,
        period_years:  f.period_years.value ? Number(f.period_years.value) : null,
        invoice_day:   f.invoice_day.value ? Number(f.invoice_day.value) : null,
        notes:         f.notes.value.trim() || null,
        active:        f.active.value === 'true',
      };
      if (!payload.company) throw new Error('사업자상호는 필수입니다.');

      const supa = window.totalasAuth;

      // 사업장 개별 발행 — 그룹 소속일 때만 의미 있음 (단독 거래처면 강제 false)
      const indivRadio = f.querySelector('input[name="billing_individual"]:checked');
      const billingIndividual = indivRadio ? indivRadio.value === 'true' : false;

      // 청구 그룹 분기 — 'none' | 'existing' | 'new'
      const bgChoice = (f.querySelector('input[name="bg_choice"]:checked') || {}).value || 'none';
      if (bgChoice === 'none') {
        payload.billing_group_id = null;
        payload.billing_individual = false;
      } else if (bgChoice === 'existing') {
        const gid = f.billing_group_id ? f.billing_group_id.value : '';
        if (!gid) throw new Error('기존 그룹을 선택하세요.');
        payload.billing_group_id = gid;
        payload.billing_individual = billingIndividual;
      } else if (bgChoice === 'new') {
        const newName = (f.new_group_name?.value || '').trim();
        if (!newName) throw new Error('새 그룹명을 입력하세요.');
        const newBiz = (f.new_group_biz_no?.value || '').trim() || null;
        // 발행방식 라디오 — true(통합 1장) | false(사업장별 따로). 기본 통합.
        const combRadio = f.querySelector('input[name="new_group_combined"]:checked');
        const newCombined = combRadio ? (combRadio.value === 'true') : true;
        const newGroupId = 'bg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
        const { error: gErr } = await supa.from('rental_billing_groups').insert({
          id: newGroupId,
          name: newName,
          biz_no: newBiz,
          // 거래처 입력값 중 청구 관련 필드를 그룹 마스터로 옮겨 담아 두면 단독→그룹 전환이 자연스러움
          ceo:           payload.ceo || null,
          biz_type:      payload.biz_type || null,
          biz_item:      payload.biz_item || null,
          fax:           payload.fax || null,
          billing_type:  payload.billing_type || null,
          billing_types: payload.billing_types || null,
          payment_methods: payload.payment_methods || null,
          invoice_day:   payload.invoice_day != null ? String(payload.invoice_day) : null,
          bill_combined: newCombined,
          active:        true,
        });
        if (gErr) throw gErr;
        payload.billing_group_id = newGroupId;
        payload.billing_individual = billingIndividual;
      }

      if (existing) {
        const _savedIdEdit = STATE.selectedId || existing.id;
        const { error } = await supa.from('rental_customers').update(payload).eq('id', existing.id);
        if (error) throw error;
        closeModal();
        await loadAll();
        STATE.selectedId = _savedIdEdit;
        renderList();
        renderDetail();
      } else {
        // rental_customers.id 는 TEXT PRIMARY KEY (자동생성 안 됨) — 클라이언트에서 생성
        payload.id = 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
        const { error } = await supa.from('rental_customers').insert(payload);
        if (error) throw error;
        closeModal();
        await loadAll();
      }
    } catch (err) {
      console.error(err);
      errEl.textContent = err.message || String(err);
      btn.disabled = false;
      btn.textContent = '저장';
    }
  });

  // 🔍 관리툴 고객 검색 — 신규 추가 모드에서만 활성화
  if (!existing) {
    const searchBox = body.querySelector('#asms-search-box');
    if (searchBox) {
      searchBox.style.display = '';
      _bindAsmsCustomerSearch(body);
    }
  }

  document.getElementById('rc-modal').classList.add('show');
}

// 사업자번호 형식 보정 (10자리 숫자 → 000-00-00000). asms-web 의 formatBizNo 와 동일 규칙.
function _formatBizNoLocal(s) {
  if (!s) return '';
  const d = String(s).replace(/\D/g, '');
  if (d.length === 10) return d.replace(/(\d{3})(\d{2})(\d{5})/, '$1-$2-$3');
  return String(s);
}

// 관리툴(asms-web) customers 테이블에서 고객 검색.
// 같은 Supabase 인스턴스(wghjnlhfqypamiwukeio) · authenticated RLS 로 select 가능.
async function _searchAsmsCustomers(query) {
  const q = (query || '').trim();
  if (q.length < 2) return [];
  const supa = window.totalasAuth;
  if (!supa) return [];
  // PostgREST `or` 안의 콤마/괄호는 파서를 깨므로 사전 제거
  const safe = q.replace(/[,()]/g, ' ').trim();
  if (!safe) return [];
  const { data, error } = await supa
    .from('customers')
    .select('cu_number,cu_name,cu_mobile,cu_tel,co_tel,co_fax,cu_mail,zipcode1,address1,address2')
    .or(`cu_name.ilike.%${safe}%,cu_mobile.ilike.%${safe}%,cu_tel.ilike.%${safe}%`)
    .limit(15);
  if (error) { console.warn('[asms-search] 실패:', error.message || error); return []; }
  return data || [];
}

// 검색된 관리툴 고객 1건 → 거래처 폼에 자동 채움. 이미 입력된 칸은 보존.
function _fillFormFromAsmsCustomer(form, c) {
  const setIfEmpty = (name, val) => {
    if (form[name] != null && !form[name].value && val) form[name].value = val;
  };
  const name = c.cu_name || '';
  const addr = [
    c.zipcode1 ? `(${c.zipcode1})` : '',
    c.address1 || '',
    c.address2 || ''
  ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

  setIfEmpty('company', name);
  setIfEmpty('trade_name', name);
  setIfEmpty('biz_no', _formatBizNoLocal(c.co_tel));
  setIfEmpty('mobile', c.cu_mobile);
  setIfEmpty('phone', c.cu_tel);
  setIfEmpty('fax', c.co_fax);
  setIfEmpty('email', c.cu_mail);
  setIfEmpty('address', addr);
  setIfEmpty('install_address', addr);
}

// 검색창 + 결과 드롭다운 + 키보드(Esc) 닫힘 바인딩
function _bindAsmsCustomerSearch(body) {
  const input  = body.querySelector('#asms-search-input');
  const result = body.querySelector('#asms-search-results');
  const status = body.querySelector('#asms-search-status');
  const form   = body.querySelector('#customer-form');
  if (!input || !result || !form) return;

  let timer = null;
  let lastQuery = '';

  const render = (rows) => {
    if (!rows.length) {
      result.innerHTML = `<div style="padding:8px 10px;color:#6b7280;">일치하는 고객이 없습니다.</div>`;
      result.style.display = '';
      return;
    }
    result.innerHTML = rows.map(r => {
      const sub = [r.cu_mobile, r.cu_tel, r.address1].filter(Boolean).join(' · ');
      return `<div class="asms-hit" data-id="${escapeAttr(r.cu_number)}" style="padding:6px 10px;border-bottom:1px solid #f3f4f6;cursor:pointer;">
        <div style="font-weight:600;color:#111827;">${escapeHtml(r.cu_name || '(이름 없음)')}</div>
        <div style="font-size:11px;color:#6b7280;">${escapeHtml(sub)}</div>
      </div>`;
    }).join('');
    result.style.display = '';
    result.querySelectorAll('.asms-hit').forEach(el => {
      el.addEventListener('mouseenter', () => el.style.background = '#fef3c7');
      el.addEventListener('mouseleave', () => el.style.background = '');
      el.addEventListener('click', () => {
        const id = el.getAttribute('data-id');
        const picked = rows.find(x => String(x.cu_number) === String(id));
        if (!picked) return;
        _fillFormFromAsmsCustomer(form, picked);
        result.style.display = 'none';
        input.value = picked.cu_name || '';
        if (status) status.textContent = `✔ 관리툴 고객 [${picked.cu_name}] 정보를 채웠습니다. 나머지는 직접 입력하세요.`;
      });
    });
  };

  const doSearch = async (q) => {
    if (q === lastQuery) return;
    lastQuery = q;
    if (q.trim().length < 2) {
      result.style.display = 'none';
      if (status) status.textContent = '2자 이상 입력하면 관리툴 고객DB에서 검색합니다.';
      return;
    }
    if (status) status.textContent = '검색 중…';
    const rows = await _searchAsmsCustomers(q);
    if (status) status.textContent = rows.length
      ? `${rows.length}건 검색됨 — 클릭하면 폼에 자동 입력됩니다.`
      : '일치하는 고객이 없습니다.';
    render(rows);
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => doSearch(input.value), 300);
  });
  input.addEventListener('focus', () => {
    if (result.innerHTML && input.value.trim().length >= 2) result.style.display = '';
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { result.style.display = 'none'; }
  });
  // 결과 바깥 클릭 → 닫기
  document.addEventListener('click', (e) => {
    const box = body.querySelector('#asms-search-box');
    if (box && !box.contains(e.target)) result.style.display = 'none';
  }, { capture: true });
}

// 📁 청구 그룹 마스터 편집 모달
// 사용처: 상세 카드의 [⚙ 그룹 편집] 버튼
function openGroupForm(groupId) {
  const supa = window.totalasAuth;
  const body = document.getElementById('rc-modal-body');
  const g = STATE.groupById[groupId];
  if (!g) { toast('그룹을 찾을 수 없습니다.', 'err'); return; }
  const sameCount = STATE.customers.filter(x => x._group && x._group.id === g.id).length;
  const bt = Array.isArray(g.billing_types) && g.billing_types.length
    ? g.billing_types : (g.billing_type ? [g.billing_type] : []);
  const pm = Array.isArray(g.payment_methods) ? g.payment_methods : [];
  body.innerHTML = `
    <h3>📁 청구 그룹 편집 — ${escapeHtml(g.name)}</h3>
    <form id="group-form" autocomplete="off">
      <div class="rc-form-row two">
        <div class="rc-form-row" style="margin:0;">
          <label>그룹명 *</label>
          <input name="name" value="${escapeAttr(g.name || '')}" required placeholder="홈마트">
        </div>
        <div class="rc-form-row" style="margin:0;">
          <label>사업자번호</label>
          <input name="biz_no" value="${escapeAttr(g.biz_no || '')}" placeholder="000-00-00000">
        </div>
      </div>
      <div class="rc-form-row two">
        <div class="rc-form-row" style="margin:0;"><label>대표자</label><input name="ceo" value="${escapeAttr(g.ceo || '')}"></div>
        <div class="rc-form-row" style="margin:0;"><label>팩스</label><input name="fax" value="${escapeAttr(g.fax || '')}"></div>
      </div>
      <div class="rc-form-row two">
        <div class="rc-form-row" style="margin:0;"><label>업태</label><input name="biz_type" value="${escapeAttr(g.biz_type || '')}"></div>
        <div class="rc-form-row" style="margin:0;"><label>종목</label><input name="biz_item" value="${escapeAttr(g.biz_item || '')}"></div>
      </div>
      <div class="rc-form-row two">
        <div class="rc-form-row" style="margin:0;">
          <label>발행 구분</label>
          <div class="payment-methods">
            <label class="pm-chk"><input type="checkbox" name="billing_types" value="전자세금계산서" ${bt.includes('전자세금계산서')?'checked':''}> 전자세금계산서</label>
            <label class="pm-chk"><input type="checkbox" name="billing_types" value="거래명세표" ${bt.includes('거래명세표')?'checked':''}> 거래명세표</label>
          </div>
        </div>
        <div class="rc-form-row" style="margin:0;">
          <label>결제방법</label>
          <div class="payment-methods">
            <label class="pm-chk"><input type="checkbox" name="payment_methods" value="CMS계좌" ${pm.includes('CMS계좌')?'checked':''}> CMS계좌</label>
            <label class="pm-chk"><input type="checkbox" name="payment_methods" value="CMS카드" ${pm.includes('CMS카드')?'checked':''}> CMS카드</label>
            <label class="pm-chk"><input type="checkbox" name="payment_methods" value="입금" ${pm.includes('입금')?'checked':''}> 입금</label>
          </div>
        </div>
      </div>
      <div class="rc-form-row two">
        <div class="rc-form-row" style="margin:0;"><label>청구일</label><input name="invoice_day" value="${escapeAttr(g.invoice_day || '')}" placeholder="25"></div>
        <div class="rc-form-row" style="margin:0;">
          <label>통합 발행</label>
          <select name="bill_combined">
            <option value="true"  ${g.bill_combined !== false ? 'selected' : ''}>예 (그룹 1장 합산)</option>
            <option value="false" ${g.bill_combined === false ? 'selected' : ''}>아니오 (사업장별 발행)</option>
          </select>
        </div>
      </div>
      <div class="rc-form-row">
        <label>메모</label>
        <textarea name="notes" rows="2">${escapeHtml(g.notes || '')}</textarea>
      </div>
      <div style="font-size:11.5px;color:var(--muted);margin:4px 0;">현재 이 그룹에 속한 사업장: <strong>${sameCount}곳</strong></div>
      <div id="form-error" class="rc-error"></div>
      <div class="rc-modal-actions">
        <button type="button" class="btn ghost" data-close>취소</button>
        <button type="button" class="btn danger" id="group-delete" ${sameCount > 0 ? 'disabled title="사업장 연결을 모두 해제 후 삭제 가능"' : ''}>그룹 삭제</button>
        <button type="submit" class="btn primary" id="group-submit">저장</button>
      </div>
    </form>
  `;
  body.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModal));
  body.querySelector('#group-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const errEl = body.querySelector('#form-error');
    const btn = body.querySelector('#group-submit');
    errEl.textContent = ''; btn.disabled = true; btn.textContent = '저장 중…';
    try {
      const name = f.name.value.trim();
      if (!name) throw new Error('그룹명은 필수입니다.');
      const billingTypes = Array.from(f.querySelectorAll('input[name="billing_types"]:checked')).map(x => x.value);
      const paymentMethods = Array.from(f.querySelectorAll('input[name="payment_methods"]:checked')).map(x => x.value);
      const patch = {
        name,
        biz_no:        f.biz_no.value.trim() || null,
        ceo:           f.ceo.value.trim() || null,
        fax:           f.fax.value.trim() || null,
        biz_type:      f.biz_type.value.trim() || null,
        biz_item:      f.biz_item.value.trim() || null,
        billing_types: billingTypes.length ? billingTypes : null,
        billing_type:  billingTypes[0] || null,
        payment_methods: paymentMethods.length ? paymentMethods : null,
        invoice_day:   f.invoice_day.value.trim() || null,
        bill_combined: f.bill_combined.value === 'true',
        notes:         f.notes.value.trim() || null,
      };
      const { error } = await supa.from('rental_billing_groups').update(patch).eq('id', groupId);
      if (error) throw error;
      closeModal();
      await loadAll();
      renderList(); renderDetail();
      toast('그룹 저장 완료', 'ok');
    } catch (err) {
      console.error(err);
      errEl.textContent = err.message || String(err);
      btn.disabled = false; btn.textContent = '저장';
    }
  });
  const delBtn = body.querySelector('#group-delete');
  if (delBtn && sameCount === 0) {
    delBtn.addEventListener('click', async () => {
      if (!confirm(`그룹 '${g.name}' 을(를) 삭제할까요?`)) return;
      try {
        const { error } = await supa.from('rental_billing_groups').delete().eq('id', groupId);
        if (error) throw error;
        closeModal();
        await loadAll();
        renderList(); renderDetail();
        toast('그룹 삭제 완료', 'ok');
      } catch (err) {
        toast('삭제 실패: ' + (err.message || err), 'err');
      }
    });
  }
  document.getElementById('rc-modal').classList.add('show');
}

async function deleteCustomer(c) {
  if (!confirm(`'${(c.company || '').split('\n')[0]}' 거래처를 삭제할까요?\n\n관련 자산 할당(rental_assignments)이 있으면 실패할 수 있습니다.`)) return;
  try {
    const { error } = await window.totalasAuth.from('rental_customers').delete().eq('id', c.id);
    if (error) throw error;
    STATE.selectedId = null;
    await loadAll();
    renderDetail();
  } catch (err) {
    console.error(err);
    alert('삭제 실패: ' + (err.message || err));
  }
}

// ─────────────────────────────────────────────────────────────
// 품목 마스터 관리 모달
// ─────────────────────────────────────────────────────────────
async function openItemTypesModal() {
  const supa = window.totalasAuth;
  if (!supa) return toast('인증 미준비', 'err');
  const body = document.getElementById('rc-modal-body');
  body.innerHTML = '<h3>⚙ 품목 관리</h3><div style="padding:20px;text-align:center;color:var(--muted);">로딩 중…</div>';
  document.getElementById('rc-modal').classList.add('show');
  const { data, error } = await supa.from('rental_item_types')
    .select('*').order('sort_order', { ascending: true });
  if (error) { body.innerHTML = `<h3>⚙ 품목 관리</h3><p class="rc-form-error">조회 실패: ${escapeHtml(error.message)}</p>`; return; }
  const rows = data || [];
  const catOpts = ['출력','IT','위생','기타'];
  const rowHtml = (r) => `
    <tr data-id="${r.id}">
      <td style="text-align:center;"><input type="checkbox" data-field="active" ${r.active ? 'checked' : ''} title="체크 해제 = 모든 폼에서 숨김"></td>
      <td><input type="text" data-field="icon" value="${escapeAttr(r.icon || '')}" style="width:42px;text-align:center;font-size:14px;"></td>
      <td><input type="text" data-field="label" value="${escapeAttr(r.label)}" style="width:120px;font-weight:600;" title="DB 식별값 — 신중하게 변경"></td>
      <td><input type="text" data-field="form_label" value="${escapeAttr(r.form_label || '')}" placeholder="(폼 표시명)" style="width:180px;"></td>
      <td>
        <select data-field="category">
          ${catOpts.map(c => `<option value="${c}"${r.category === c ? ' selected' : ''}>${c}</option>`).join('')}
        </select>
      </td>
      <td><input type="number" data-field="sort_order" value="${r.sort_order}" min="0" step="10" style="width:64px;text-align:center;"></td>
      <td style="text-align:center;"><input type="checkbox" data-field="is_print" ${r.is_print ? 'checked' : ''} title="카운터/빌링 대상"></td>
      <td><button class="btn ghost small" data-act="del" title="삭제 (사용 중 자산이 있으면 차단)">🗑</button></td>
    </tr>`;
  body.innerHTML = `
    <h3>⚙ 품목 관리</h3>
    <p class="muted" style="font-size:12px;margin:0 0 8px 0;">한 곳에서 수정 시 모든 모듈(임대거래처/현황/계약서) 다음 진입 시 자동 반영됩니다.</p>
    <div style="overflow-x:auto;">
      <table class="rc-itypes-table" style="width:100%;border-collapse:collapse;font-size:12.5px;">
        <thead>
          <tr style="background:#f8fafc;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.3px;">
            <th style="padding:6px;width:38px;">표시</th>
            <th style="padding:6px;width:48px;">아이콘</th>
            <th style="padding:6px;">라벨(DB 값)</th>
            <th style="padding:6px;">폼 표시명</th>
            <th style="padding:6px;width:80px;">카테고리</th>
            <th style="padding:6px;width:70px;">순서</th>
            <th style="padding:6px;width:56px;">출력</th>
            <th style="padding:6px;width:40px;"></th>
          </tr>
        </thead>
        <tbody id="itypes-tbody">${rows.map(rowHtml).join('')}</tbody>
      </table>
    </div>
    <div style="margin-top:14px;padding:10px;border:1px dashed var(--border);border-radius:8px;background:#f8fafc;">
      <div style="font-weight:600;margin-bottom:6px;font-size:12.5px;">+ 새 품목 추가</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:flex-end;">
        <div><label style="font-size:11px;display:block;">라벨 *</label><input type="text" id="itypes-new-label" placeholder="예: 태블릿" style="width:120px;"></div>
        <div><label style="font-size:11px;display:block;">폼 표시명</label><input type="text" id="itypes-new-form-label" placeholder="(라벨과 동일)" style="width:160px;"></div>
        <div><label style="font-size:11px;display:block;">카테고리</label>
          <select id="itypes-new-category">${catOpts.map(c => `<option value="${c}"${c === 'IT' ? ' selected' : ''}>${c}</option>`).join('')}</select>
        </div>
        <div><label style="font-size:11px;display:block;">아이콘</label><input type="text" id="itypes-new-icon" placeholder="📱" style="width:48px;text-align:center;"></div>
        <div><label style="font-size:11px;display:block;">순서</label><input type="number" id="itypes-new-sort" value="200" min="0" step="10" style="width:70px;"></div>
        <button class="btn primary small" id="itypes-add">+ 추가</button>
      </div>
      <div id="itypes-new-error" class="rc-form-error" style="margin-top:4px;font-size:12px;"></div>
    </div>
    <div class="rc-form-actions" style="margin-top:12px;">
      <button class="btn ghost" data-close>닫기</button>
    </div>`;

  const tbody = body.querySelector('#itypes-tbody');

  // 인라인 변경 — 변경 즉시 UPDATE
  async function persistRow(tr) {
    const id = Number(tr.dataset.id);
    const patch = {};
    tr.querySelectorAll('[data-field]').forEach(el => {
      const k = el.dataset.field;
      if (el.type === 'checkbox') patch[k] = el.checked;
      else if (el.type === 'number') patch[k] = el.value === '' ? 0 : Number(el.value);
      else patch[k] = el.value.trim() || null;
    });
    patch.updated_at = new Date().toISOString();
    const res = await supa.from('rental_item_types').update(patch).eq('id', id);
    if (res.error) return toast('저장 실패: ' + res.error.message, 'err');
    window.invalidateItemTypes();
    ITEM_TYPES = await window.loadItemTypes({ force: true });
    toast('저장됨', 'ok');
  }
  tbody.addEventListener('change', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) persistRow(tr);
  });
  tbody.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act="del"]');
    if (!btn) return;
    const tr = btn.closest('tr[data-id]');
    const id = Number(tr.dataset.id);
    const label = tr.querySelector('[data-field="label"]').value;
    if (!confirm(`'${label}' 품목을 삭제할까요?\n사용 중 자산이 있으면 실패합니다.`)) return;
    // 사용 중 자산 확인
    const used = await supa.from('rental_items').select('id', { count: 'exact', head: true }).eq('subtype', label);
    if ((used.count || 0) > 0) return toast(`삭제 불가 — ${used.count}건의 자산이 사용 중`, 'err');
    const res = await supa.from('rental_item_types').delete().eq('id', id);
    if (res.error) return toast('삭제 실패: ' + res.error.message, 'err');
    tr.remove();
    window.invalidateItemTypes();
    ITEM_TYPES = await window.loadItemTypes({ force: true });
    toast('삭제됨', 'ok');
  });

  // 새 품목 추가
  body.querySelector('#itypes-add').addEventListener('click', async () => {
    const errEl = body.querySelector('#itypes-new-error');
    errEl.textContent = '';
    const label = body.querySelector('#itypes-new-label').value.trim();
    if (!label) { errEl.textContent = '라벨을 입력하세요.'; return; }
    const payload = {
      label,
      form_label: body.querySelector('#itypes-new-form-label').value.trim() || label,
      category:   body.querySelector('#itypes-new-category').value,
      icon:       body.querySelector('#itypes-new-icon').value.trim() || null,
      sort_order: Number(body.querySelector('#itypes-new-sort').value) || 0,
      active:     true,
      is_print:   false,
    };
    const res = await supa.from('rental_item_types').insert(payload).select().single();
    if (res.error) { errEl.textContent = '추가 실패: ' + res.error.message; return; }
    // 새 행 append + 입력 초기화
    tbody.insertAdjacentHTML('beforeend', rowHtml(res.data));
    body.querySelector('#itypes-new-label').value = '';
    body.querySelector('#itypes-new-form-label').value = '';
    body.querySelector('#itypes-new-icon').value = '';
    window.invalidateItemTypes();
    ITEM_TYPES = await window.loadItemTypes({ force: true });
    toast('추가됨', 'ok');
  });

  body.querySelector('[data-close]').addEventListener('click', closeModal);
}

function closeModal() {
  document.getElementById('rc-modal').classList.remove('show');
  document.getElementById('rc-modal-body').classList.remove('rc-asset-modal-box');
}

// ─────────────────────────────────────────────────────────────
// CRUD: 자산 (rental_items + rental_assignments)
// ─────────────────────────────────────────────────────────────

// 품목 → { category, subtype, isPrint, isNas } 매핑
// 마스터(rental_item_types) 에서 동적 생성. ITEM_TYPES 로드 후 호출.
// 흑백복사기/컬러복사기 라벨은 청구 로직 호환 위해 subtype 을 '흑백복합기'/'컬러복합기' 로 매핑.
function buildItemToCatsub() {
  const out = {};
  const LEGACY_SUBTYPE_MAP = {
    '흑백복사기': '흑백복합기',
    '컬러복사기': '컬러복합기',
  };
  for (const t of (ITEM_TYPES || [])) {
    out[t.label] = {
      category: t.category,
      subtype:  LEGACY_SUBTYPE_MAP[t.label] || t.label,
      isPrint:  !!t.is_print,
      isNas:    t.label === '나스',
    };
  }
  return out;
}
// Proxy 같은 형태로 ITEM_TO_CATSUB 동적 참조 — 기존 호출부 호환
const ITEM_TO_CATSUB = new Proxy({}, {
  get(_t, key) {
    if (!ITEM_TYPES.length) return undefined;
    return buildItemToCatsub()[key];
  },
  has(_t, key) { return key in buildItemToCatsub(); },
  ownKeys() { return Reflect.ownKeys(buildItemToCatsub()); },
  getOwnPropertyDescriptor(_t, key) {
    const v = buildItemToCatsub()[key];
    return v ? { value: v, enumerable: true, configurable: true } : undefined;
  },
});

// 기존 자산(category, subtype, co_rate)을 9개 품목으로 역분류 (수정 폼 열 때)
function classifyToItemType(it, asgn) {
  const sub = (it && it.subtype || '').toLowerCase();
  const cat = it && it.category || '';
  const isColor = asgn ? ((asgn.co_rate || 0) > 0 || (asgn.co_free || 0) > 0) : false;
  if (sub.includes('흑백복합기') || sub.includes('흑백복사기')) return '흑백복사기';
  if (sub.includes('컬러복합기') || sub.includes('컬러복사기')) return '컬러복사기';
  if (sub.includes('흑백레이저')) return '흑백레이저';
  if (sub.includes('컬러레이저')) return '컬러레이저';
  if (/복합기|mfp|복사/.test(sub)) return isColor ? '컬러복사기' : '흑백복사기';
  if (/laser|레이저/.test(sub))   return isColor ? '컬러레이저' : '흑백레이저';
  if (/inkjet|잉크젯/.test(sub))  return '잉크젯';
  if (/유지보수|maintenance|maintain/.test(sub)) return 'PC유지보수';
  if (/노트북|notebook|laptop/.test(sub)) return '노트북';
  if (/pc|컴퓨터|데스크/.test(sub)) return '컴퓨터';
  if (/monitor|모니터/.test(sub)) return '모니터';
  if (cat === '위생' || /wellness|wellis|웰리스|제균|필터/.test(sub)) return '웰리스';
  if (/nas|나스/.test(sub))       return '나스';
  return '';
}

function applyAssetVisibility(form) {
  const itemType = form.item_type ? form.item_type.value : '';
  const info = ITEM_TO_CATSUB[itemType] || { isPrint: false, isNas: false };
  form.querySelectorAll('[data-show]').forEach(row => {
    const tag = row.dataset.show;
    let show = false;
    if (tag === 'print') show = info.isPrint;
    else if (tag === 'nas') show = info.isNas;
    row.classList.toggle('hidden', !show);
  });
  // 합계 카운터 모드 토글 초기화 (품목 변경 시 print 섹션 재노출 후 동기화)
  if (info.isPrint) {
    applyTotalCounterToggle(form);
  }
}

// 합계 카운터 체크박스 상태에 따라 분할/합계 입력칸 활성 전환
function applyTotalCounterToggle(form) {
  const cb = form.querySelector('#asset-use-total-counter');
  const splitRow = form.querySelector('#asset-split-rate-row');
  const totalRow = form.querySelector('#asset-total-rate-row');
  const totalFreeInput  = form.querySelector('#asset-total-free-count');
  const totalUnitInput  = form.querySelector('#asset-total-unit-price');
  if (!cb) return;
  const isTotalMode = cb.checked;
  // 분할 단가 행 - 합계 모드이면 비활성(흐리게), 활성 모드이면 정상
  if (splitRow) {
    const bwRate = splitRow.querySelector('[name=bw_rate]');
    const coRate = splitRow.querySelector('[name=co_rate]');
    if (bwRate) { bwRate.disabled = isTotalMode; bwRate.style.opacity = isTotalMode ? '0.4' : ''; }
    if (coRate) { coRate.disabled = isTotalMode; coRate.style.opacity = isTotalMode ? '0.4' : ''; }
  }
  // 합계 단가 행 - 합계 모드이면 활성, 아니면 비활성
  if (totalRow) totalRow.classList.toggle('hidden', !isTotalMode);
  if (totalFreeInput) totalFreeInput.disabled = !isTotalMode;
  if (totalUnitInput) totalUnitInput.disabled = !isTotalMode;
}

// ─────────────────────────────────────────────────────────────
// Phase 3: 자산 rate 변경 이력 섹션 바인딩
// ─────────────────────────────────────────────────────────────
function _bindRateHistorySection(container, itemId, assignment) {
  const supa = window.totalasAuth;
  const wrap      = container.querySelector('#asset-rate-history-wrap');
  const toggle    = container.querySelector('#rate-history-toggle');
  const body      = container.querySelector('#rate-history-body');
  const listEl    = container.querySelector('#rate-history-list');
  const badgeEl   = container.querySelector('#rate-history-badge');
  const addBtn    = container.querySelector('#rh-add-btn');
  const errEl     = container.querySelector('#rh-error');
  if (!wrap || !toggle || !body || !listEl || !addBtn) return;

  // 자산의 counter_mode 에 따라 입력 필드 분기
  const isTotalMode = (assignment && assignment.rental_items && assignment.rental_items.counter_mode === 'total');
  const splitFields = container.querySelector('#rh-split-fields');
  const totalFields = container.querySelector('#rh-total-fields');
  if (splitFields) splitFields.style.display = isTotalMode ? 'none' : '';
  if (totalFields) totalFields.style.display = isTotalMode ? '' : 'none';

  // 이력 데이터 캐시
  let _history = [];

  function _fmtRhRow(h) {
    if (isTotalMode) {
      return `
        <td style="padding:4px 6px;text-align:right;">${h.total_free_count != null ? h.total_free_count.toLocaleString() : '-'}</td>
        <td style="padding:4px 6px;text-align:right;">${h.total_unit_price != null ? Number(h.total_unit_price).toLocaleString() : '-'}</td>`;
    }
    return `
      <td style="padding:4px 6px;text-align:right;">${h.bw_free != null ? h.bw_free.toLocaleString() : '-'}</td>
      <td style="padding:4px 6px;text-align:right;">${h.co_free != null ? h.co_free.toLocaleString() : '-'}</td>
      <td style="padding:4px 6px;text-align:right;">${h.bw_rate != null ? Number(h.bw_rate).toLocaleString() : '-'}</td>
      <td style="padding:4px 6px;text-align:right;">${h.co_rate != null ? Number(h.co_rate).toLocaleString() : '-'}</td>`;
  }

  function _rhColHeaders() {
    if (isTotalMode) {
      return `<th style="padding:4px 6px;text-align:right;">무료매수</th>
              <th style="padding:4px 6px;text-align:right;">매수단가</th>`;
    }
    return `<th style="padding:4px 6px;text-align:right;">BW무료</th>
            <th style="padding:4px 6px;text-align:right;">CO무료</th>
            <th style="padding:4px 6px;text-align:right;">BW단가</th>
            <th style="padding:4px 6px;text-align:right;">CO단가</th>`;
  }

  function renderHistoryList() {
    badgeEl.textContent = _history.length ? `${_history.length}건` : '';
    if (!_history.length) {
      listEl.innerHTML = '<div style="color:var(--muted);font-size:11.5px;padding:4px 0;">변경 이력이 없습니다.</div>';
      return;
    }
    listEl.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:11.5px;">
        <thead>
          <tr style="background:#f1f5f9;">
            <th style="padding:4px 6px;text-align:left;font-weight:600;">적용일</th>
            ${_rhColHeaders()}
            <th style="padding:4px 6px;text-align:left;">메모</th>
            <th style="padding:4px 6px;"></th>
          </tr>
        </thead>
        <tbody>
          ${_history.map((h, i) => `
            <tr style="border-top:1px solid #e2e8f0;${i === _history.length - 1 ? 'background:#f0fdf4;font-weight:600;' : ''}">
              <td style="padding:4px 6px;">${h.effective_date}</td>
              ${_fmtRhRow(h)}
              <td style="padding:4px 6px;color:var(--muted);">${escapeHtml(h.note || '')}</td>
              <td style="padding:4px 6px;">
                <button type="button" style="font-size:11px;background:none;border:none;color:#dc2626;cursor:pointer;padding:1px 4px;"
                  data-rh-del="${escapeAttr(h.id)}">삭제</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      <div style="font-size:10.5px;color:var(--muted);margin-top:4px;">* 녹색 행 = 현재 적용 중인 최신 이력</div>
    `;

    // 삭제 버튼 바인딩
    listEl.querySelectorAll('[data-rh-del]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const rhId = btn.dataset.rhDel;
        if (!confirm('이 이력을 삭제하시겠습니까?\n삭제 후 rental_items 값이 이전 이력으로 재동기화됩니다.')) return;
        try {
          const { error } = await supa.from('rental_item_rate_history').delete().eq('id', rhId);
          if (error) throw error;
          _history = _history.filter(h => h.id !== rhId);
          // rental_items + rental_assignments 재동기화
          await _syncLatestRateTo(itemId, assignment, _history);
          renderHistoryList();
          toast('이력이 삭제되었습니다.', 'ok');
        } catch (err) {
          console.error(err);
          toast('이력 삭제 실패: ' + (err.message || err), 'err');
        }
      });
    });
  }

  // 토글 바인딩
  toggle.addEventListener('click', () => {
    const isOpen = body.style.display !== 'none';
    body.style.display = isOpen ? 'none' : '';
    container.querySelector('#rate-history-arrow').textContent = isOpen ? '[펼치기]' : '[접기]';
  });

  // 이력 추가 저장
  addBtn.addEventListener('click', async () => {
    errEl.textContent = '';
    const effDate = container.querySelector('#rh-effective-date').value;
    const note    = container.querySelector('#rh-note').value.trim();

    if (!effDate) { errEl.textContent = '적용일을 입력하세요.'; return; }

    const rhId = 'rh_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    let payload;

    if (isTotalMode) {
      const totalFree = container.querySelector('#rh-total-free').value;
      const totalUnit = container.querySelector('#rh-total-unit').value;
      if (totalFree === '' && totalUnit === '') {
        errEl.textContent = '변경할 값을 하나 이상 입력하세요.'; return;
      }
      payload = {
        id:               rhId,
        item_id:          itemId,
        effective_date:   effDate,
        total_free_count: totalFree !== '' ? Number(totalFree) : null,
        total_unit_price: totalUnit !== '' ? Number(totalUnit) : null,
        note:             note || null,
      };
    } else {
      const bwFree = container.querySelector('#rh-bw-free').value;
      const coFree = container.querySelector('#rh-co-free').value;
      const bwRate = container.querySelector('#rh-bw-rate').value;
      const coRate = container.querySelector('#rh-co-rate').value;
      if (bwFree === '' && coFree === '' && bwRate === '' && coRate === '') {
        errEl.textContent = '변경할 값을 하나 이상 입력하세요.'; return;
      }
      payload = {
        id:             rhId,
        item_id:        itemId,
        effective_date: effDate,
        bw_free:        bwFree  !== '' ? Number(bwFree)  : null,
        co_free:        coFree  !== '' ? Number(coFree)  : null,
        bw_rate:        bwRate  !== '' ? Number(bwRate)  : null,
        co_rate:        coRate  !== '' ? Number(coRate)  : null,
        note:           note || null,
      };
    }

    addBtn.disabled = true;
    addBtn.textContent = '저장 중…';
    try {
      const { error } = await supa.from('rental_item_rate_history').insert(payload);
      if (error) throw error;
      _history.push(payload);
      _history.sort((a, b) => a.effective_date.localeCompare(b.effective_date));
      // rental_items + rental_assignments 최신 이력으로 동기화
      await _syncLatestRateTo(itemId, assignment, _history, isTotalMode);
      // 입력 초기화
      container.querySelector('#rh-effective-date').value = '';
      container.querySelector('#rh-note').value = '';
      if (isTotalMode) {
        container.querySelector('#rh-total-free').value = '';
        container.querySelector('#rh-total-unit').value = '';
      } else {
        container.querySelector('#rh-bw-free').value = '';
        container.querySelector('#rh-co-free').value = '';
        container.querySelector('#rh-bw-rate').value = '';
        container.querySelector('#rh-co-rate').value = '';
      }
      renderHistoryList();
      toast('rate 변경 이력이 저장되었습니다.', 'ok');
    } catch (err) {
      console.error(err);
      errEl.textContent = '저장 실패: ' + (err.message || err);
    } finally {
      addBtn.disabled = false;
      addBtn.textContent = '이력 저장';
    }
  });

  // 이력 로드
  async function loadHistory() {
    try {
      const { data, error } = await supa
        .from('rental_item_rate_history')
        .select('id, item_id, effective_date, bw_free, co_free, bw_rate, co_rate, total_free_count, total_unit_price, note')
        .eq('item_id', itemId)
        .order('effective_date', { ascending: true });
      if (error) throw error;
      _history = data || [];
      renderHistoryList();
    } catch (err) {
      console.warn('[customers] rate 이력 로드 실패:', err.message || err);
    }
  }

  loadHistory();
}

// rate 이력 변경 후 rental_items + rental_assignments 의 단가/기본매수를
// 가장 최신 이력값으로 동기화 (이력이 없으면 원복 없음 — assignment 초기값 유지)
async function _syncLatestRateTo(itemId, assignment, history, isTotalMode) {
  const supa = window.totalasAuth;
  if (!supa) return;
  if (!history.length) return; // 이력 삭제로 빈 경우 — 초기값 유지 (덮어쓰지 않음)

  const latest = history[history.length - 1];
  const itemPatch = {};
  const asgPatch  = {};

  if (isTotalMode) {
    // rental_items 에 total 컬럼 동기화
    if (latest.total_free_count != null) itemPatch.total_free_count = latest.total_free_count;
    if (latest.total_unit_price != null) itemPatch.total_unit_price = latest.total_unit_price;
  } else {
    // rental_assignments 에 split 컬럼 동기화
    if (latest.bw_free != null) asgPatch.bw_free = latest.bw_free;
    if (latest.co_free != null) asgPatch.co_free = latest.co_free;
    if (latest.bw_rate != null) asgPatch.bw_rate = latest.bw_rate;
    if (latest.co_rate != null) asgPatch.co_rate = latest.co_rate;
  }

  // rental_items 동기화 (total 모드)
  if (Object.keys(itemPatch).length) {
    const { error: itErr } = await supa
      .from('rental_items')
      .update(itemPatch)
      .eq('id', itemId);
    if (itErr) console.warn('[customers] rental_items 동기화 실패:', itErr.message);
  }

  // rental_assignments 동기화 (split 모드)
  if (Object.keys(asgPatch).length && assignment && assignment.id) {
    const { error: asErr } = await supa
      .from('rental_assignments')
      .update(asgPatch)
      .eq('id', assignment.id);
    if (asErr) console.warn('[customers] assignment 동기화 실패:', asErr.message);
  }
}

function openAssetForm(customer, existing, opts) {
  const tpl = document.getElementById('tpl-asset-form');
  const body = document.getElementById('rc-modal-body');
  body.innerHTML = '';
  body.classList.add('rc-asset-modal-box');
  body.appendChild(tpl.content.cloneNode(true));

  const f = body.querySelector('#asset-form');
  const itemSel = f.item_type;

  // 품목 옵션을 마스터에서 동적 생성 (rental_item_types)
  // - 한 곳(품목 관리 모달)에서 변경 시 모든 모듈 자동 반영
  itemSel.innerHTML = '<option value="">선택</option>'
    + (ITEM_TYPES || [])
        .filter(t => t.active)
        .map(t => `<option value="${escapeAttr(t.label)}">${escapeHtml(t.form_label || t.label)}</option>`)
        .join('');

  // 품목 변경 → print/nas visibility 갱신
  itemSel.addEventListener('change', () => applyAssetVisibility(f));

  // 합계 카운터 체크박스 변경 → 즉시 입력칸 활성/비활성 전환
  const totalCb = body.querySelector('#asset-use-total-counter');
  if (totalCb) {
    totalCb.addEventListener('change', () => applyTotalCounterToggle(f));
  }

  // ── 브랜드/모델 datalist 초기화 ──
  const brandDl = body.querySelector('#dl-brand-presets');
  const modelDl = body.querySelector('#dl-model-presets');
  if (brandDl) {
    // Supabase 캐시 우선, 없으면 fallback 상수
    const brands = _presetsLoaded && _brandList.length
      ? _brandList.map(r => r.value)
      : BRAND_PRESETS;
    brandDl.innerHTML = brands
      .map(b => `<option value="${escapeAttr(b)}">`)
      .join('');
  }
  if (modelDl) {
    updateModelDatalist(modelDl, '');
  }
  // 브랜드 변경 → 모델 datalist 연동
  const brandInput = body.querySelector('#asset-brand-input');
  if (brandInput && modelDl) {
    brandInput.addEventListener('input', () => {
      updateModelDatalist(modelDl, brandInput.value.trim());
    });
    brandInput.addEventListener('change', () => {
      updateModelDatalist(modelDl, brandInput.value.trim());
    });
  }

  if (existing) {
    body.querySelector('#asset-form-title').textContent =
      `자산 수정 — ${(existing.rental_items.model || existing.rental_items.subtype || '')}`;
    const it = existing.rental_items || {};
    // 기존 자산을 9개 품목으로 역분류
    const inferredType = classifyToItemType(it, existing);
    if (inferredType) itemSel.value = inferredType;
    f.brand.value = it.brand || '';
    f.model.value = it.model || '';
    // 기존 브랜드에 맞게 모델 datalist 갱신
    if (modelDl) updateModelDatalist(modelDl, it.brand || '');
    if (f.asset_number) f.asset_number.value = it.asset_number || '';
    f.serial.value = it.serial || '';
    f.install_date.value = (it.install_date || '').slice(0, 10);
    f.status.value = it.status || 'active';
    f.storage_gb.value = it.storage_gb != null ? it.storage_gb : '';
    f.notes.value = it.notes || '';
    if (f.rental_type) f.rental_type.value = it.rental_type || 'paid';
    f.monthly_fee.value = existing.monthly_fee != null ? existing.monthly_fee : '';
    f.bw_free.value = existing.bw_free != null ? existing.bw_free : '';
    f.co_free.value = existing.co_free != null ? existing.co_free : '';
    f.bw_rate.value = existing.bw_rate != null ? existing.bw_rate : '';
    f.co_rate.value = existing.co_rate != null ? existing.co_rate : '';
    f.start_date.value = (existing.start_date || '').slice(0, 10);
    // 합계 카운터 모드 복원 (counter_mode / total_free_count / total_unit_price 는 rental_items 에 저장)
    const counterModeCb = body.querySelector('#asset-use-total-counter');
    if (counterModeCb) {
      counterModeCb.checked = (it.counter_mode === 'total');
    }
    const totalFreeInput = body.querySelector('#asset-total-free-count');
    if (totalFreeInput) {
      totalFreeInput.value = it.total_free_count != null ? it.total_free_count : '';
    }
    const totalUnitInput = body.querySelector('#asset-total-unit-price');
    if (totalUnitInput) {
      totalUnitInput.value = it.total_unit_price != null ? it.total_unit_price : '';
    }
    // 수정 모드: 수량 입력란 표시, 기본값 1, 힌트 문구 교체
    const qtyRow = body.querySelector('#asset-qty-row');
    if (qtyRow) {
      qtyRow.style.display = '';
      f.qty.value = 1;
      const hint = body.querySelector('#asset-qty-hint');
      if (hint) hint.textContent = '(현재 자산 포함, 동일 모델 N대로 적용)';
    }

    // Phase 3: rate 변경 이력 섹션 — 출력기기 수정 모드에서만 활성화
    const rhWrap = body.querySelector('#asset-rate-history-wrap');
    if (rhWrap && existing) {
      // data-show="print" 제어 — applyAssetVisibility 가 print 섹션을 제어하므로
      // 여기서는 item_id 기반으로 이력 로드만 수행
      _bindRateHistorySection(body, existing.item_id, existing);
      // opts.openRateHistory 시 이력 섹션 자동 펼침
      if (opts && opts.openRateHistory) {
        const rhBody  = body.querySelector('#rate-history-body');
        const rhArrow = body.querySelector('#rate-history-arrow');
        if (rhBody)  rhBody.style.display = '';
        if (rhArrow) rhArrow.textContent  = '[접기]';
        setTimeout(() => rhWrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 200);
      }
    }
  } else {
    // 신규 자산 추가: 도입일/임대 시작일 기본값을 오늘로 자동 채움
    // (이전 자산과 구분되도록 추가 시점이 명확히 기록되게)
    const todayStr = new Date().toISOString().slice(0, 10);
    f.status.value = 'active';
    f.install_date.value = todayStr;
    f.start_date.value   = todayStr;
    // 신규 추가 모드: 수량 입력란 표시 (기본값 1)
    const qtyRow = body.querySelector('#asset-qty-row');
    if (qtyRow) { qtyRow.style.display = ''; f.qty.value = 1; }
  }
  applyAssetVisibility(f);

  body.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModal));

  // 프리셋 관리 버튼
  body.querySelector('#btn-manage-brand')?.addEventListener('click', () => openPresetManager('brand'));
  body.querySelector('#btn-manage-model')?.addEventListener('click', () => openPresetManager('model'));

  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = body.querySelector('#asset-form-error');
    const btn = body.querySelector('#asset-form-submit');
    errEl.textContent = '';
    btn.disabled = true;
    btn.textContent = '저장 중…';

    try {
      const itemType = itemSel.value;
      const mapping = ITEM_TO_CATSUB[itemType];
      if (!mapping) throw new Error('품목을 선택하세요.');
      const category = mapping.category;
      const subtype  = mapping.subtype;
      const model = f.model.value.trim();
      if (!model) throw new Error('모델은 필수입니다.');

      // 합계 카운터 모드 여부 (출력기기일 때만 의미 있음)
      const useTotalCounter = f.querySelector
        ? (f.querySelector('#asset-use-total-counter')?.checked || false)
        : false;
      const counterMode = (mapping && mapping.isPrint && useTotalCounter) ? 'total' : 'split';
      const totalFreeCountRaw = f.querySelector ? f.querySelector('#asset-total-free-count') : null;
      const totalFreeCount = (counterMode === 'total' && totalFreeCountRaw && totalFreeCountRaw.value !== '')
        ? Number(totalFreeCountRaw.value)
        : 0;
      const totalUnitPriceRaw = f.querySelector ? f.querySelector('#asset-total-unit-price') : null;
      const totalUnitPrice = (counterMode === 'total' && totalUnitPriceRaw && totalUnitPriceRaw.value !== '')
        ? Number(totalUnitPriceRaw.value)
        : 0;

      const itemPayload = {
        category,
        subtype,
        brand:   f.brand.value.trim() || null,
        model,
        asset_number: (f.asset_number?.value || '').trim() || null,
        serial:  f.serial.value.trim() || null,
        install_date: f.install_date.value || null,
        status:  f.status.value || 'active',
        storage_gb: f.storage_gb.value ? Number(f.storage_gb.value) : null,
        notes:   f.notes.value.trim() || null,
        counter_mode: counterMode,
        total_free_count: totalFreeCount,
        total_unit_price: totalUnitPrice,
        rental_type: f.rental_type ? (f.rental_type.value || 'paid') : 'paid',
      };

      // 무음 학습: 저장 흐름을 막지 않도록 fire-and-forget
      upsertItemPreset(itemPayload.brand, model);

      const assignPayload = {
        start_date:   f.start_date.value || itemPayload.install_date || null,
        monthly_fee:  f.monthly_fee.value ? Number(f.monthly_fee.value) : null,
        bw_free:      f.bw_free.value ? Number(f.bw_free.value) : null,
        co_free:      f.co_free.value ? Number(f.co_free.value) : null,
        bw_rate:      f.bw_rate.value ? Number(f.bw_rate.value) : null,
        co_rate:      f.co_rate.value ? Number(f.co_rate.value) : null,
      };

      const supa = window.totalasAuth;
      if (existing) {
        // 수정 모드: 수량 읽기
        const qty = Math.max(1, Math.min(99, parseInt(f.qty ? f.qty.value : '1', 10) || 1));
        const modelLabel = `${itemPayload.brand ? itemPayload.brand + ' ' : ''}${model}`;

        if (qty > 1) {
          // confirm: 현재 자산 수정 + (qty-1)대 추가
          const ok = window.confirm(
            `현재 자산을 수정하고, 같은 내용으로 ${qty - 1}대를 추가합니다.\n` +
            `(현재 자산 포함 총 ${qty}대)\n\n계속하시겠습니까?`
          );
          if (!ok) {
            btn.disabled = false;
            btn.textContent = '저장';
            return;
          }
        }

        // 현재 자산 UPDATE
        const { error: itErr } = await supa
          .from('rental_items')
          .update(itemPayload)
          .eq('id', existing.item_id);
        if (itErr) throw itErr;
        const { error: asErr } = await supa
          .from('rental_assignments')
          .update(assignPayload)
          .eq('id', existing.id);
        if (asErr) throw asErr;

        // qty > 1: 추가 (qty-1)대 INSERT
        if (qty > 1) {
          const insertedItemIds = [];
          for (let i = 0; i < qty - 1; i++) {
            const ts = (Date.now() + i).toString(36);
            const rnd = Math.random().toString(36).slice(2, 5);
            const itemId = `it_${ts}_${rnd}`;
            const { error: niErr } = await supa
              .from('rental_items')
              .insert({ id: itemId, ...itemPayload });
            if (niErr) {
              for (const rid of insertedItemIds) {
                await supa.from('rental_items').delete().eq('id', rid);
              }
              throw niErr;
            }
            insertedItemIds.push(itemId);

            const ats = (Date.now() + i).toString(36);
            const arnd = Math.random().toString(36).slice(2, 5);
            const aid = `a_${ats}_${arnd}`;
            const { error: naErr } = await supa
              .from('rental_assignments')
              .insert({
                id: aid,
                item_id: itemId,
                customer_id: customer.id,
                ...assignPayload,
              });
            if (naErr) {
              for (const rid of insertedItemIds) {
                await supa.from('rental_items').delete().eq('id', rid);
              }
              throw naErr;
            }
          }

          closeModal();
          const _savedId1 = STATE.selectedId || customer.id;
          await loadAll();
          STATE.selectedId = _savedId1;
          renderList();
          renderDetail();
          let ctSyncMsg = '';
          try {
            ctSyncMsg = await rebuildLatestContractItems(customer.id);
            if (ctSyncMsg) renderDetail();
          } catch (syncErr) {
            console.warn('계약서 동기화 실패:', syncErr.message || syncErr);
            ctSyncMsg = ' (계약서 동기화 실패)';
          }
          toast(`1대 수정 + ${qty - 1}대 추가됨` + ctSyncMsg, 'ok');
          return;
        }
      } else {
        // 신규: 수량(qty)만큼 rental_items + rental_assignments 반복 INSERT
        const qty = Math.max(1, Math.min(99, parseInt(f.qty ? f.qty.value : '1', 10) || 1));
        const modelLabel = `${itemPayload.brand ? itemPayload.brand + ' ' : ''}${model}`;
        if (qty > 1) toast(`${modelLabel} ${qty}대 추가 중…`, 'ok');

        const insertedItemIds = [];
        for (let i = 0; i < qty; i++) {
          // 동일 밀리초 충돌 방지: 루프마다 1ms 후 id 생성
          const ts = (Date.now() + i).toString(36);
          const rnd = Math.random().toString(36).slice(2, 5);
          const itemId = `it_${ts}_${rnd}`;
          const { error: itErr } = await supa
            .from('rental_items')
            .insert({ id: itemId, ...itemPayload });
          if (itErr) throw itErr;
          insertedItemIds.push(itemId);

          const ats = (Date.now() + i).toString(36);
          const arnd = Math.random().toString(36).slice(2, 5);
          const aid = `a_${ats}_${arnd}`;
          const { error: asErr } = await supa
            .from('rental_assignments')
            .insert({
              id: aid,
              item_id: itemId,
              customer_id: customer.id,
              ...assignPayload,
            });
          if (asErr) {
            // 롤백 — 이번 루프의 item + 이전 성공분까지 best-effort 삭제
            for (const rid of insertedItemIds) {
              await supa.from('rental_items').delete().eq('id', rid);
            }
            throw asErr;
          }
        }

        closeModal();
        const _savedId2 = STATE.selectedId || customer.id;
        await loadAll();
        STATE.selectedId = _savedId2;
        renderList();
        renderDetail();
        let ctSyncMsg = '';
        try {
          ctSyncMsg = await rebuildLatestContractItems(customer.id);
          if (ctSyncMsg) renderDetail();
        } catch (syncErr) {
          console.warn('계약서 동기화 실패:', syncErr.message || syncErr);
          ctSyncMsg = ' (계약서 동기화 실패)';
        }
        const doneMsg = qty > 1
          ? `${modelLabel} ${qty}대 추가됨` + ctSyncMsg
          : '자산이 추가되었습니다.' + ctSyncMsg;
        toast(doneMsg, 'ok');
        return; // 아래 공통 toast 중복 방지
      }
      closeModal();
      const _savedId3 = STATE.selectedId || customer.id;
      await loadAll();
      STATE.selectedId = _savedId3;
      renderList();
      renderDetail();
      // 자산 추가/수정 후 — 가장 최근 계약서 items 를 활성 자산 기준으로 재동기화
      let ctSyncMsg = '';
      try {
        ctSyncMsg = await rebuildLatestContractItems(customer.id);
        if (ctSyncMsg) renderDetail();   // 계약서 카드도 새 items 로 다시 그림
      } catch (syncErr) {
        console.warn('계약서 동기화 실패:', syncErr.message || syncErr);
        ctSyncMsg = ' (계약서 동기화 실패)';
      }
      const baseMsg = existing ? '자산이 수정되었습니다.' : '자산이 추가되었습니다.';
      toast(baseMsg + ctSyncMsg, 'ok');
    } catch (err) {
      console.error(err);
      errEl.textContent = err.message || String(err);
      btn.disabled = false;
      btn.textContent = '저장';
    }
  });

  document.getElementById('rc-modal').classList.add('show');
}

// ─────────────────────────────────────────────────────────────
// 가장 최근 계약서의 items 배열을 거래처의 현재 활성 자산으로 재계산
//   - 자산 추가/수정/삭제 후 호출
//   - c._assignments 기준으로 그룹핑(품목·모델·단가·월렌탈료·시작일) 후 update
//   - 호출 전 loadAll() 이 선행되어야 STATE.customers 가 최신
// ─────────────────────────────────────────────────────────────
async function rebuildLatestContractItems(customerId) {
  const supa = window.totalasAuth;
  if (!supa) return '';
  const list = await loadContractsFor(customerId);
  if (!list || !list.length) return '';
  const latest = list[0];

  const cust = STATE.customers.find(c => c.id === customerId);
  const assignments = (cust && cust._assignments) || [];

  // 그룹핑 — renderContractItemsCard 와 동일한 키 (시작일 + 메모 포함)
  const groups = new Map();
  for (const a of assignments) {
    const it = a.rental_items || {};
    const subtype     = it.subtype || '';
    const model       = ((it.brand || '') + ' ' + (it.model || '')).trim();
    const bw_free     = Number(a.bw_free)  || 0;
    const co_free     = Number(a.co_free)  || 0;
    const bw_rate     = Number(a.bw_rate)  || 0;
    const co_rate     = Number(a.co_rate)  || 0;
    const monthly_fee = Number(a.monthly_fee) || 0;
    const start_date  = (a.start_date || it.install_date || '').slice(0, 10);
    const notes       = (it.notes || '').trim();
    const key = [subtype, model, bw_free, co_free, bw_rate, co_rate, monthly_fee, start_date, notes].join('|');
    if (!groups.has(key)) {
      groups.set(key, { subtype, model, bw_free, co_free, bw_rate, co_rate, qty: 0, monthly_fee, note: notes, added_date: start_date });
    }
    groups.get(key).qty++;
  }
  // 시작일 내림차순 → 품목 → 모델
  const items = [...groups.values()].sort((a, b) =>
    (b.added_date || '').localeCompare(a.added_date || '') ||
    (a.subtype    || '').localeCompare(b.subtype    || '', 'ko') ||
    (a.model      || '').localeCompare(b.model      || '', 'ko')
  );

  const { error } = await supa
    .from('rental_contracts')
    .update({ items, updated_at: new Date().toISOString() })
    .eq('id', latest.id);
  if (error) throw error;
  // 캐시 갱신
  latest.items = items;
  CT_STATE.byCustomer[customerId] = list;
  return ` · 계약서 ${latest.contract_no || latest.id} 동기화됨 (${items.length}품목/${assignments.length}대)`;
}

async function deleteAsset(customer, assignment) {
  const it = assignment.rental_items || {};
  const label = (it.model || it.subtype || '자산');
  if (!confirm(`'${label}'을 이 거래처에서 삭제하시겠습니까?\n자산도 함께 삭제됩니다.`)) return;
  try {
    const supa = window.totalasAuth;
    // 1) assignment 삭제
    const { error: aErr } = await supa
      .from('rental_assignments')
      .delete()
      .eq('id', assignment.id);
    if (aErr) throw aErr;
    // 2) item 삭제 (단순화: 함께 삭제)
    if (assignment.item_id) {
      const { error: iErr } = await supa
        .from('rental_items')
        .delete()
        .eq('id', assignment.item_id);
      // item 삭제 실패는 무시하지 않되 토스트만 — assignment는 이미 삭제됨
      if (iErr) console.warn('item 삭제 경고:', iErr.message);
    }
    const _savedIdDel = STATE.selectedId || customer.id;
    await loadAll();
    STATE.selectedId = _savedIdDel;
    renderList();
    renderDetail();
    // 자산 삭제 후 — 가장 최근 계약서 items 를 재동기화 (해당 row 가 빠짐)
    let ctSyncMsg = '';
    try {
      ctSyncMsg = await rebuildLatestContractItems(customer.id);
      if (ctSyncMsg) renderDetail();
    } catch (syncErr) {
      console.warn('계약서 동기화 실패:', syncErr.message || syncErr);
      ctSyncMsg = ' (계약서 동기화 실패)';
    }
    toast('자산이 삭제되었습니다.' + ctSyncMsg, 'ok');
  } catch (err) {
    console.error(err);
    toast('삭제 실패: ' + (err.message || err), 'err');
  }
}

// ─────────────────────────────────────────────────────────────
// 토스트
// ─────────────────────────────────────────────────────────────
let _toastTimer = null;
function toast(msg, kind) {
  const el = document.getElementById('rc-toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'rc-toast show ' + (kind || '');
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    el.classList.remove('show');
  }, 2400);
}

// ─────────────────────────────────────────────────────────────
// 유틸
// ─────────────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, m =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}
function escapeAttr(s) { return escapeHtml(s); }

// =============================================================
// 계약서 (rental_contracts) — 4페이지 디지털 양식
// =============================================================

// 공급자(디직스코리아) 고정 정보
const SUPPLIER_INFO = {
  company: '디직스코리아',
  ceo: '윤일한',
  biz_no: '511-07-80503',
  address: '경상북도 문경시 점촌동 141-9',
  phone: '',
  email: 'yoonxing@naver.com',
};

// 품목 프리셋 (JSON 상수)
const PRESETS = {
  'PC':       { model: '',  bw_free: 0,    co_free: 0,   bw_rate: 0,  co_rate: 0,   qty: 1, monthly_fee: 0,     fixed_quota: true  },
  'monitor':  { model: '',  bw_free: 0,    co_free: 0,   bw_rate: 0,  co_rate: 0,   qty: 1, monthly_fee: 0,     fixed_quota: true  },
  '잉크젯':   { model: '',  bw_free: 500,  co_free: 200, bw_rate: 10, co_rate: 100, qty: 1, monthly_fee: 0,     install_fee: 0      },
  '레이저':   { model: '',  bw_free: 1000, co_free: 0,   bw_rate: 15, co_rate: 0,   qty: 1, monthly_fee: 0,     install_fee: 100000, removal_fee: 100000, reg_fee: 200000 },
  '복합기':   { model: '',  bw_free: 1500, co_free: 500, bw_rate: 15, co_rate: 100, qty: 1, monthly_fee: 0,     install_fee: 100000, removal_fee: 100000, reg_fee: 200000 },
  '웰리스':   { model: '',  bw_free: 0,    co_free: 0,   bw_rate: 0,  co_rate: 0,   qty: 1, monthly_fee: 0,     filter_cycle_months: 2, fixed_quota: true },
  'NAS':      { model: '',  bw_free: 0,    co_free: 0,   bw_rate: 0,  co_rate: 0,   qty: 1, monthly_fee: 0,     fixed_quota: true  },
};

// 기본 약관 (제1~10조) — 디직스코리아 임대 표준약관
const DEFAULT_TERMS = [
  {
    article: 1, title: '계약의 목적',
    body: '임대인 디직스코리아(이하 "을")은 임차인(이하 "갑")에게 본 계약서에 명시된 임대 물품(이하 "물품")을 임대하고, 갑은 이를 임차하여 사용한다.',
    confirmed: true,
  },
  {
    article: 2, title: '계약기간 및 갱신',
    body: '1. 계약기간은 본 계약서 표지에 명시된 기간으로 한다.\n2. 기간 만료 1개월 전까지 양 당사자 어느 일방의 서면 해지 의사 표시가 없으면 동일 조건으로 1년씩 자동 갱신된다.',
    confirmed: true,
  },
  {
    article: 3, title: '인도 및 설치',
    body: '1. 을은 갑이 지정한 장소에 물품을 설치한다.\n2. 설치비 및 철거비 부과 기준:\n   - 잉크젯: 무료\n   - 레이저·디지털복합기: 설치비 100,000원, 철거비 100,000원, 등록비 200,000원\n   - PC·모니터·웰리스·NAS: 설치비 무료 (출장비 별도)\n3. 설치 후 양 당사자가 함께 점검하며 갑은 인수 확인서에 서명한다.',
    confirmed: true,
  },
  {
    article: 4, title: '사용 및 관리',
    body: '1. 갑은 본 물품을 임대 목적 외에 사용하거나 제3자에게 양도·전대·담보 제공할 수 없다.\n2. 갑은 선량한 관리자의 주의로 물품을 사용·보관해야 한다.\n3. 갑의 고의 또는 중과실로 인한 손상은 갑이 수리비를 부담한다.',
    confirmed: true,
  },
  {
    article: 5, title: '소모품 및 유지보수',
    body: '1. 토너·잉크·부속품 등 정상 사용 시 발생하는 소모품은 을이 무상 공급한다.\n2. 정기 점검은 을의 일정에 따라 주기적으로 시행한다.\n3. 고장 신고 시 영업일 기준 24시간 이내 출장·수리한다. 단, 갑의 부주의 또는 불법 사용으로 인한 고장은 갑이 비용을 부담한다.',
    confirmed: true,
  },
  {
    article: 6, title: '월 임대료 지급',
    body: '1. 갑은 매월 자동이체 약정일에 본 계약서 표지의 월 임대료(VAT 포함)를 을의 지정 계좌로 납부한다.\n2. 추가 매수 발생 시 추가 단가에 따라 다음 달 임대료에 합산하여 청구한다.\n3. 자동이체 실패 시 갑은 7일 이내 직접 납부하며, 이를 초과할 경우 연 20%의 연체이자가 가산된다.',
    confirmed: true,
  },
  {
    article: 7, title: '보증금',
    body: '1. 보증금은 월 임대료의 2개월치를 기준으로 한다.\n2. 보증금은 계약 해지 시 미수금 및 손해배상을 차감한 후 반환한다.',
    confirmed: true,
  },
  {
    article: 8, title: '계약 해지',
    body: '1. 다음 사유 발생 시 을은 사전 통보 없이 계약을 해지할 수 있다.\n   - 월 임대료 3개월 이상 미납\n   - 임대 물품의 무단 양도·전대·담보 제공\n   - 임차인의 파산·해산·영업 중단\n2. 갑이 약정 기간 내 일방 해지 시 잔여 기간의 50%에 해당하는 위약금을 부담한다.',
    confirmed: true,
  },
  {
    article: 9, title: '손해배상',
    body: '1. 갑의 고의 또는 중과실로 인한 물품 손상·분실 시 갑이 시가로 변상한다.\n2. 천재지변·화재 등 불가항력으로 인한 손상은 양 당사자가 협의한다.',
    confirmed: true,
  },
  {
    article: 10, title: '분쟁의 해결',
    body: '1. 본 계약과 관련하여 발생하는 분쟁은 양 당사자가 협의로 해결한다.\n2. 협의가 이루어지지 않을 경우 을(임대인)의 주소지를 관할하는 법원을 1심 관할 법원으로 한다.',
    confirmed: true,
  },
];

const DEFAULT_EXTRAS = [
  { text: '카운터 점검 후 발생한 추가 요금은 다음 달 자동이체로 합산 청구된다.', confirmed: true },
  { text: '사업장 이전 시 30일 전 서면 통보하며, 이전 설치비 100,000원은 갑이 부담한다.', confirmed: true },
  { text: '임대 기간 중 모델 교체가 필요한 경우 양 당사자 협의로 처리한다.', confirmed: true },
  { text: '계약 종료 시 갑은 물품을 원상태로 반납하며, 정상 반납 확인 후 보증금이 반환된다.', confirmed: true },
  { text: '본 계약서에 명시되지 않은 사항은 일반 상관례 및 디직스코리아 임대 표준약관에 따른다.', confirmed: true },
];

// 편집 중인 계약서 상태
const CT_STATE = {
  customer: null,
  contract: null,        // 현재 편집 객체
  signaturePads: {},     // { supplier: SignaturePad, applicant: SignaturePad }
  byCustomer: {},        // { customer_id: [contracts...] }
};

function newContractDraft(customer) {
  const id = `ct_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const today = new Date();
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const start = ymd(today);
  const end = new Date(today.getFullYear() + 3, today.getMonth(), today.getDate());
  // 신규 거래처(customer===null)일 때 — 전체 계약서 수 기반 sequence
  const seq = customer
    ? String((CT_STATE.byCustomer[customer.id] || []).length + 1).padStart(2, '0')
    : '01';
  return {
    id,
    customer_id: customer ? customer.id : null,
    contract_no: `${today.getFullYear()}-${seq}`,
    contract_date: ymd(today),
    period_years: 3,
    period_start: start,
    period_end: ymd(end),
    deposit: 0,
    install_fee: 0,
    company_snapshot:      customer ? (customer.company || '') : '',
    contact_name_snapshot: customer ? (customer.contact_name || '') : '',
    biz_no_snapshot:       customer ? (customer.biz_no || '') : '',
    address_snapshot:      customer ? (customer.address || '') : '',
    phone_snapshot:        customer ? (customer.phone || customer.mobile || '') : '',
    email_snapshot:        customer ? (customer.email || '') : '',
    items: [],
    terms:  JSON.parse(JSON.stringify(DEFAULT_TERMS)),
    extras: JSON.parse(JSON.stringify(DEFAULT_EXTRAS)),
    special_terms: '',
    payment_method: 'account',
    payment_info: {
      account: { bank: '', account_no: '', holder: '', biz_no: customer ? (customer.biz_no || '') : '', draft_day: 25 },
      card:    { card_brand: '', card_no: '', expiry: '', holder: '', draft_day: 25 },
    },
    sign_supplier: '',
    sign_applicant: '',
    signature_type: 'digital',   // 'digital' | 'stamp' | 'none'
    contract_scan_path: '',      // Supabase storage path (도장 모드 — 계약서 스캔본)
    id_card_path: '',            // Supabase storage path (도장 모드 — 신분증 사진)
    signed_at: null,
    status: 'draft',
    notes: '',
  };
}

// 자동 계산 ─────────────────────────────────────────────
function calcRowTotal(row) {
  return (Number(row.qty) || 0) * (Number(row.monthly_fee) || 0);
}
function calcGrand(items) {
  const sub = items.reduce((s, r) => s + calcRowTotal(r), 0);
  const vat = Math.round(sub * 0.1);
  return { sub, vat, total: sub + vat };
}
function suggestDeposit(items) {
  const sub = items.reduce((s, r) => s + calcRowTotal(r), 0);
  return sub * 2;
}

// 계약서 목록 로드 (특정 거래처) ────────────────────────
async function loadContractsFor(customerId) {
  const supa = window.totalasAuth;
  if (!supa) return [];
  try {
    const { data, error } = await supa
      .from('rental_contracts')
      .select('*')
      .eq('customer_id', customerId)
      .order('contract_date', { ascending: false });
    if (error) throw error;
    CT_STATE.byCustomer[customerId] = data || [];
    return data || [];
  } catch (err) {
    console.warn('계약서 로드 실패:', err.message || err);
    CT_STATE.byCustomer[customerId] = [];
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// 임대 계약 내역 카드 — 임대 물품 내역(rental_assignments) 기준으로 표시
// 같은 (품목·모델·기본/추가 단가·월렌탈료) 조합으로 그룹핑하여 수량을 집계
// ─────────────────────────────────────────────────────────────
function renderContractItemsCard(customer) {
  const assignments = customer._assignments || [];
  if (!assignments.length) {
    return `<div class="card">
      <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:8px;">
        <h3 style="margin:0; flex:1; min-width:0;">📋 임대 계약 내역 <span class="muted-small" style="font-weight:400;">0건</span></h3>
        <button class="btn ghost small" id="btn-print-contract" disabled title="등록된 자산이 없습니다" style="opacity:.45;cursor:not-allowed;">📄 계약서 출력</button>
      </div>
      <p class="muted" style="margin:0; font-size:12.5px;">등록된 임대 물품이 없습니다. 위 "+ 임대추가"로 자산을 등록하세요.</p>
    </div>`;
  }

  // 그룹핑 키: 품목(정규화) + 모델 + 카운터모드 + 통합/분리 단가 + 월렌탈료 + 메모
  // 메모가 다른 자산은 별도 행으로 분리. counter_mode='total' 인 자산은 통합으로 표시.
  const groups = new Map();
  for (const a of assignments) {
    const it = a.rental_items || {};
    const subtype          = normalizeSubtype(it.subtype || '');
    const model            = ((it.brand || '') + ' ' + (it.model || '')).trim();
    const counter_mode     = (it.counter_mode === 'total') ? 'total' : 'split';
    const total_free_count = Number(it.total_free_count) || 0;
    const total_unit_price = Number(it.total_unit_price) || 0;
    const bw_free          = Number(a.bw_free)  || 0;
    const co_free          = Number(a.co_free)  || 0;
    const bw_rate          = Number(a.bw_rate)  || 0;
    const co_rate          = Number(a.co_rate)  || 0;
    const monthly_fee      = Number(a.monthly_fee) || 0;
    const start_date       = (a.start_date || it.install_date || '').slice(0, 10);
    const notes            = (it.notes || '').trim();
    const key = [subtype, model, counter_mode, total_free_count, total_unit_price,
                 bw_free, co_free, bw_rate, co_rate, monthly_fee, start_date, notes].join('|');
    if (!groups.has(key)) {
      groups.set(key, {
        subtype, model, counter_mode, total_free_count, total_unit_price,
        bw_free, co_free, bw_rate, co_rate, monthly_fee, start_date, notes, qty: 0
      });
    }
    groups.get(key).qty++;
  }

  // 시작일 내림차순(최신 추가가 위로) → 품목 → 모델
  const list = [...groups.values()].sort((a, b) =>
    (b.start_date || '').localeCompare(a.start_date || '') ||
    (a.subtype    || '').localeCompare(b.subtype    || '', 'ko') ||
    (a.model      || '').localeCompare(b.model      || '', 'ko')
  );

  const totalMonthly = list.reduce((s, g) => s + (g.monthly_fee * g.qty), 0);

  const rows = list.map((g, i) => {
    const memoHtml = g.notes
      ? `<div style="font-size:10.5px;color:var(--muted);margin-top:2px;">📝 ${escapeHtml(g.notes)}</div>`
      : '';
    const isTotal = g.counter_mode === 'total';
    const totalBadge = isTotal
      ? ` <span style="display:inline-block;padding:1px 5px;background:#1e40af;color:#fff;border-radius:3px;font-size:9.5px;vertical-align:middle;">통합</span>`
      : '';
    const countCells = isTotal
      ? `<td class="num" colspan="2" style="background:#eff6ff;">통합 ${g.total_free_count.toLocaleString()}장</td>`
      : `<td class="num">${g.bw_free.toLocaleString()}</td><td class="num">${g.co_free.toLocaleString()}</td>`;
    const rateCells = isTotal
      ? `<td class="num" colspan="2" style="background:#eff6ff;">${g.total_unit_price.toLocaleString()}원/장</td>`
      : `<td class="num">${g.bw_rate.toLocaleString()}</td><td class="num">${g.co_rate.toLocaleString()}</td>`;
    return `
    <tr>
      <td>${i + 1}</td>
      <td class="muted-small">${escapeHtml(g.start_date || '–')}</td>
      <td>${escapeHtml(g.subtype || '–')}</td>
      <td>${escapeHtml(g.model   || '–')}${totalBadge}${memoHtml}</td>
      ${countCells}
      ${rateCells}
      <td class="num">${g.qty}</td>
      <td class="num"><strong>${g.monthly_fee.toLocaleString()}</strong></td>
    </tr>`;
  }).join('');

  return `<div class="card">
    <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:8px;">
      <h3 style="margin:0; flex:1; min-width:0;">📋 임대 계약 내역
        <span class="muted-small" style="font-weight:400;">${list.length}품목 · ${assignments.length}대 · 월 ${totalMonthly.toLocaleString()}원 (VAT별도)</span>
      </h3>
      <button class="btn ghost small" id="btn-print-contract" title="현재 임대 물품 내역을 계약서 폼에 채워서 출력합니다.">📄 계약서 출력</button>
    </div>
    <div class="rc-contract-items-wrap" style="overflow-x:auto;">
      <table class="rc-asset-table" style="font-size:11.5px;">
        <thead>
          <tr>
            <th style="width:4%;">#</th>
            <th style="width:9%;">시작일</th>
            <th style="width:12%;">품목</th>
            <th>모델</th>
            <th class="num" style="width:8%;">기본(흑)</th>
            <th class="num" style="width:8%;">기본(컬)</th>
            <th class="num" style="width:8%;">추가(흑)</th>
            <th class="num" style="width:8%;">추가(컬)</th>
            <th class="num" style="width:6%;">수량</th>
            <th class="num" style="width:10%;">월렌탈료</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>`;
}

// ─────────────────────────────────────────────────────────────
// 카운터 12개월 카드 — 거래처 자산의 "월별 사용량" (가로 레이아웃)
//   - 데이터 소스: STATE.countersByItem (rental_counters; 누적 odometer 값)
//   - 월별 사용량 = 이번 달 누적 - 직전 달 누적 (음수면 자산 교체로 간주 → 0)
//   - 범위: 이번 달 기준 최근 12개월
//   - 레이아웃: 월이 열 헤더 (YY/MM), 행은 흑백/컬러 2줄 + 합계 열
// ─────────────────────────────────────────────────────────────
function renderCounters12mCard(customer) {
  const assignments = customer._assignments || [];
  const itemIds = assignments.map(a => a.item_id).filter(Boolean);

  if (!itemIds.length) {
    return `<div class="card">
      <h3 style="margin:0 0 8px;">📊 카운터 — 최근 12개월 (월별 사용량)</h3>
      <p class="muted" style="margin:0; font-size:12.5px;">등록된 자산이 없어 카운터를 표시할 수 없습니다.</p>
    </div>`;
  }

  // 최근 12개월 ym 목록 (오래된 → 최신)
  const now = new Date();
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const ym  = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const lbl = `${String(d.getFullYear()).slice(2)}/${String(d.getMonth() + 1).padStart(2, '0')}`;
    months.push({ ym, lbl, bw: 0, color: 0 });
  }
  const idx = new Map(months.map((m, i) => [m.ym, i]));

  let dataPoints = 0;
  for (const itemId of itemIds) {
    const counters = (STATE.countersByItem && STATE.countersByItem[itemId]) || [];
    // 시간순(ym 오름차순) 정렬 — 직전 달과 차감용
    const sorted = counters.slice().sort((a, b) => (a.ym || '').localeCompare(b.ym || ''));
    for (let i = 0; i < sorted.length; i++) {
      const cur = sorted[i];
      if (!idx.has(cur.ym)) continue;                  // 12개월 윈도우 밖이면 합산 X
      const prev = i > 0 ? sorted[i - 1] : null;       // 직전 달 — 윈도우 밖이어도 사용 가능
      // 첫 데이터 달은 delta 계산 불가 → 0 처리
      // 음수(자산 교체/리셋)도 0 처리
      const dbw    = prev ? Math.max(0, (Number(cur.bw)    || 0) - (Number(prev.bw)    || 0)) : 0;
      const dcolor = prev ? Math.max(0, (Number(cur.color) || 0) - (Number(prev.color) || 0)) : 0;
      const m = months[idx.get(cur.ym)];
      m.bw    += dbw;
      m.color += dcolor;
      if (prev) dataPoints++;
    }
  }

  const totalBw    = months.reduce((s, m) => s + m.bw,    0);
  const totalColor = months.reduce((s, m) => s + m.color, 0);
  const grandTotal = totalBw + totalColor;

  const headCells  = months.map(m => `<th class="num">${m.lbl}</th>`).join('');
  const bwCells    = months.map(m => `<td class="num"${m.bw    === 0 ? ' style="color:#cbd5e1;"' : ''}>${m.bw.toLocaleString()}</td>`).join('');
  const coCells    = months.map(m => `<td class="num"${m.color === 0 ? ' style="color:#cbd5e1;"' : ''}>${m.color.toLocaleString()}</td>`).join('');
  const sumCells   = months.map(m => {
    const s = m.bw + m.color;
    return `<td class="num" style="background:#f8fafc;${s === 0 ? ' color:#cbd5e1;' : ' font-weight:600;'}">${s.toLocaleString()}</td>`;
  }).join('');

  const emptyNote = dataPoints === 0
    ? '<p class="muted" style="margin:8px 0 0; font-size:11.5px;">⚠ 이 거래처 자산에 카운터 데이터가 없습니다.</p>'
    : '';

  return `<div class="card">
    <h3 style="margin:0 0 8px;">📊 카운터 — 최근 12개월 <span class="muted-small" style="font-weight:400;">(월별 사용량 · 누적 차감)</span>
      <span class="muted-small" style="font-weight:400; margin-left:8px;">
        흑백 ${totalBw.toLocaleString()} · 컬러 ${totalColor.toLocaleString()} · 합계 ${grandTotal.toLocaleString()}
      </span>
    </h3>
    <div class="rc-counter-12m-wrap" style="overflow-x:auto;">
      <table class="rc-asset-table" style="font-size:11.5px; white-space:nowrap;">
        <thead>
          <tr>
            <th style="text-align:left;">흑백 / 컬러</th>
            ${headCells}
            <th class="num" style="background:#eef2ff;">합계</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style="font-weight:600;">흑백</td>
            ${bwCells}
            <td class="num" style="background:#f1f5f9;"><strong>${totalBw.toLocaleString()}</strong></td>
          </tr>
          <tr>
            <td style="font-weight:600;">컬러</td>
            ${coCells}
            <td class="num" style="background:#f1f5f9;"><strong>${totalColor.toLocaleString()}</strong></td>
          </tr>
        </tbody>
        <tfoot>
          <tr style="border-top:2px solid #e2e8f0;">
            <td style="font-weight:700; font-size:12px;">합계</td>
            ${sumCells}
            <td class="num" style="background:#eef2ff; font-weight:700;">${grandTotal.toLocaleString()}</td>
          </tr>
        </tfoot>
      </table>
    </div>
    ${emptyNote}
  </div>`;
}

// =============================================================
// 거래처 문서 (rental_customer_documents) — 도장계약서 / 신분증·사업자사본 / 통장사본·CMS신청서
// =============================================================

const DOC_STATE = {
  byCustomer: {},   // { customer_id: [docs...] }
  uploading: {},    // { customer_id_kind: true }
};

const DOC_KINDS = {
  contract_stamped: { label: '도장찍은 계약서', icon: '📜', accept: 'image/jpeg,image/png,image/webp,application/pdf', hint: 'PDF / JPG / PNG' },
  id_card:          { label: '신분증/사업자사본',  icon: '🪪', accept: 'image/jpeg,image/png,image/webp,application/pdf', hint: 'JPG / PNG / PDF' },
  bankbook:         { label: '통장사본/CMS신청서', icon: '💳', accept: 'image/jpeg,image/png,image/webp,application/pdf', hint: 'JPG / PNG / PDF' },
};

const DOC_BUCKET = 'customer-documents';

async function loadDocsFor(customerId) {
  const supa = window.totalasAuth;
  if (!supa) return [];
  try {
    const { data, error } = await supa
      .from('rental_customer_documents')
      .select('*')
      .eq('customer_id', customerId)
      .order('uploaded_at', { ascending: false });
    if (error) throw error;
    DOC_STATE.byCustomer[customerId] = data || [];
    return data || [];
  } catch (err) {
    console.warn('문서 로드 실패:', err.message || err);
    DOC_STATE.byCustomer[customerId] = [];
    return [];
  }
}

// 파일 업로드 — Storage + DB insert
async function uploadCustomerDoc(customerId, kind, file) {
  const supa = window.totalasAuth;
  if (!supa) throw new Error('인증 없음');
  const ext = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
  const ts  = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 6);
  const storagePath = `${customerId}/${kind}_${ts}_${rnd}.${ext}`;
  // Storage upload
  const { error: upErr } = await supa.storage
    .from(DOC_BUCKET)
    .upload(storagePath, file, { upsert: false, contentType: file.type });
  if (upErr) throw upErr;
  // DB insert
  const docId = `doc_${ts}_${rnd}`;
  const { error: insErr } = await supa
    .from('rental_customer_documents')
    .insert({
      id: docId,
      customer_id: customerId,
      kind,
      storage_path: storagePath,
      file_name: file.name,
      mime_type: file.type || null,
      size_bytes: file.size || null,
    });
  if (insErr) {
    // DB 실패 시 Storage 파일도 정리
    await supa.storage.from(DOC_BUCKET).remove([storagePath]).catch(() => {});
    throw insErr;
  }
  await loadDocsFor(customerId);
}

// 문서 다운로드 — 60초 signed URL
async function downloadCustomerDoc(doc) {
  const supa = window.totalasAuth;
  if (!supa) return;
  try {
    const { data, error } = await supa.storage
      .from(DOC_BUCKET)
      .createSignedUrl(doc.storage_path, 60);
    if (error) throw error;
    const a = document.createElement('a');
    a.href = data.signedUrl;
    a.download = doc.file_name || 'document';
    a.target = '_blank';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } catch (err) {
    toast('다운로드 실패: ' + (err.message || err), 'err');
  }
}

// 문서 삭제
async function deleteCustomerDoc(doc) {
  if (!confirm(`'${doc.file_name}' 파일을 삭제하시겠습니까?`)) return;
  const supa = window.totalasAuth;
  if (!supa) return;
  try {
    await supa.storage.from(DOC_BUCKET).remove([doc.storage_path]);
    const { error } = await supa.from('rental_customer_documents').delete().eq('id', doc.id);
    if (error) throw error;
    await loadDocsFor(doc.customer_id);
    renderDetail();
    toast('파일이 삭제되었습니다.', 'ok');
  } catch (err) {
    toast('삭제 실패: ' + (err.message || err), 'err');
  }
}

function fmtBytes(n) {
  if (!n) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

// 거래처 문서 카드 렌더
function renderCustomerDocsCard(customer) {
  const docs  = DOC_STATE.byCustomer[customer.id];
  const loaded = Array.isArray(docs);

  const slotsHtml = Object.entries(DOC_KINDS).map(([kind, meta]) => {
    const kindDocs = loaded ? docs.filter(d => d.kind === kind) : [];
    const uploadKey = customer.id + '_' + kind;
    const isUploading = DOC_STATE.uploading[uploadKey];

    const fileListHtml = kindDocs.map(d => {
      const isImage = d.mime_type && d.mime_type.startsWith('image/');
      const previewHtml = isImage
        ? `<span style="font-size:14px; margin-right:4px;">🖼</span>`
        : `<span style="font-size:14px; margin-right:4px;">📄</span>`;
      return `
        <div class="rc-doc-file-row" data-docid="${escapeAttr(d.id)}">
          ${previewHtml}
          <span class="rc-doc-filename" title="${escapeAttr(d.file_name)}">${escapeHtml(d.file_name)}</span>
          <span class="rc-doc-meta">${escapeHtml((d.uploaded_at || '').slice(0, 10))} ${d.size_bytes ? '· ' + fmtBytes(d.size_bytes) : ''}</span>
          <button class="rc-icon-btn rc-doc-dl" data-docid="${escapeAttr(d.id)}" title="다운로드">⬇</button>
          <button class="rc-icon-btn danger rc-doc-del" data-docid="${escapeAttr(d.id)}" title="삭제">🗑</button>
        </div>
      `;
    }).join('');

    return `
      <div class="rc-doc-slot" data-kind="${escapeAttr(kind)}" data-cid="${escapeAttr(customer.id)}">
        <div class="rc-doc-slot-head">
          <span class="rc-doc-slot-icon">${meta.icon}</span>
          <span class="rc-doc-slot-label">${meta.label}</span>
          <span class="rc-doc-slot-hint">${meta.hint}</span>
          ${kindDocs.length > 0 ? `<span class="rc-doc-count">${kindDocs.length}개</span>` : ''}
        </div>
        ${fileListHtml}
        <label class="rc-doc-upload-label ${isUploading ? 'uploading' : ''}"
               for="doc-upload-${escapeAttr(kind)}-${escapeAttr(customer.id)}"
               title="클릭하거나 파일을 여기에 드래그">
          ${isUploading ? '업로드 중…' : '+ 파일 선택 / 드래그'}
        </label>
        <input type="file" id="doc-upload-${escapeAttr(kind)}-${escapeAttr(customer.id)}"
               class="rc-doc-file-input"
               accept="${escapeAttr(meta.accept)}"
               multiple
               data-kind="${escapeAttr(kind)}"
               data-cid="${escapeAttr(customer.id)}"
               style="display:none;">
      </div>
    `;
  }).join('');

  const loadingNote = !loaded
    ? '<p class="muted" style="font-size:12px; margin:0 0 8px;">문서 로딩 중…</p>'
    : '';

  return `
    <div class="card rc-docs-card" data-cid="${escapeAttr(customer.id)}">
      <h3 style="margin:0 0 10px;">📂 거래처 문서</h3>
      ${loadingNote}
      <div class="rc-doc-slots">
        ${slotsHtml}
      </div>
    </div>
  `;
}

// 거래처 문서 카드 이벤트 바인딩
function bindDocsCard(c) {
  const card = document.querySelector('.rc-docs-card[data-cid="' + c.id + '"]');
  if (!card) return;

  // 파일 input change
  card.querySelectorAll('.rc-doc-file-input').forEach(inp => {
    inp.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      const kind = inp.dataset.kind;
      const cid  = inp.dataset.cid;
      const uploadKey = cid + '_' + kind;
      DOC_STATE.uploading[uploadKey] = true;
      renderDetail();
      try {
        for (const f of files) {
          await uploadCustomerDoc(cid, kind, f);
        }
        toast(`${files.length}개 파일이 업로드되었습니다.`, 'ok');
      } catch (err) {
        toast('업로드 실패: ' + (err.message || err), 'err');
      } finally {
        DOC_STATE.uploading[uploadKey] = false;
        renderDetail();
      }
    });
  });

  // 드래그앤드롭
  card.querySelectorAll('.rc-doc-upload-label').forEach(label => {
    label.addEventListener('dragover', (e) => { e.preventDefault(); label.classList.add('drag-over'); });
    label.addEventListener('dragleave', () => { label.classList.remove('drag-over'); });
    label.addEventListener('drop', async (e) => {
      e.preventDefault();
      label.classList.remove('drag-over');
      const slot = label.closest('.rc-doc-slot');
      if (!slot) return;
      const kind = slot.dataset.kind;
      const cid  = slot.dataset.cid;
      const files = Array.from(e.dataTransfer.files || []);
      if (!files.length) return;
      const uploadKey = cid + '_' + kind;
      DOC_STATE.uploading[uploadKey] = true;
      renderDetail();
      try {
        for (const f of files) {
          await uploadCustomerDoc(cid, kind, f);
        }
        toast(`${files.length}개 파일이 업로드되었습니다.`, 'ok');
      } catch (err) {
        toast('업로드 실패: ' + (err.message || err), 'err');
      } finally {
        DOC_STATE.uploading[uploadKey] = false;
        renderDetail();
      }
    });
  });

  // 다운로드 버튼
  card.querySelectorAll('.rc-doc-dl').forEach(btn => {
    btn.addEventListener('click', () => {
      const docId = btn.dataset.docid;
      const allDocs = DOC_STATE.byCustomer[c.id] || [];
      const doc = allDocs.find(d => d.id === docId);
      if (doc) downloadCustomerDoc(doc);
    });
  });

  // 삭제 버튼
  card.querySelectorAll('.rc-doc-del').forEach(btn => {
    btn.addEventListener('click', () => {
      const docId = btn.dataset.docid;
      const allDocs = DOC_STATE.byCustomer[c.id] || [];
      const doc = allDocs.find(d => d.id === docId);
      if (doc) deleteCustomerDoc(doc);
    });
  });
}

// 계약서 카드 렌더 (우측 상세 패널) ─────────────────────
function renderContractCard(customer) {
  const list = CT_STATE.byCustomer[customer.id] || [];
  const rows = list.map(ct => {
    const status = (ct.status || 'draft').toLowerCase();
    const statusLabel = ({
      'draft':      '작성중',
      'signed':     '서명완료',
      'active':     '진행중',
      'terminated': '해지',
    })[status] || status;
    const items = Array.isArray(ct.items) ? ct.items : [];
    const grand = calcGrand(items);
    return `
      <div class="rc-ct-row" data-ctid="${escapeAttr(ct.id)}" style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
        <div class="rc-ct-row-main" style="flex:1; min-width:200px;">
          <div class="rc-ct-row-title">${escapeHtml(ct.contract_no || '-')} · ${escapeHtml(ct.contract_date || '-')}</div>
          <div class="rc-ct-row-sub">
            품목 ${items.length}건 · 월 합계 ${grand.total.toLocaleString()}원 (VAT포함)
            ${ct.period_start && ct.period_end ? ` · ${ct.period_start} ~ ${ct.period_end}` : ''}
          </div>
        </div>
        <span class="rc-ct-badge ${status}">${statusLabel}</span>
        <div style="display:flex; gap:4px;">
          <button class="btn small ghost" data-ctact="print"  data-ctid="${escapeAttr(ct.id)}" title="임대계약서 창에서 인쇄">🖨 인쇄</button>
          <button class="btn small ghost" data-ctact="edit"   data-ctid="${escapeAttr(ct.id)}" title="수정 — 저장하면 새 버전이 생성됩니다 (이전 계약서 보존)">✏ 수정</button>
          <button class="btn small danger" data-ctact="delete" data-ctid="${escapeAttr(ct.id)}" title="이 계약서 삭제">🗑 삭제</button>
        </div>
      </div>
    `;
  }).join('') || `<p class="muted" style="margin:0; font-size:12.5px;">아직 작성된 계약서가 없습니다.</p>`;

  const hasContracts = list.length > 0;
  return `
    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:8px;">
        <h3 style="margin:0;">📄 계약서 <span class="muted-small" style="font-weight:400;">${list.length}건</span></h3>
        <button class="btn small primary" id="btn-ct-print-latest" ${hasContracts ? '' : 'disabled'}
                title="${hasContracts ? '가장 최근 계약서를 임대계약서 창에서 자동 인쇄' : '저장된 계약서가 없습니다'}">
          🖨 기존 계약서 출력
        </button>
      </div>
      ${rows}
    </div>
  `;
}

// 계약서 에디터 열기 ────────────────────────────────────
// customer=null 이면 "신규 거래처와 함께 작성" 흐름
function openContractEditor(customer, existing) {
  CT_STATE.customer = customer;           // null 허용
  CT_STATE.isNewCustomer = !customer;     // 신규 거래처 흐름 플래그
  CT_STATE.contract = existing
    ? JSON.parse(JSON.stringify(existing))   // 깊은 복사 (수정 취소 가능하게)
    : newContractDraft(customer);
  CT_STATE.signaturePads = {};

  document.getElementById('ct-edit-backdrop').classList.add('show');
  renderContractEditor();
}

function closeContractEditor() {
  document.getElementById('ct-edit-backdrop').classList.remove('show');
  // 캔버스 정리
  CT_STATE.signaturePads = {};
  CT_STATE.contract = null;
  CT_STATE.isNewCustomer = false;
}

// 계약서 에디터 렌더 (헤더 + 4페이지) ──────────────────
function renderContractEditor() {
  const ct = CT_STATE.contract;
  const cu = CT_STATE.customer;  // null 허용 (신규 거래처 흐름)
  if (!ct) return;

  const head = document.getElementById('ct-edit-head');
  const body = document.getElementById('ct-edit-body');

  // ── 헤더 ──────────────────
  const statusLabel = ({
    'draft': '작성중', 'signed': '서명완료', 'active': '진행중', 'terminated': '해지',
  })[ct.status] || ct.status;
  const headerCompany = cu
    ? (cu.company || '-')
    : (ct.company_snapshot || '(신규 거래처)');
  head.innerHTML = `
    <div class="ct-h-left">
      <div class="ct-h-title">
        ${escapeHtml(headerCompany)}
        ${CT_STATE.isNewCustomer ? '<span class="rc-ct-badge" style="background:#fef3c7;color:#92400e;margin-left:8px;">신규</span>' : ''}
        <span class="rc-ct-badge ${escapeAttr(ct.status)}" style="margin-left:8px;">${escapeHtml(statusLabel)}</span>
      </div>
      <div class="ct-h-meta">계약번호 ${escapeHtml(ct.contract_no)} · 작성 ${escapeHtml(ct.contract_date)}</div>
    </div>
    <div class="ct-h-actions">
      <select id="ct-h-status" title="상태">
        <option value="draft"     ${ct.status === 'draft'      ? 'selected' : ''}>작성중</option>
        <option value="signed"    ${ct.status === 'signed'     ? 'selected' : ''}>서명완료</option>
        <option value="active"    ${ct.status === 'active'     ? 'selected' : ''}>진행중</option>
        <option value="terminated"${ct.status === 'terminated' ? 'selected' : ''}>해지</option>
      </select>
      <button class="btn small" id="ct-btn-print" title="계약서·약관 2매 + 자동이체 1매 = 총 7페이지">🖨 인쇄 (7매)</button>
      <button class="btn small primary" id="ct-btn-save">💾 저장</button>
      ${ct._existing ? `<button class="btn small danger" id="ct-btn-delete">🗑 삭제</button>` : ''}
      <button class="btn small ghost" id="ct-btn-close">✕ 닫기</button>
    </div>
    <div style="flex-basis:100%; font-size:11px; color:#64748b; margin-top:2px;">
      🖨 인쇄 → 계약서·약관 갑·을 2매 + 자동이체 1매 = 총 7페이지
    </div>
  `;

  // ── 본문: 4 페이지 ───────
  const newCustomerBanner = CT_STATE.isNewCustomer ? `
    <div class="ct-new-customer-banner no-print">
      <strong>신규 거래처입니다.</strong>
      회사명·담당자·사업자번호·주소 등을 페이지 1의 "임차인" 박스에 입력하세요.
      저장 시 거래처가 자동으로 등록되며, 동일한 회사명이 이미 있으면 기존 거래처에 연결됩니다.
    </div>
  ` : '';
  body.innerHTML = `
    <div class="contract-doc">
      ${newCustomerBanner}
      ${renderPage1()}
      <div class="ct-page-divider no-print">― Page 2 ―</div>
      ${renderPage2()}
      <div class="ct-page-divider no-print">― Page 3 ―</div>
      ${renderPage3()}
      <div class="ct-page-divider no-print">― Page 4 ―</div>
      ${renderPage4()}
    </div>
  `;

  // 헤더 액션
  document.getElementById('ct-h-status').addEventListener('change', (e) => { ct.status = e.target.value; });
  document.getElementById('ct-btn-close').addEventListener('click', closeContractEditor);
  document.getElementById('ct-btn-print').addEventListener('click', printContractMulti);
  document.getElementById('ct-btn-save').addEventListener('click', saveContract);
  const delBtn = document.getElementById('ct-btn-delete');
  if (delBtn) delBtn.addEventListener('click', deleteContract);

  bindEditorEvents();
  initSignaturePads();
  recalcTotals();
}

// ── 페이지 1: 표지 ─────────────────────────────────────
function renderPage1() {
  const ct = CT_STATE.contract;
  const isNew = !!CT_STATE.isNewCustomer;
  // 신규 거래처 흐름: placeholder 추가, value 는 그대로(빈 값)
  const ph = (text) => isNew ? ` placeholder="${escapeAttr(text)}"` : '';
  return `
    <section class="contract-page" data-page="1">
      <div class="ct-cover-head">
        <div class="ct-cover-title">임대(렌탈) 계약서</div>
        <div class="ct-cover-company" style="text-align:right; font-size:12px;">
          계약번호 <input type="text" class="ct-input ed" data-field="contract_no" value="${escapeAttr(ct.contract_no)}" style="width:120px; display:inline-block;">
          <br>작성일 <input type="date" class="ct-input ed" data-field="contract_date" value="${escapeAttr(ct.contract_date)}" style="width:140px; display:inline-block;">
        </div>
      </div>

      <div class="section-title" style="margin-top:12px;">계 약 당 사 자</div>

      <table class="ct-tbl">
        <colgroup><col style="width:14%"><col style="width:36%"><col style="width:14%"><col style="width:36%"></colgroup>
        <tbody>
          <tr>
            <th class="ct-vlabel" rowspan="3">임 차 인<br>(갑·신청인)</th>
            <td><label style="font-size:10px; color:#555;">회사명${isNew ? ' *' : ''}</label><input class="ct-input ed" data-field="company_snapshot" value="${escapeAttr(ct.company_snapshot)}"${ph('회사명 (필수)')}></td>
            <th>대표자</th>
            <td><input class="ct-input ed" data-field="contact_name_snapshot" value="${escapeAttr(ct.contact_name_snapshot)}"${ph('담당자/대표자명')}></td>
          </tr>
          <tr>
            <th>사업자번호</th>
            <td><input class="ct-input ed" data-field="biz_no_snapshot" value="${escapeAttr(ct.biz_no_snapshot)}"${ph('000-00-00000')}></td>
            <th>전화</th>
            <td><input class="ct-input ed" data-field="phone_snapshot" value="${escapeAttr(ct.phone_snapshot)}"${ph('연락처')}></td>
          </tr>
          <tr>
            <th>주소</th>
            <td colspan="3"><input class="ct-input ed" data-field="address_snapshot" value="${escapeAttr(ct.address_snapshot)}"${ph('사업장 주소')}></td>
          </tr>
          <tr>
            <th class="ct-vlabel" rowspan="2">임 대 인<br>(을·공급자)</th>
            <td><label style="font-size:10px; color:#555;">상호</label> ${escapeHtml(SUPPLIER_INFO.company)}</td>
            <th>대표자</th>
            <td>${escapeHtml(SUPPLIER_INFO.ceo)}</td>
          </tr>
          <tr>
            <th>사업자번호</th>
            <td>${escapeHtml(SUPPLIER_INFO.biz_no)}</td>
            <th>전화 · 주소</th>
            <td>${escapeHtml(SUPPLIER_INFO.phone)} · ${escapeHtml(SUPPLIER_INFO.address)}</td>
          </tr>
        </tbody>
      </table>

      <div class="ct-preset-row no-print">
        <strong>품목 프리셋:</strong>
        <select id="ct-preset-pick">
          <option value="">선택…</option>
          ${Object.keys(PRESETS).map(k => `<option value="${escapeAttr(k)}">${escapeHtml(k)}</option>`).join('')}
        </select>
        <button class="btn small" id="ct-add-row">+ 빈 행 추가</button>
      </div>

      <div class="section-title">렌 탈 물 품</div>
      <table class="ct-tbl ct-tbl-items">
        <colgroup>
          <col style="width:18%"><col style="width:8%"><col style="width:8%">
          <col style="width:8%"><col style="width:8%"><col style="width:7%">
          <col style="width:13%"><col style="width:13%"><col style="width:11%"><col style="width:6%">
        </colgroup>
        <thead>
          <tr>
            <th>모델</th><th>기본(흑)</th><th>기본(컬)</th>
            <th>추가단가(흑)</th><th>추가단가(컬)</th><th>수량</th>
            <th>월 렌탈료</th><th>소계</th><th>비고</th><th></th>
          </tr>
        </thead>
        <tbody id="ct-items-body">
          ${renderItemRows()}
        </tbody>
      </table>

      <div class="ct-total-box">
        <div class="ct-total-cell"><label>소계 (VAT별도)</label><div class="v" id="ct-sub">0</div></div>
        <div class="ct-total-cell"><label>VAT 10%</label><div class="v" id="ct-vat">0</div></div>
        <div class="ct-total-cell total"><label>합계금액 (VAT포함)</label><div class="v" id="ct-total">0</div></div>
      </div>

      <div class="section-title">계 약 조 건</div>
      <table class="ct-tbl">
        <colgroup><col style="width:14%"><col style="width:36%"><col style="width:14%"><col style="width:36%"></colgroup>
        <tbody>
          <tr>
            <th>계약기간(년)</th>
            <td><input type="number" class="ct-input ed" data-field="period_years" value="${escapeAttr(ct.period_years)}" min="1" max="10" style="width:60px;"> 년</td>
            <th>계약기간</th>
            <td>
              <input type="date" class="ct-input ed" data-field="period_start" value="${escapeAttr(ct.period_start)}" style="width:46%;">
              ~
              <input type="date" class="ct-input ed" data-field="period_end" value="${escapeAttr(ct.period_end)}" style="width:46%;">
            </td>
          </tr>
          <tr>
            <th>보증금 (원)</th>
            <td><input type="number" class="ct-input ed num" data-field="deposit" value="${escapeAttr(ct.deposit || 0)}"> <span class="muted-small" id="ct-deposit-hint">(월세×2 자동 제안)</span></td>
            <th>설치비 (원)</th>
            <td><input type="number" class="ct-input ed num" data-field="install_fee" value="${escapeAttr(ct.install_fee || 0)}"></td>
          </tr>
        </tbody>
      </table>
      <div class="page-footer">- 1 -</div>
    </section>
  `;
}

function renderItemRows() {
  const items = CT_STATE.contract.items || [];
  if (!items.length) {
    return `<tr><td colspan="10" style="text-align:center; color:#888; padding:14px;">상단 "품목 프리셋" 에서 선택하거나 "+ 빈 행 추가" 를 눌러 품목을 추가하세요.</td></tr>`;
  }
  return items.map((r, i) => {
    const fixed = !!r.fixed_quota;
    const dis = fixed ? 'disabled' : '';
    const sub = calcRowTotal(r);
    const addedBadge = r.added_date
      ? `<div class="ct-row-added" title="추가일 (보유자산에서 자동 반영)">+${escapeHtml(r.added_date)}</div>`
      : '';
    return `
      <tr data-row="${i}">
        <td><input class="ct-input ed" data-row-field="model" value="${escapeAttr(r.model || '')}" placeholder="${escapeAttr(r._preset || '모델')}">${addedBadge}</td>
        <td><input type="number" class="ct-input ed num" data-row-field="bw_free" value="${escapeAttr(r.bw_free ?? 0)}" ${dis}></td>
        <td><input type="number" class="ct-input ed num" data-row-field="co_free" value="${escapeAttr(r.co_free ?? 0)}" ${dis}></td>
        <td><input type="number" class="ct-input ed num" data-row-field="bw_rate" value="${escapeAttr(r.bw_rate ?? 0)}" ${dis}></td>
        <td><input type="number" class="ct-input ed num" data-row-field="co_rate" value="${escapeAttr(r.co_rate ?? 0)}" ${dis}></td>
        <td><input type="number" class="ct-input ed qty" data-row-field="qty" value="${escapeAttr(r.qty ?? 1)}" min="1"></td>
        <td><input type="number" class="ct-input ed num" data-row-field="monthly_fee" value="${escapeAttr(r.monthly_fee ?? 0)}"></td>
        <td style="text-align:right;" class="ct-row-sub">${sub.toLocaleString()}</td>
        <td><input class="ct-input ed" data-row-field="note" value="${escapeAttr(r.note || '')}"></td>
        <td><button type="button" class="ct-row-del" data-row-del="${i}" title="행 삭제">×</button></td>
      </tr>
    `;
  }).join('');
}

// ── 페이지 2: 이용약관 (제1~5조 전반) ────────────────
function renderPage2() {
  const ct = CT_STATE.contract;
  const allTerms = ct.terms || [];
  // 제1~5조 (article <= 5)
  const front = allTerms.filter(t => Number(t.article) <= 5);
  return `
    <section class="contract-page" data-page="2">
      <div class="ct-page-title">이 용 약 관 (전반)</div>
      <p class="ct-terms-pre">
        본 임대(렌탈) 계약을 체결함에 있어 임대인 <span class="ct-pre-company">${escapeHtml(SUPPLIER_INFO.company)}</span> 와(과)
        임차인 <span class="ct-pre-company">${escapeHtml(ct.company_snapshot)}</span> 은(는) 아래 약관을 성실히 준수한다.
      </p>

      <div id="ct-terms-list-front">
        ${renderTermRows(front, 0)}
      </div>

      <div class="page-footer">- 2 -</div>
    </section>
  `;
}

// ── 페이지 3: 이용약관 (제6~10조 후반) + 부가사항 + 특약 ─
function renderPage3() {
  const ct = CT_STATE.contract;
  const allTerms = ct.terms || [];
  // 제6조 이상
  const backStart = allTerms.findIndex(t => Number(t.article) >= 6);
  const back = backStart >= 0 ? allTerms.slice(backStart) : [];
  return `
    <section class="contract-page" data-page="3">
      <div class="ct-page-title">이 용 약 관 (후반) · 부 가 사 항 · 특 약</div>

      <div id="ct-terms-list-back">
        ${renderTermRows(back, backStart >= 0 ? backStart : 0)}
      </div>

      <div style="margin-top:10px;" class="no-print">
        <button class="btn small" id="ct-term-add">+ 조항 추가</button>
      </div>

      <h4 style="margin-top:14px;">부가사항</h4>
      <div id="ct-extras-list">
        ${renderExtraRows(ct.extras)}
      </div>
      <div style="margin-top:6px;" class="no-print">
        <button class="btn small" id="ct-extra-add">+ 부가사항 추가</button>
      </div>

      <h4 style="margin-top:14px;">특약 (자유 기재)</h4>
      <textarea id="ct-special" placeholder="필요 시 특약사항을 입력하세요." style="width:100%; min-height:80px; padding:8px 10px; border:1px solid #ccc; border-radius:5px; font-size:11.5px; font-family:inherit; resize:vertical;">${escapeHtml(ct.special_terms || '')}</textarea>

      <div style="margin-top:18px;">
        <p style="font-size:11.5px;">위 약관 및 부가사항에 대해 양 당사자가 충분히 협의·확인하였으며, 계약 체결에 동의함.</p>
        <div class="ct-date-line">
          계약일자: <input type="date" class="ct-input ed date" data-field="contract_date_dup" value="${escapeAttr(ct.contract_date)}">
        </div>
      </div>

      <div class="page-footer">- 3 -</div>
    </section>
  `;
}

function renderTermRows(terms, baseIndex) {
  const base = Number(baseIndex) || 0;
  if (!terms || !terms.length) {
    return `<p class="muted" style="font-size:11px;">약관이 비어 있습니다.</p>`;
  }
  return terms.map((t, i) => {
    const realIdx = base + i;
    return `
    <div class="ct-term-row" data-term="${realIdx}">
      <div class="ct-term-no">제 <input type="number" min="1" data-term-field="article" value="${escapeAttr(t.article)}" style="width:34px; padding:2px 4px; border:1px solid #ccc; border-radius:3px;"> 조</div>
      <div>
        <div class="ct-term-tt"><input type="text" data-term-field="title" value="${escapeAttr(t.title)}" placeholder="조항 제목" style="padding:3px 6px; border:1px solid #ccc; border-radius:3px;"></div>
        <textarea data-term-field="body" placeholder="조항 본문">${escapeHtml(t.body)}</textarea>
      </div>
      <div class="ct-term-chk">
        <label class="chk"><input type="checkbox" data-term-field="confirmed" ${t.confirmed ? 'checked' : ''}> 확인함</label>
      </div>
      <div class="ct-term-rm no-print"><button type="button" data-term-del="${realIdx}" title="삭제">×</button></div>
    </div>
  `;
  }).join('');
}

function renderExtraRows(extras) {
  if (!extras || !extras.length) {
    return `<p class="muted" style="font-size:11px;">부가사항이 없습니다.</p>`;
  }
  return extras.map((e, i) => `
    <div class="ct-term-row" data-extra="${i}">
      <div class="ct-term-no">${i + 1}.</div>
      <div>
        <textarea data-extra-field="text">${escapeHtml(e.text)}</textarea>
      </div>
      <div class="ct-term-chk">
        <label class="chk"><input type="checkbox" data-extra-field="confirmed" ${e.confirmed ? 'checked' : ''}> 확인함</label>
      </div>
      <div class="ct-term-rm no-print"><button type="button" data-extra-del="${i}" title="삭제">×</button></div>
    </div>
  `).join('');
}

// ── 페이지 4: 자동출금 신청서 + 서명 ─────────────────
function renderPage4() {
  const ct = CT_STATE.contract;
  const pm = ct.payment_method || 'account';
  const acc = ct.payment_info?.account || {};
  const card = ct.payment_info?.card || {};
  const sigmode = ct.signature_type || 'digital';

  return `
    <section class="contract-page ct-cms-page" data-page="4">
      <div class="ct-page-title">자동출금 이용 신청서</div>

      <div class="ct-cms-section">신청인 정보</div>
      <table class="ct-tbl">
        <colgroup><col style="width:14%"><col style="width:36%"><col style="width:14%"><col style="width:36%"></colgroup>
        <tbody>
          <tr>
            <th>회사명</th>
            <td><input class="ct-input ed" data-field="company_snapshot" value="${escapeAttr(ct.company_snapshot)}"></td>
            <th>대표자/담당자</th>
            <td><input class="ct-input ed" data-field="contact_name_snapshot" value="${escapeAttr(ct.contact_name_snapshot)}"></td>
          </tr>
          <tr>
            <th>전화</th>
            <td><input class="ct-input ed" data-field="phone_snapshot" value="${escapeAttr(ct.phone_snapshot)}"></td>
            <th>이메일</th>
            <td><input class="ct-input ed" data-field="email_snapshot" value="${escapeAttr(ct.email_snapshot)}"></td>
          </tr>
        </tbody>
      </table>

      <div class="ct-cms-section" style="margin-top:14px;">결제 수단 선택</div>
      <div class="ct-cms-paymethod" style="margin-bottom:10px; font-size:12px;">
        <label style="margin-right:18px; cursor:pointer;">
          <input type="radio" name="ct-pay" value="account" ${pm === 'account' ? 'checked' : ''}> ⚪ 예금계좌
        </label>
        <label style="cursor:pointer;">
          <input type="radio" name="ct-pay" value="card"    ${pm === 'card' ? 'checked' : ''}> ⚪ 신용카드
        </label>
      </div>

      <div class="ct-pay-block ${pm === 'account' ? '' : 'disabled'}" id="ct-pay-account">
        <h5>예금계좌 자동이체</h5>
        <div class="ct-pay-grid">
          <div><label>은행</label><input data-pay-acc="bank"        value="${escapeAttr(acc.bank || '')}"></div>
          <div><label>계좌번호</label><input data-pay-acc="account_no" value="${escapeAttr(acc.account_no || '')}"></div>
          <div><label>예금주</label><input data-pay-acc="holder"      value="${escapeAttr(acc.holder || '')}"></div>
          <div><label>사업자번호/생년월일</label><input data-pay-acc="biz_no" value="${escapeAttr(acc.biz_no || '')}"></div>
          <div><label>출금 약정일</label><input type="number" data-pay-acc="draft_day" value="${escapeAttr(acc.draft_day ?? 25)}" min="1" max="31"></div>
        </div>
      </div>

      <div class="ct-pay-block ${pm === 'card' ? '' : 'disabled'}" id="ct-pay-card">
        <h5>신용카드 자동결제</h5>
        <div class="ct-pay-grid">
          <div><label>카드사</label><input data-pay-card="card_brand" value="${escapeAttr(card.card_brand || '')}"></div>
          <div><label>카드번호</label><input data-pay-card="card_no"    value="${escapeAttr(card.card_no || '')}"></div>
          <div><label>유효기간 (MM/YY)</label><input data-pay-card="expiry" value="${escapeAttr(card.expiry || '')}"></div>
          <div><label>소지자명</label><input data-pay-card="holder"     value="${escapeAttr(card.holder || '')}"></div>
          <div><label>출금 약정일</label><input type="number" data-pay-card="draft_day" value="${escapeAttr(card.draft_day ?? 25)}" min="1" max="31"></div>
        </div>
      </div>

      <div class="caution-text" style="margin-top:10px;">
        본인은 위 결제수단으로 매월 자동출금되는 임대료 및 부대비용 청구에 동의하며, 사실과 다르거나 결제 실패로 발생하는
        모든 책임은 신청인에게 있음을 확인합니다.
      </div>

      <!-- 서명 방식 토글 -->
      <div class="ct-sign-mode no-print">
        <strong>서명 방식:</strong>
        <label style="margin-left:10px;">
          <input type="radio" name="ct-sigmode" value="digital" ${sigmode === 'digital' ? 'checked' : ''}> ✍ 전자서명
        </label>
        <label style="margin-left:14px;">
          <input type="radio" name="ct-sigmode" value="stamp" ${sigmode === 'stamp' ? 'checked' : ''}> 🔴 도장 (출력 후 직접)
        </label>
      </div>

      <!-- 전자서명 영역 (canvas 2개) -->
      <div class="ct-sign-block ct-sign-digital ${sigmode === 'digital' ? '' : 'hidden'}">
        <div class="ct-sign-wrap">
          <div class="ct-sign-box">
            <div class="ct-sign-label">
              <span>공급자 (디직스코리아) 서명</span>
              <button type="button" class="ct-sign-clear no-print" data-sign-clear="supplier">✏ 다시 그리기</button>
            </div>
            <canvas class="ct-sign-canvas" id="ct-sign-supplier" data-sign-pad="supplier"></canvas>
          </div>
          <div class="ct-sign-box">
            <div class="ct-sign-label">
              <span>신청인 서명</span>
              <button type="button" class="ct-sign-clear no-print" data-sign-clear="applicant">✏ 다시 그리기</button>
            </div>
            <canvas class="ct-sign-canvas" id="ct-sign-applicant" data-sign-pad="applicant"></canvas>
          </div>
        </div>
      </div>

      <!-- 도장 모드 영역 -->
      <div class="ct-sign-block ct-sign-stamp ${sigmode === 'stamp' ? '' : 'hidden'}">
        <p class="muted" style="font-size:12px; margin:8px 0;">
          계약서를 인쇄하여 도장 또는 자필 사인을 받은 후, 스캔한 파일을 아래에 업로드하세요.
        </p>

        <div class="ct-sign-wrap">
          <div class="ct-sign-box">
            <div class="ct-sign-label"><span>공급자 (디직스코리아) 도장 / 사인</span></div>
            <div class="ct-stamp-area">(아래 도장 / 자필 사인 영역)</div>
          </div>
          <div class="ct-sign-box">
            <div class="ct-sign-label"><span>신청인 도장 / 사인</span></div>
            <div class="ct-stamp-area">(아래 도장 / 자필 사인 영역)</div>
          </div>
        </div>

        <div class="ct-attach-row no-print">
          <label>📄 도장이 찍힌 계약서 스캔본 (PDF 또는 이미지)</label>
          <input type="file" id="ct-att-contract" accept="application/pdf,image/*">
          <div id="ct-att-contract-meta" class="ct-attach-meta"></div>
        </div>

        <div class="ct-attach-row no-print">
          <label>🆔 신분증 사진 (사업자등록증 또는 신분증)</label>
          <input type="file" id="ct-att-idcard" accept="image/*,application/pdf">
          <div id="ct-att-idcard-meta" class="ct-attach-meta"></div>
        </div>
      </div>

      <div class="page-footer">- 4 -</div>
    </section>
  `;
}

// ── 에디터 이벤트 바인딩 ───────────────────────────────
function bindEditorEvents() {
  const ct = CT_STATE.contract;
  const body = document.getElementById('ct-edit-body');

  // (1) 단일 필드 (data-field)
  body.querySelectorAll('[data-field]').forEach(el => {
    el.addEventListener('input', () => {
      const f = el.dataset.field;
      let v = el.value;
      if (el.type === 'number') v = v === '' ? null : Number(v);
      // contract_date_dup → contract_date 동기화
      if (f === 'contract_date_dup') {
        ct.contract_date = v;
        // 헤더의 작성일 라벨/계약번호 반영 위해 헤더만 갱신
        renderEditorHeader();
        return;
      }
      ct[f] = v;
      // period_years 변경 → 종료일 자동 재계산
      if (f === 'period_years' && ct.period_start) {
        const d = new Date(ct.period_start);
        if (!isNaN(d)) {
          d.setFullYear(d.getFullYear() + (Number(v) || 0));
          ct.period_end = d.toISOString().slice(0, 10);
          const endEl = body.querySelector('[data-field="period_end"]');
          if (endEl) endEl.value = ct.period_end;
        }
      }
      // period_start 변경 시 종료일 자동
      if (f === 'period_start' && ct.period_years) {
        const d = new Date(v);
        if (!isNaN(d)) {
          d.setFullYear(d.getFullYear() + (Number(ct.period_years) || 0));
          ct.period_end = d.toISOString().slice(0, 10);
          const endEl = body.querySelector('[data-field="period_end"]');
          if (endEl) endEl.value = ct.period_end;
        }
      }
      if (f === 'contract_date' || f === 'contract_no') {
        renderEditorHeader();
      }
    });
  });

  // (2) 품목 행 (data-row-field)
  body.querySelectorAll('[data-row-field]').forEach(el => {
    el.addEventListener('input', () => {
      const tr = el.closest('tr');
      const i = Number(tr.dataset.row);
      const f = el.dataset.rowField;
      let v = el.value;
      if (el.type === 'number') v = v === '' ? 0 : Number(v);
      ct.items[i][f] = v;
      if (f === 'qty' || f === 'monthly_fee') {
        const sub = calcRowTotal(ct.items[i]);
        const cell = tr.querySelector('.ct-row-sub');
        if (cell) cell.textContent = sub.toLocaleString();
        recalcTotals();
      }
    });
  });

  // 행 삭제
  body.querySelectorAll('[data-row-del]').forEach(b => {
    b.addEventListener('click', () => {
      const i = Number(b.dataset.rowDel);
      ct.items.splice(i, 1);
      refreshItemsTable();
    });
  });

  // 프리셋 드롭다운
  const preset = document.getElementById('ct-preset-pick');
  if (preset) {
    preset.addEventListener('change', () => {
      const k = preset.value;
      if (!k || !PRESETS[k]) return;
      const row = { ...PRESETS[k], _preset: k };
      ct.items.push(row);
      // 레이저·복합기 → install_fee 자동 채움 (현재 비어있을 때만)
      if ((k === '레이저' || k === '복합기') && (!ct.install_fee || ct.install_fee === 0)) {
        ct.install_fee = 100000;
        const ifEl = document.querySelector('[data-field="install_fee"]');
        if (ifEl) ifEl.value = 100000;
      }
      preset.value = '';
      refreshItemsTable();
    });
  }

  // 빈 행 추가
  const addRowBtn = document.getElementById('ct-add-row');
  if (addRowBtn) {
    addRowBtn.addEventListener('click', () => {
      ct.items.push({ model: '', bw_free: 0, co_free: 0, bw_rate: 0, co_rate: 0, qty: 1, monthly_fee: 0, note: '' });
      refreshItemsTable();
    });
  }

  // (3) 약관 필드
  body.querySelectorAll('[data-term-field]').forEach(el => {
    el.addEventListener('input', () => {
      const row = el.closest('[data-term]');
      const i = Number(row.dataset.term);
      const f = el.dataset.termField;
      let v = el.value;
      if (f === 'confirmed') v = el.checked;
      else if (f === 'article') v = Number(v) || 0;
      ct.terms[i][f] = v;
    });
    el.addEventListener('change', () => {
      if (el.dataset.termField === 'confirmed') {
        const row = el.closest('[data-term]');
        ct.terms[Number(row.dataset.term)].confirmed = el.checked;
      }
    });
  });

  body.querySelectorAll('[data-term-del]').forEach(b => {
    b.addEventListener('click', () => {
      const i = Number(b.dataset.termDel);
      ct.terms.splice(i, 1);
      refreshTermsLists();
    });
  });

  const termAdd = document.getElementById('ct-term-add');
  if (termAdd) {
    termAdd.addEventListener('click', () => {
      const next = (ct.terms[ct.terms.length - 1]?.article || ct.terms.length) + 1;
      ct.terms.push({ article: next, title: '신규 조항', body: '', confirmed: true });
      refreshTermsLists();
    });
  }

  // (4) 부가사항
  body.querySelectorAll('[data-extra-field]').forEach(el => {
    el.addEventListener('input', () => {
      const row = el.closest('[data-extra]');
      const i = Number(row.dataset.extra);
      const f = el.dataset.extraField;
      ct.extras[i][f] = (f === 'confirmed') ? el.checked : el.value;
    });
    el.addEventListener('change', () => {
      if (el.dataset.extraField === 'confirmed') {
        const row = el.closest('[data-extra]');
        ct.extras[Number(row.dataset.extra)].confirmed = el.checked;
      }
    });
  });

  body.querySelectorAll('[data-extra-del]').forEach(b => {
    b.addEventListener('click', () => {
      const i = Number(b.dataset.extraDel);
      ct.extras.splice(i, 1);
      document.getElementById('ct-extras-list').innerHTML = renderExtraRows(ct.extras);
      bindEditorEvents();
    });
  });

  const extraAdd = document.getElementById('ct-extra-add');
  if (extraAdd) {
    extraAdd.addEventListener('click', () => {
      ct.extras.push({ text: '', confirmed: false });
      document.getElementById('ct-extras-list').innerHTML = renderExtraRows(ct.extras);
      bindEditorEvents();
    });
  }

  // (5) 특약
  const sp = document.getElementById('ct-special');
  if (sp) sp.addEventListener('input', () => { ct.special_terms = sp.value; });

  // (6) 결제수단 라디오
  body.querySelectorAll('input[name="ct-pay"]').forEach(r => {
    r.addEventListener('change', () => {
      ct.payment_method = r.value;
      document.getElementById('ct-pay-account').classList.toggle('disabled', r.value !== 'account');
      document.getElementById('ct-pay-card').classList.toggle('disabled',    r.value !== 'card');
    });
  });

  // (7) 결제정보 필드
  body.querySelectorAll('[data-pay-acc]').forEach(el => {
    el.addEventListener('input', () => {
      const f = el.dataset.payAcc;
      let v = el.value;
      if (el.type === 'number') v = v === '' ? null : Number(v);
      ct.payment_info.account = ct.payment_info.account || {};
      ct.payment_info.account[f] = v;
    });
  });
  body.querySelectorAll('[data-pay-card]').forEach(el => {
    el.addEventListener('input', () => {
      const f = el.dataset.payCard;
      let v = el.value;
      if (el.type === 'number') v = v === '' ? null : Number(v);
      ct.payment_info.card = ct.payment_info.card || {};
      ct.payment_info.card[f] = v;
    });
  });

  // (8) 서명 초기화 버튼
  body.querySelectorAll('[data-sign-clear]').forEach(b => {
    b.addEventListener('click', () => {
      const k = b.dataset.signClear;
      const pad = CT_STATE.signaturePads[k];
      if (pad) pad.clear();
      CT_STATE.contract[k === 'supplier' ? 'sign_supplier' : 'sign_applicant'] = '';
    });
  });

  // (9) 서명 방식 토글 (digital / stamp)
  body.querySelectorAll('input[name="ct-sigmode"]').forEach(r => {
    r.addEventListener('change', () => {
      ct.signature_type = r.value;
      const digitalBlock = body.querySelector('.ct-sign-digital');
      const stampBlock   = body.querySelector('.ct-sign-stamp');
      if (digitalBlock) digitalBlock.classList.toggle('hidden', r.value !== 'digital');
      if (stampBlock)   stampBlock.classList.toggle('hidden',   r.value !== 'stamp');
      // 도장 모드로 전환 시 첨부 메타 갱신
      if (r.value === 'stamp') refreshAttachmentMeta();
      // 전자서명 모드로 돌아가면 패드 재초기화
      if (r.value === 'digital') {
        setTimeout(initSignaturePads, 50);
      }
    });
  });

  // (10) 첨부 파일 업로드 (도장 모드)
  const attContract = body.querySelector('#ct-att-contract');
  if (attContract) {
    attContract.addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      await handleAttachmentUpload('contract', f);
      attContract.value = '';
    });
  }
  const attIdcard = body.querySelector('#ct-att-idcard');
  if (attIdcard) {
    attIdcard.addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      await handleAttachmentUpload('idcard', f);
      attIdcard.value = '';
    });
  }

  // 도장 모드면 첨부 메타 초기 렌더
  if ((ct.signature_type || 'digital') === 'stamp') {
    refreshAttachmentMeta();
  }
}

// 약관 두 영역 (전반/후반) 동기 재렌더
function refreshTermsLists() {
  const ct = CT_STATE.contract;
  if (!ct) return;
  const all = ct.terms || [];
  const front = all.filter(t => Number(t.article) <= 5);
  const backStart = all.findIndex(t => Number(t.article) >= 6);
  const back = backStart >= 0 ? all.slice(backStart) : [];
  const fEl = document.getElementById('ct-terms-list-front');
  const bEl = document.getElementById('ct-terms-list-back');
  if (fEl) fEl.innerHTML = renderTermRows(front, 0);
  if (bEl) bEl.innerHTML = renderTermRows(back, backStart >= 0 ? backStart : 0);
  bindEditorEvents();
}

function renderEditorHeader() {
  // 헤더만 살짝 갱신 (계약번호/작성일/회사명 동기화)
  const ct = CT_STATE.contract; const cu = CT_STATE.customer;
  const head = document.getElementById('ct-edit-head');
  if (!head) return;
  const meta = head.querySelector('.ct-h-meta');
  if (meta) meta.textContent = `계약번호 ${ct.contract_no} · 작성 ${ct.contract_date}`;
}

// 행 테이블만 새로 렌더
function refreshItemsTable() {
  document.getElementById('ct-items-body').innerHTML = renderItemRows();
  bindEditorEvents();
  // 보증금 자동 제안 (사용자가 직접 수정 안 했을 때 — 빈 경우에만)
  if (!CT_STATE.contract.deposit) {
    const suggest = suggestDeposit(CT_STATE.contract.items);
    if (suggest > 0) {
      CT_STATE.contract.deposit = suggest;
      const depEl = document.querySelector('[data-field="deposit"]');
      if (depEl) depEl.value = suggest;
    }
  }
  recalcTotals();
}

function recalcTotals() {
  const g = calcGrand(CT_STATE.contract.items || []);
  const subEl   = document.getElementById('ct-sub');
  const vatEl   = document.getElementById('ct-vat');
  const totalEl = document.getElementById('ct-total');
  if (subEl)   subEl.textContent   = g.sub.toLocaleString();
  if (vatEl)   vatEl.textContent   = g.vat.toLocaleString();
  if (totalEl) totalEl.textContent = g.total.toLocaleString();
}

// ── 서명 패드 (Canvas) ─────────────────────────────────
class SignaturePad {
  constructor(canvas, onChange) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.drawing = false;
    this.last = null;
    this.empty = true;
    this.onChange = onChange || (() => {});
    this._setupSize();
    this._bind();
  }
  _setupSize() {
    // CSS 크기 → 실제 픽셀 (HiDPI 대응)
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width  = rect.width  * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.scale(dpr, dpr);
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    this.ctx.strokeStyle = '#0b1220';
    this.ctx.lineWidth = 2.2;
  }
  _pt(e) {
    const r = this.canvas.getBoundingClientRect();
    const cx = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
    const cy = (e.touches ? e.touches[0].clientY : e.clientY) - r.top;
    return { x: cx, y: cy };
  }
  _bind() {
    const start = (e) => {
      e.preventDefault();
      this.drawing = true;
      this.empty = false;
      this.last = this._pt(e);
    };
    const move = (e) => {
      if (!this.drawing) return;
      e.preventDefault();
      const p = this._pt(e);
      this.ctx.beginPath();
      this.ctx.moveTo(this.last.x, this.last.y);
      this.ctx.lineTo(p.x, p.y);
      this.ctx.stroke();
      this.last = p;
    };
    const end = (e) => {
      if (!this.drawing) return;
      this.drawing = false;
      this.onChange(this.toDataURL());
    };
    this.canvas.addEventListener('mousedown', start);
    this.canvas.addEventListener('mousemove', move);
    window.addEventListener('mouseup', end);
    this.canvas.addEventListener('touchstart', start, { passive: false });
    this.canvas.addEventListener('touchmove',  move,  { passive: false });
    this.canvas.addEventListener('touchend',   end);
  }
  clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.empty = true;
    this.onChange('');
  }
  toDataURL() {
    if (this.empty) return '';
    return this.canvas.toDataURL('image/png');
  }
  fromDataURL(url) {
    if (!url) { this.clear(); return; }
    const img = new Image();
    img.onload = () => {
      const r = this.canvas.getBoundingClientRect();
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.ctx.drawImage(img, 0, 0, r.width, r.height);
      this.empty = false;
    };
    img.src = url;
  }
}

function initSignaturePads() {
  const supCv = document.getElementById('ct-sign-supplier');
  const appCv = document.getElementById('ct-sign-applicant');
  if (!supCv || !appCv) return;
  const ct = CT_STATE.contract;
  const supPad = new SignaturePad(supCv, (data) => { ct.sign_supplier  = data; });
  const appPad = new SignaturePad(appCv, (data) => { ct.sign_applicant = data; });
  CT_STATE.signaturePads = { supplier: supPad, applicant: appPad };
  if (ct.sign_supplier)  supPad.fromDataURL(ct.sign_supplier);
  if (ct.sign_applicant) appPad.fromDataURL(ct.sign_applicant);
}

// ── 첨부 파일 업로드 / 다운로드 / 삭제 (Supabase Storage) ─────
const ATTACH_BUCKET = 'rental-contracts';

async function uploadAttachment(contract_id, kind, file) {
  const supa = window.totalasAuth;
  if (!supa) throw new Error('인증이 준비되지 않았습니다.');
  const extRaw = (file.name.split('.').pop() || 'bin').toLowerCase();
  const ext = extRaw.replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin';
  const path = `${contract_id}/${kind}_${Date.now()}.${ext}`;
  const { error } = await supa.storage
    .from(ATTACH_BUCKET)
    .upload(path, file, { upsert: true, contentType: file.type || undefined });
  if (error) throw error;
  return path;
}

async function getSignedAttachmentUrl(path) {
  if (!path) return null;
  const supa = window.totalasAuth;
  if (!supa) return null;
  try {
    const { data, error } = await supa.storage
      .from(ATTACH_BUCKET)
      .createSignedUrl(path, 3600);
    if (error) throw error;
    return data?.signedUrl || null;
  } catch (err) {
    console.warn('signedUrl 실패:', err.message || err);
    return null;
  }
}

async function deleteAttachment(path) {
  if (!path) return;
  const supa = window.totalasAuth;
  if (!supa) return;
  try {
    await supa.storage.from(ATTACH_BUCKET).remove([path]);
  } catch (err) {
    console.warn('Storage 파일 삭제 실패:', err.message || err);
  }
}

// 업로드 핸들러 (kind: 'contract' | 'idcard')
async function handleAttachmentUpload(kind, file) {
  const ct = CT_STATE.contract;
  if (!ct) return;
  const supa = window.totalasAuth;
  if (!supa) { toast('인증이 준비되지 않았습니다.', 'err'); return; }

  // 5MB 제한 안내
  const sizeMB = file.size / 1024 / 1024;
  if (sizeMB > 20) {
    toast(`파일이 너무 큽니다 (${sizeMB.toFixed(1)}MB). 20MB 이하만 업로드 가능합니다.`, 'err');
    return;
  }

  const metaEl = document.getElementById(`ct-att-${kind}-meta`);
  if (metaEl) {
    metaEl.classList.remove('has-file');
    metaEl.innerHTML = `<span style="color:#64748b;">⏳ 업로드 중… (${file.name}, ${(sizeMB).toFixed(2)}MB)</span>`;
  }

  try {
    // 기존 파일이 있다면 삭제 시도 (best-effort)
    const oldField = kind === 'contract' ? 'contract_scan_path' : 'id_card_path';
    const oldPath = ct[oldField];
    if (oldPath) {
      await deleteAttachment(oldPath);
    }

    const path = await uploadAttachment(ct.id, kind, file);
    ct[oldField] = path;
    ct._attach_meta = ct._attach_meta || {};
    ct._attach_meta[kind] = { name: file.name, size: file.size, type: file.type };

    toast(`${kind === 'contract' ? '계약서 스캔본' : '신분증'} 업로드 완료`, 'ok');
    refreshAttachmentMeta();
  } catch (err) {
    console.error(err);
    toast(`업로드 실패: ${err.message || err}`, 'err');
    if (metaEl) metaEl.innerHTML = `<span style="color:#dc2626;">⚠ 업로드 실패: ${escapeHtml(err.message || String(err))}</span>`;
  }
}

// 첨부 메타(라벨/링크/삭제) 갱신
async function refreshAttachmentMeta() {
  const ct = CT_STATE.contract;
  if (!ct) return;

  for (const kind of ['contract', 'idcard']) {
    const field = kind === 'contract' ? 'contract_scan_path' : 'id_card_path';
    const path = ct[field];
    const el = document.getElementById(`ct-att-${kind}-meta`);
    if (!el) continue;

    if (!path) {
      el.classList.remove('has-file');
      el.innerHTML = `<span style="color:#94a3b8;">파일이 업로드되지 않았습니다.</span>`;
      continue;
    }

    const cachedMeta = ct._attach_meta?.[kind];
    const fname = cachedMeta?.name || path.split('/').pop();
    const fsize = cachedMeta?.size ? ` · ${(cachedMeta.size / 1024).toFixed(1)} KB` : '';
    el.classList.add('has-file');
    el.innerHTML = `
      ✓ 업로드 완료: <strong>${escapeHtml(fname)}</strong>${escapeHtml(fsize)}
      <a href="#" data-att-download="${escapeAttr(kind)}">🔗 다운로드</a>
      <button type="button" data-att-delete="${escapeAttr(kind)}">🗑 삭제</button>
    `;
  }

  // 다운로드 / 삭제 이벤트 바인딩
  document.querySelectorAll('[data-att-download]').forEach(a => {
    a.addEventListener('click', async (e) => {
      e.preventDefault();
      const kind = a.dataset.attDownload;
      const field = kind === 'contract' ? 'contract_scan_path' : 'id_card_path';
      const url = await getSignedAttachmentUrl(ct[field]);
      if (url) window.open(url, '_blank');
      else toast('다운로드 링크 생성 실패', 'err');
    });
  });
  document.querySelectorAll('[data-att-delete]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const kind = btn.dataset.attDelete;
      if (!confirm('이 파일을 삭제하시겠습니까?')) return;
      const field = kind === 'contract' ? 'contract_scan_path' : 'id_card_path';
      const path = ct[field];
      if (!path) return;
      try {
        await deleteAttachment(path);
        ct[field] = '';
        if (ct._attach_meta) delete ct._attach_meta[kind];
        toast('파일이 삭제되었습니다.', 'ok');
        refreshAttachmentMeta();
      } catch (err) {
        toast('삭제 실패: ' + (err.message || err), 'err');
      }
    });
  });
}

// ── 인쇄 (계약서·약관 2매 + 자동이체 1매 = 7페이지) ─────────
function buildPrintLayout() {
  const root = document.getElementById('ct-print-clone');
  if (!root) return false;
  root.innerHTML = '';

  // 페이지 1·2·3 을 갑/을 각 1매씩
  const labels = ['갑 (임차인) 보관용', '을 (임대인 · 디직스코리아) 보관용'];
  labels.forEach(label => {
    [1, 2, 3].forEach(pageNum => {
      const orig = document.querySelector(`#ct-edit-modal .contract-page[data-page="${pageNum}"]`);
      if (!orig) return;
      const clone = orig.cloneNode(true);
      // 라벨 박스 prepend
      const tag = document.createElement('div');
      tag.className = 'ct-print-copy-label';
      tag.textContent = label;
      clone.style.position = 'relative';
      clone.prepend(tag);

      // 전자서명 캔버스 → 이미지로 복제 (페이지 1·2·3엔 캔버스 없지만 안전망)
      replaceCanvasesWithImages(orig, clone);

      root.appendChild(clone);
    });
  });

  // 페이지 4 (자동이체) — 1매만
  const p4orig = document.querySelector(`#ct-edit-modal .contract-page[data-page="4"]`);
  if (p4orig) {
    const p4 = p4orig.cloneNode(true);
    p4.style.position = 'relative';
    // 도장 모드 첨부 영역(input) 은 인쇄에서 숨김 처리 (no-print 가 이미 있음)
    replaceCanvasesWithImages(p4orig, p4);
    root.appendChild(p4);
  }

  return true;
}

// 원본의 canvas 를 이미지로 변환해 클론의 canvas 자리에 삽입
function replaceCanvasesWithImages(origNode, cloneNode) {
  const origCanvases = origNode.querySelectorAll('canvas.ct-sign-canvas');
  const cloneCanvases = cloneNode.querySelectorAll('canvas.ct-sign-canvas');
  origCanvases.forEach((oc, idx) => {
    const cc = cloneCanvases[idx];
    if (!cc) return;
    try {
      const url = oc.toDataURL('image/png');
      const img = document.createElement('img');
      img.src = url;
      img.style.width  = '100%';
      img.style.height = '150px';
      img.style.objectFit = 'contain';
      img.style.display = 'block';
      cc.parentNode.replaceChild(img, cc);
    } catch (e) {
      // taint된 캔버스 등 — 무시
    }
  });
}

function printContractMulti() {
  // 캔버스 데이터를 최신화
  const ct = CT_STATE.contract;
  if (CT_STATE.signaturePads?.supplier) {
    ct.sign_supplier = CT_STATE.signaturePads.supplier.toDataURL() || ct.sign_supplier;
  }
  if (CT_STATE.signaturePads?.applicant) {
    ct.sign_applicant = CT_STATE.signaturePads.applicant.toDataURL() || ct.sign_applicant;
  }

  const ok = buildPrintLayout();
  if (!ok) { toast('인쇄 레이아웃 생성 실패', 'err'); return; }

  document.body.classList.add('ct-printing');
  toast('인쇄 미리보기를 준비합니다… (7페이지)', 'ok');

  // 인쇄 종료 후 정리
  const cleanup = () => {
    document.body.classList.remove('ct-printing');
    const root = document.getElementById('ct-print-clone');
    if (root) root.innerHTML = '';
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);

  // 짧은 지연 — 클론 DOM이 그려질 시간 확보
  setTimeout(() => {
    window.print();
    // 일부 브라우저는 afterprint 가 안 뜸 — fallback
    setTimeout(cleanup, 1500);
  }, 100);
}

// ── 저장 / 삭제 ────────────────────────────────────────
async function saveContract() {
  const ct = CT_STATE.contract;
  const supa = window.totalasAuth;
  if (!supa) { toast('인증이 준비되지 않았습니다.', 'err'); return; }

  // 최신 서명 데이터 동기화 (간혹 onChange 누락 대비)
  if (CT_STATE.signaturePads.supplier)  ct.sign_supplier  = CT_STATE.signaturePads.supplier.toDataURL()  || ct.sign_supplier  || '';
  if (CT_STATE.signaturePads.applicant) ct.sign_applicant = CT_STATE.signaturePads.applicant.toDataURL() || ct.sign_applicant || '';

  if ((ct.status === 'signed' || ct.status === 'active') && !ct.signed_at) {
    ct.signed_at = new Date().toISOString();
  }

  // ── 신규 거래처 자동 생성/연결 ──
  // customer_id 가 없으면: 회사명 중복 확인 → 있으면 연결, 없으면 INSERT
  let autoCreatedCustomerId = null;
  if (!ct.customer_id) {
    const companyName = (ct.company_snapshot || '').trim();
    if (!companyName) {
      toast('회사명을 입력하세요. (페이지 1 임차인 박스)', 'err');
      return;
    }
    try {
      // 정확 일치 우선 — active 무관 (만기 거래처도 재활용)
      const { data: exist, error: exErr } = await supa
        .from('rental_customers')
        .select('id, company, active')
        .eq('company', companyName)
        .limit(1);
      if (exErr) throw exErr;

      if (exist && exist.length) {
        ct.customer_id = exist[0].id;
        autoCreatedCustomerId = exist[0].id;
        toast(`기존 거래처 "${exist[0].company}"에 연결되었습니다.`, 'ok');
      } else {
        // 신규 INSERT
        const newId = 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
        const { error: insErr } = await supa.from('rental_customers').insert({
          id:           newId,
          company:      companyName,
          contact_name: (ct.contact_name_snapshot || '').trim() || null,
          phone:        (ct.phone_snapshot || '').trim() || null,
          biz_no:       (ct.biz_no_snapshot || '').trim() || null,
          address:      (ct.address_snapshot || '').trim() || null,
          email:        (ct.email_snapshot || '').trim() || null,
          active:       true,
        });
        if (insErr) throw insErr;
        ct.customer_id = newId;
        autoCreatedCustomerId = newId;
        CT_STATE.isNewCustomer = false;
        toast('새 거래처가 추가되었습니다.', 'ok');
      }
    } catch (err) {
      console.error(err);
      toast('거래처 자동 등록 실패: ' + (err.message || err), 'err');
      return;
    }
  }

  const payload = {
    id: ct.id,
    customer_id: ct.customer_id,
    contract_no: ct.contract_no,
    contract_date: ct.contract_date,
    period_years: ct.period_years,
    period_start: ct.period_start,
    period_end:   ct.period_end,
    deposit:      ct.deposit,
    install_fee:  ct.install_fee,
    company_snapshot:      ct.company_snapshot,
    contact_name_snapshot: ct.contact_name_snapshot,
    biz_no_snapshot:       ct.biz_no_snapshot,
    address_snapshot:      ct.address_snapshot,
    phone_snapshot:        ct.phone_snapshot,
    email_snapshot:        ct.email_snapshot,
    items:         ct.items || [],
    terms:         ct.terms || [],
    extras:        ct.extras || [],
    special_terms: ct.special_terms || null,
    payment_method: ct.payment_method || 'account',
    payment_info:   ct.payment_info || {},
    sign_supplier:  ct.sign_supplier  || null,
    sign_applicant: ct.sign_applicant || null,
    signature_type: ct.signature_type || 'digital',
    contract_scan_path: ct.contract_scan_path || null,
    id_card_path:       ct.id_card_path || null,
    signed_at:      ct.signed_at,
    status:         ct.status || 'draft',
    notes:          ct.notes || null,
    updated_at:     new Date().toISOString(),
  };

  try {
    const { error } = await supa.from('rental_contracts').upsert(payload);
    if (error) throw error;
    toast('계약서가 저장되었습니다.', 'ok');
    ct._existing = true;

    // 거래처 자동 생성/연결이 일어났다면: 전체 거래처 리스트 reload + 해당 거래처 선택
    if (autoCreatedCustomerId) {
      await loadAll();
      const cust = STATE.customers.find(x => x.id === autoCreatedCustomerId);
      if (cust) {
        STATE.selectedId = autoCreatedCustomerId;
        CT_STATE.customer = cust;        // 에디터의 현재 거래처도 갱신
      } else {
        // 만기 모드라 STATE에 안 보일 수 있음 — 활성 모드로 전환
        STATE.filters.mode = 'active';
        const modeRadio = document.querySelector('input[name="rc-mode"][value="active"]');
        if (modeRadio) modeRadio.checked = true;
        await loadAll();
        const cust2 = STATE.customers.find(x => x.id === autoCreatedCustomerId);
        if (cust2) {
          STATE.selectedId = autoCreatedCustomerId;
          CT_STATE.customer = cust2;
        }
      }
      renderList();
    }

    // 거래처별 리스트 새로고침 + 상세 패널 갱신
    await loadContractsFor(ct.customer_id);
    renderDetail();
    // 신규 배지/배너 제거 (현재 서명 패드 유지 위해 헤더+배너만 정리)
    if (autoCreatedCustomerId) {
      const banner = document.querySelector('.ct-new-customer-banner');
      if (banner) banner.remove();
      // 헤더의 "신규" 배지 갱신
      const head = document.getElementById('ct-edit-head');
      if (head) {
        const newBadge = head.querySelector('.rc-ct-badge[style*="fef3c7"]');
        if (newBadge) newBadge.remove();
        const headerTitle = head.querySelector('.ct-h-title');
        if (headerTitle) {
          const firstChild = headerTitle.firstChild;
          if (firstChild && firstChild.nodeType === 3) {
            const newName = (CT_STATE.customer && CT_STATE.customer.company)
              || ct.company_snapshot || '-';
            firstChild.textContent = newName + ' ';
          }
        }
      }
    }
  } catch (err) {
    console.error(err);
    toast('저장 실패: ' + (err.message || err), 'err');
  }
}

async function deleteContract() {
  const ct = CT_STATE.contract;
  if (!ct || !ct.id) return;
  if (!confirm(`계약서 ${ct.contract_no} 을(를) 삭제하시겠습니까?`)) return;
  try {
    const { error } = await window.totalasAuth.from('rental_contracts').delete().eq('id', ct.id);
    if (error) throw error;
    toast('계약서가 삭제되었습니다.', 'ok');
    closeContractEditor();
    await loadContractsFor(ct.customer_id);
    renderDetail();
  } catch (err) {
    console.error(err);
    toast('삭제 실패: ' + (err.message || err), 'err');
  }
}

// ── 수리내역 / 판매·수리 (rental_repairs) ─────────────
const REPAIR_STATE = {
  byCustomer: {},   // { customer_id: [repairs...] }
  editingId: null,  // 인라인 수정 중인 행 id
};

// 품목 카테고리 — item_type 으로 expense / income 분류
const REPAIR_CATS = {
  expense: { types: ['출장', '여분토너', '부품교체'], sign: -1, label: '무상수리내역',     icon: '🛠', color: '#dc2626' },
  income:  { types: ['판매', '수리'],                  sign: +1, label: '유상판매수리내역', icon: '💰', color: '#059669' },
};
function modeOfType(type) {
  if (REPAIR_CATS.income.types.includes(type)) return 'income';
  return 'expense';
}

async function loadRepairsFor(customerId) {
  const supa = window.totalasAuth;
  if (!supa) return [];
  try {
    const { data, error } = await supa
      .from('rental_repairs')
      .select('*')
      .eq('customer_id', customerId)
      .order('service_date', { ascending: false })
      .order('created_at', { ascending: false });
    if (error) throw error;
    REPAIR_STATE.byCustomer[customerId] = data || [];
    return data || [];
  } catch (err) {
    console.warn('수리내역 로드 실패:', err.message || err);
    REPAIR_STATE.byCustomer[customerId] = [];
    return [];
  }
}

// 월 합계 카드 — 최근 12개월 가로 표 (카운터 카드와 동일 레이아웃)
//   행: 월 임대료 / 유상판매 / 무상수리 / 합계
//   임대료는 assignment.start_date / end_date 기준 월별로 active 였던 자산만 합산
function renderMonthlyBalanceCard(customer) {
  const now = new Date();
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const ym  = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const lbl = `${String(d.getFullYear()).slice(2)}/${String(d.getMonth() + 1).padStart(2, '0')}`;
    months.push({ ym, lbl, rental: 0, income: 0, expense: 0 });
  }
  const idx = new Map(months.map((m, i) => [m.ym, i]));

  // 1) 월별 임대료: assignment 의 [start_date, end_date] 범위에 걸친 달에만 monthly_fee 가산
  const allAssign = customer._allAssignments || customer._assignments || [];
  for (const a of allAssign) {
    const fee = Number(a.monthly_fee) || 0;
    if (!fee) continue;
    const start = a.start_date ? new Date(a.start_date) : null;
    const end   = a.end_date   ? new Date(a.end_date)   : null;
    for (const m of months) {
      const [yy, mm] = m.ym.split('-').map(Number);
      const monthStart = new Date(yy, mm - 1, 1);
      const monthEnd   = new Date(yy, mm, 0);
      if (start && start > monthEnd) continue;
      if (end   && end   < monthStart) continue;
      m.rental += fee;
    }
  }

  // 2) 월별 수리내역 합계
  const all = REPAIR_STATE.byCustomer[customer.id];
  const loaded = Array.isArray(all);
  if (loaded) {
    for (const r of all) {
      const ym = (r.service_date || '').slice(0, 7);
      if (!idx.has(ym)) continue;
      const m = months[idx.get(ym)];
      const amt = Number(r.amount) || 0;
      if (modeOfType(r.item_type) === 'income') m.income  += amt;
      else                                       m.expense += amt; // 음수
    }
  }

  // 3) 합계 산출
  const totals = months.reduce((t, m) => {
    t.rental  += m.rental;
    t.income  += m.income;
    t.expense += m.expense;
    return t;
  }, { rental: 0, income: 0, expense: 0 });
  const grandTotal = totals.rental + totals.income + totals.expense;

  // 4) 셀 렌더 헬퍼
  const numCell = (n, opt = {}) => {
    const dim = n === 0;
    const sty = dim ? 'color:#cbd5e1;' : (opt.style || '');
    return `<td class="num" style="${sty}">${n.toLocaleString()}</td>`;
  };
  const sumCell = (n, opt = {}) => {
    const dim = n === 0;
    const sty = `background:#f1f5f9;${dim ? 'color:#cbd5e1;' : 'font-weight:700;'}${opt.color ? `color:${opt.color};` : ''}`;
    return `<td class="num" style="${sty}">${n.toLocaleString()}</td>`;
  };

  const headCells     = months.map(m => `<th class="num">${m.lbl}</th>`).join('');
  const rentalCells   = months.map(m => numCell(m.rental,  { style: m.rental  ? 'color:#0ea5e9;font-weight:600;' : '' })).join('');
  const incomeCells   = months.map(m => numCell(m.income,  { style: m.income  ? 'color:#059669;font-weight:600;' : '' })).join('');
  const expenseCells  = months.map(m => numCell(m.expense, { style: m.expense ? 'color:#dc2626;font-weight:600;' : '' })).join('');
  const totalCells    = months.map(m => {
    const t = m.rental + m.income + m.expense;
    const c = t > 0 ? '#059669' : (t < 0 ? '#dc2626' : '#cbd5e1');
    return `<td class="num" style="background:#f8fafc;color:${c};font-weight:700;">${t.toLocaleString()}</td>`;
  }).join('');

  const loadingNote = loaded
    ? ''
    : `<p class="muted-small" style="margin:8px 0 0; color:#94a3b8;">수리내역 로딩 중… 잠시 후 자동 반영됩니다.</p>`;

  return `<div class="card rc-monthly-balance-card">
    <h3 style="margin:0 0 8px;">💼 월 합계 — 최근 12개월
      <span class="muted-small" style="font-weight:400; margin-left:8px;">
        임대료 ${totals.rental.toLocaleString()} · 유상 +${totals.income.toLocaleString()} · 무상 ${totals.expense.toLocaleString()} · 합계 ${grandTotal.toLocaleString()}
      </span>
    </h3>
    <div class="rc-monthly-balance-wrap" style="overflow-x:auto;">
      <table class="rc-asset-table" style="font-size:11.5px; white-space:nowrap;">
        <thead>
          <tr>
            <th style="text-align:left;">항목</th>
            ${headCells}
            <th class="num" style="background:#eef2ff;">합계</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style="font-weight:600;">월 임대료</td>
            ${rentalCells}
            ${sumCell(totals.rental, { color: '#0ea5e9' })}
          </tr>
          <tr>
            <td style="font-weight:600;">유상판매</td>
            ${incomeCells}
            ${sumCell(totals.income, { color: '#059669' })}
          </tr>
          <tr>
            <td style="font-weight:600;">무상수리</td>
            ${expenseCells}
            ${sumCell(totals.expense, { color: '#dc2626' })}
          </tr>
        </tbody>
        <tfoot>
          <tr style="border-top:2px solid #e2e8f0;">
            <td style="font-weight:700; font-size:12px;">합계</td>
            ${totalCells}
            <td class="num" style="background:#eef2ff; font-weight:800; color:${grandTotal > 0 ? '#059669' : (grandTotal < 0 ? '#dc2626' : '#64748b')};">${grandTotal.toLocaleString()}</td>
          </tr>
        </tfoot>
      </table>
    </div>
    ${loadingNote}
  </div>`;
}

function renderRepairCard(customer, mode) {
  const cat = REPAIR_CATS[mode];
  const all = REPAIR_STATE.byCustomer[customer.id];
  const loaded = Array.isArray(all);
  const rows = loaded ? all.filter(r => modeOfType(r.item_type) === mode) : [];
  const sum = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const sumStyle = sum < 0 ? 'color:#dc2626;' : (sum > 0 ? 'color:#059669;' : '');
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const typeOptions = cat.types.map(t => `<option value="${escapeAttr(t)}">${escapeHtml(t)}</option>`).join('');

  const inputStyle = 'font-size:12px; padding:4px 6px; border:1px solid var(--border); border-radius:4px; width:100%;';

  // 항상 전체 데이터 표시. 5행 높이의 스크롤 영역으로 이전 내역 확인.
  const VISIBLE_ROWS = 5;
  const ROW_PX = 38; // 행 높이 평균(여유 포함)
  const visibleRows = loaded ? rows : [];

  const makeRowHtml = (r) => {
    const amt = Number(r.amount) || 0;
    const amtColor = amt < 0 ? 'color:#dc2626;' : (amt > 0 ? 'color:#059669;' : 'color:#94a3b8;');
    // 인라인 수정 모드
    if (REPAIR_STATE.editingId === r.id) {
      const editTypeOptions = cat.types.map(t =>
        `<option value="${escapeAttr(t)}" ${t === r.item_type ? 'selected' : ''}>${escapeHtml(t)}</option>`
      ).join('');
      const absAmt = Math.abs(amt);
      return `
        <tr data-rid="${escapeAttr(r.id)}" class="rp-edit-row" style="background:#fef9c3;">
          <td><input type="date" data-rp-edit-field="service_date" value="${escapeAttr((r.service_date || '').slice(0,10))}" style="${inputStyle}"></td>
          <td><select data-rp-edit-field="item_type" style="${inputStyle}">${editTypeOptions}</select></td>
          <td><input type="text" data-rp-edit-field="work_desc" value="${escapeAttr(r.work_desc || '')}" style="${inputStyle} text-align:left;"></td>
          <td><input type="number" data-rp-edit-field="amount" value="${absAmt}" step="1" style="${inputStyle} text-align:right;"></td>
          <td class="act" style="white-space:nowrap;">
            <button class="rc-icon-btn" data-rp-act="save" data-rid="${escapeAttr(r.id)}" title="저장" style="color:#059669;">✓</button>
            <button class="rc-icon-btn" data-rp-act="cancel" title="취소">✕</button>
          </td>
        </tr>
      `;
    }
    const asmsMatch = /^ASMS#(\d+)/.exec(r.notes || '');
    const asmsBadge = asmsMatch
      ? `<span title="ASMS 접수번호 #${escapeAttr(asmsMatch[1])} 자동 동기화" style="display:inline-block; margin-left:4px; padding:1px 5px; font-size:10px; font-weight:600; line-height:1.4; color:#fff; background:#0ea5e9; border-radius:3px; vertical-align:middle;">ASMS</span>`
      : '';
    return `
      <tr data-rid="${escapeAttr(r.id)}">
        <td data-label="날짜" class="muted-small">${escapeHtml((r.service_date || '').slice(0, 10))}</td>
        <td data-label="품목">${escapeHtml(r.item_type || '-')}${asmsBadge}</td>
        <td data-label="작업내용">${escapeHtml(r.work_desc || '-')}</td>
        <td data-label="금액" style="text-align:right; font-weight:600; ${amtColor}">${amt.toLocaleString()}</td>
        <td class="act" style="white-space:nowrap;">
          <button class="rc-icon-btn" data-rp-act="edit" data-rid="${escapeAttr(r.id)}" title="수정">✏</button>
          <button class="rc-icon-btn danger" data-rp-act="del" data-rid="${escapeAttr(r.id)}" title="삭제">🗑</button>
        </td>
      </tr>
    `;
  };

  const dataRows = visibleRows.length
    ? visibleRows.map(makeRowHtml).join('')
    : (loaded
        ? `<tr><td colspan="5" class="muted" style="text-align:center; padding:14px; font-size:12.5px;">등록된 ${cat.label}이(가) 없습니다.</td></tr>`
        : `<tr><td colspan="5" class="muted" style="text-align:center; padding:14px; font-size:12px;">로딩 중…</td></tr>`);

  const signLabel = cat.sign < 0 ? '자동 −' : '자동 +';
  const newRow = `
    <tr class="rp-new-row" data-rp-mode="${mode}" style="background:#f8fafc;">
      <td><input type="date" data-rp-new="service_date" value="${todayStr}" style="${inputStyle}"></td>
      <td>
        <select data-rp-new="item_type" style="${inputStyle}">
          ${typeOptions}
        </select>
      </td>
      <td><input type="text" data-rp-new="work_desc" placeholder="작업내용" style="${inputStyle} padding-left:8px; text-align:left;"></td>
      <td><input type="number" data-rp-new="amount" placeholder="금액 (${signLabel})" step="1" style="${inputStyle} padding-left:8px; text-align:right;"></td>
      <td class="act"><button class="btn small primary" data-rp-act="add" data-rp-mode="${mode}" type="button">+ 추가</button></td>
    </tr>
  `;

  const scrollMaxPx = VISIBLE_ROWS * ROW_PX; // 5행 분 (헤더는 sticky 라 별도)
  const needsScroll = rows.length > VISIBLE_ROWS;
  const scrollHint = needsScroll
    ? `<span class="muted-small" style="font-weight:400; color:#94a3b8;">↕ 스크롤로 이전 내역 보기</span>`
    : '';

  return `
    <div class="card rc-repair-card" data-rp-mode="${mode}">
      <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:8px;">
        <h3 style="margin:0;">${cat.icon} ${cat.label} <span class="muted-small" style="font-weight:400;">${rows.length}건 · 합계 <b style="${sumStyle}">${sum.toLocaleString()}원</b></span></h3>
        ${scrollHint}
      </div>
      <div class="rc-repair-scroll" style="max-height:${scrollMaxPx}px; overflow-y:auto; overflow-x:auto; border:1px solid var(--border); border-radius:4px;">
        <table class="rc-asset-table" style="margin:0;">
          <thead>
            <tr>
              <th style="width:100px; position:sticky; top:0; background:#f8fafc; z-index:1;">날짜</th>
              <th style="width:110px; position:sticky; top:0; background:#f8fafc; z-index:1;">품목</th>
              <th style="position:sticky; top:0; background:#f8fafc; z-index:1;">작업내용</th>
              <th style="width:110px; text-align:right; position:sticky; top:0; background:#f8fafc; z-index:1;">금액</th>
              <th class="act" style="position:sticky; top:0; background:#f8fafc; z-index:1;">관리</th>
            </tr>
          </thead>
          <tbody>
            ${dataRows}
          </tbody>
        </table>
      </div>
      <div style="overflow-x:auto; margin-top:6px;">
        <table class="rc-asset-table" style="margin:0;">
          <colgroup>
            <col style="width:100px;">
            <col style="width:110px;">
            <col>
            <col style="width:110px;">
            <col style="width:80px;">
          </colgroup>
          <tbody>
            ${newRow}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

async function addRepair(customerId, payload) {
  const supa = window.totalasAuth;
  if (!supa) throw new Error('인증되지 않은 세션입니다.');
  const id = `rp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
  const { error } = await supa.from('rental_repairs').insert({
    id, customer_id: customerId, ...payload,
  });
  if (error) throw error;
  await loadRepairsFor(customerId);
}

async function updateRepair(customerId, repairId, payload) {
  const supa = window.totalasAuth;
  if (!supa) throw new Error('인증되지 않은 세션입니다.');
  const { error } = await supa.from('rental_repairs')
    .update({ ...payload, updated_at: new Date().toISOString() })
    .eq('id', repairId);
  if (error) throw error;
  await loadRepairsFor(customerId);
}

async function deleteRepair(customerId, repairId) {
  const supa = window.totalasAuth;
  if (!supa) throw new Error('인증되지 않은 세션입니다.');
  const { error } = await supa.from('rental_repairs').delete().eq('id', repairId);
  if (error) throw error;
  await loadRepairsFor(customerId);
}

function bindRepairCards(c) {
  document.querySelectorAll('.rc-repair-card').forEach(card => {
    const mode = card.dataset.rpMode;
    const cat = REPAIR_CATS[mode];

    // 추가 버튼
    const addBtn = card.querySelector('[data-rp-act="add"]');
    if (addBtn) {
      addBtn.addEventListener('click', async () => {
        const newRow = card.querySelector('.rp-new-row');
        const dateEl = newRow.querySelector('[data-rp-new="service_date"]');
        const typeEl = newRow.querySelector('[data-rp-new="item_type"]');
        const descEl = newRow.querySelector('[data-rp-new="work_desc"]');
        const amountEl = newRow.querySelector('[data-rp-new="amount"]');
        const item_type = (typeEl.value || '').trim();
        const work_desc = (descEl.value || '').trim();
        const rawAmount = amountEl.value === '' ? 0 : Number(amountEl.value);
        if (!item_type) { toast('품목을 선택하세요.', 'err'); return; }
        if (Number.isNaN(rawAmount)) { toast('금액이 올바르지 않습니다.', 'err'); return; }
        // 카테고리 부호 자동 적용: expense → 음수, income → 양수
        const amount = rawAmount === 0 ? 0 : cat.sign * Math.abs(rawAmount);
        addBtn.disabled = true;
        addBtn.textContent = '저장 중…';
        try {
          await addRepair(c.id, {
            service_date: dateEl.value || null,
            item_type,
            work_desc: work_desc || null,
            amount,
          });
          toast(`${cat.label} 추가되었습니다.`, 'ok');
          renderDetail();
        } catch (err) {
          console.error(err);
          toast('추가 실패: ' + (err.message || err), 'err');
          addBtn.disabled = false;
          addBtn.textContent = '+ 추가';
        }
      });
    }

    // 수정 / 삭제 / 저장 / 취소 — event delegation
    card.querySelectorAll('[data-rp-act]').forEach(btn => {
      const act = btn.dataset.rpAct;
      if (act === 'add') return; // already bound
      if (act === 'edit') {
        btn.addEventListener('click', () => {
          REPAIR_STATE.editingId = btn.dataset.rid;
          renderDetail();
        });
      } else if (act === 'cancel') {
        btn.addEventListener('click', () => {
          REPAIR_STATE.editingId = null;
          renderDetail();
        });
      } else if (act === 'save') {
        btn.addEventListener('click', async () => {
          const rid = btn.dataset.rid;
          const row = card.querySelector(`tr[data-rid="${rid}"].rp-edit-row`);
          if (!row) return;
          const dateV = row.querySelector('[data-rp-edit-field="service_date"]').value;
          const typeV = row.querySelector('[data-rp-edit-field="item_type"]').value;
          const descV = row.querySelector('[data-rp-edit-field="work_desc"]').value;
          const amountRaw = row.querySelector('[data-rp-edit-field="amount"]').value;
          const editMode = modeOfType(typeV);
          const sign = REPAIR_CATS[editMode].sign;
          const amtNum = amountRaw === '' ? 0 : Number(amountRaw);
          if (Number.isNaN(amtNum)) { toast('금액이 올바르지 않습니다.', 'err'); return; }
          const amount = amtNum === 0 ? 0 : sign * Math.abs(amtNum);
          btn.disabled = true;
          try {
            await updateRepair(c.id, rid, {
              service_date: dateV || null,
              item_type: typeV,
              work_desc: (descV || '').trim() || null,
              amount,
            });
            REPAIR_STATE.editingId = null;
            toast('수정되었습니다.', 'ok');
            renderDetail();
          } catch (err) {
            console.error(err);
            toast('수정 실패: ' + (err.message || err), 'err');
            btn.disabled = false;
          }
        });
      } else if (act === 'del') {
        btn.addEventListener('click', async () => {
          const rid = btn.dataset.rid;
          if (!rid) return;
          if (!confirm('이 항목을 삭제하시겠습니까?')) return;
          try {
            await deleteRepair(c.id, rid);
            if (REPAIR_STATE.editingId === rid) REPAIR_STATE.editingId = null;
            toast('삭제되었습니다.', 'ok');
            renderDetail();
          } catch (err) {
            console.error(err);
            toast('삭제 실패: ' + (err.message || err), 'err');
          }
        });
      }
    });

  });
}

// ── 상세 패널 hook (renderDetail 후처리) ─────────────
const _originalRenderDetail = renderDetail;
renderDetail = function () {
  _originalRenderDetail();
  const c = STATE.customers.find(x => x.id === STATE.selectedId);
  if (!c) return;

  const detail = document.getElementById('rc-detail');

  // 계약서 카드 + 거래처 문서 카드: Cross-sell 카드 바로 앞에 삽입
  // 순서: 보유자산 → 임대계약내역 → 카운터12m → 수리내역 → 계약서 → 거래처문서 → Cross-sell
  const insightCard = Array.from(detail.querySelectorAll('.card'))
    .find(el => /Cross-sell/i.test(el.textContent || ''));

  const ctCardHTML  = renderContractCard(c);
  const docsCardHTML = renderCustomerDocsCard(c);

  if (insightCard) {
    insightCard.insertAdjacentHTML('beforebegin', ctCardHTML + docsCardHTML);
  } else {
    detail.insertAdjacentHTML('beforeend', ctCardHTML + docsCardHTML);
  }

  // 이벤트 바인딩 (계약서)
  // [🖨 기존 계약서 출력] — 가장 최근 계약서를 임대계약서 창에서 자동 인쇄
  const printLatestBtn = document.getElementById('btn-ct-print-latest');
  if (printLatestBtn) {
    printLatestBtn.addEventListener('click', () => {
      const list = CT_STATE.byCustomer[c.id] || [];
      if (!list.length) { toast('저장된 계약서가 없습니다.', 'err'); return; }
      const latest = list[0]; // contract_date desc 정렬됨
      openChildContractWindow(c, latest, /* autoPrint */ true);
    });
  }

  // 계약서 row 의 [인쇄] [수정] [삭제] 버튼
  detail.querySelectorAll('.rc-ct-row [data-ctact]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const ctid = btn.dataset.ctid;
      const list = CT_STATE.byCustomer[c.id] || [];
      const existing = list.find(x => x.id === ctid);
      if (!existing) return;
      const act = btn.dataset.ctact;
      if (act === 'print')       openChildContractWindow(c, existing, true);
      else if (act === 'edit')   openChildContractWindow(c, existing, false);
      else if (act === 'delete') deleteContractRow(c, existing);
    });
  });

  // 이벤트 바인딩 (수리내역 / 판매·수리)
  bindRepairCards(c);

  // 이벤트 바인딩 (거래처 문서)
  bindDocsCard(c);

  // 계약서 비동기 로드 (없을 때만)
  if (!CT_STATE.byCustomer[c.id]) {
    loadContractsFor(c.id).then(() => renderDetail());
  }

  // 수리내역 비동기 로드 (없을 때만)
  if (!REPAIR_STATE.byCustomer[c.id]) {
    loadRepairsFor(c.id).then(() => renderDetail());
  }

  // 거래처 문서 비동기 로드 (없을 때만)
  if (!DOC_STATE.byCustomer[c.id]) {
    loadDocsFor(c.id).then(() => renderDetail());
  }
};

// ── 에디터 모달 닫기 (ESC / backdrop) ────────────────
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('ct-edit-backdrop')?.classList.contains('show')) {
    closeContractEditor();
  }
});
document.addEventListener('click', (e) => {
  if (e.target && e.target.id === 'ct-edit-backdrop') closeContractEditor();
});
