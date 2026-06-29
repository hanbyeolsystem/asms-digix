// ============================================================
// totalas — 임대장비관리 (rental-equipment)
// 실시간 수집기 데이터(rental_collectors / rental_collector_devices /
// rental_counter_readings) + 거래처 그룹화 + 신규 매핑.
// 의존: window.totalasAuth (auth.js), supabase-js v2
// ============================================================
(function () {
  'use strict';

  const COLLECTOR_OFFLINE_MIN = 15; // 15분간 heartbeat 없으면 offline

  // ── 소모품(토너/잉크) 관리 상수 ──
  const SUPPLY_COLORS = [
    { key: 'K', tk: 'toner_k', label: '블랙',   color: '#111827' },
    { key: 'C', tk: 'toner_c', label: '시안',   color: '#06b6d4' },
    { key: 'M', tk: 'toner_m', label: '마젠타', color: '#ec4899' },
    { key: 'Y', tk: 'toner_y', label: '옐로우', color: '#eab308' },
  ];
  const SUPPLY_LOW  = 10; // 잔량 ≤10% = 부족
  const SUPPLY_JUMP = 30; // 직전 대비 +30%p 이상 상승 = 교체로 간주

  const state = {
    customers: [],
    collectors: [],            // rental_collectors
    collectorDevices: [],      // rental_collector_devices
    readingByDevice: new Map(),// device_id → 최신 rental_counter_readings
    tonerSeriesByDevice: new Map(), // device_id → [reading,…] (토너값 있는 것만, 교체감지용)
    suppliesByDevice: new Map(),    // device_id → { K:{spare_count,set_at}, … }
    supplyConfig: new Map(),        // device_id → alarm_enabled(boolean)
    supplyStatusByDevice: new Map(),// device_id → _supplyStatus 결과 (캐시)
    suppliesAvailable: true,        // 51_device_supplies.sql 적용 여부
    loaded: false,
    collectorSearch: '',       // 실시간 수집기 검색어 (거래처/모델/자산번호)
  };

  const $  = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, m =>
      ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
  }
  function fmtInt(n) {
    if (n == null || Number.isNaN(Number(n))) return '–';
    return Math.round(Number(n)).toLocaleString('ko-KR');
  }
  function showToast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.classList.remove('show'), 1800);
  }

  // ---------- 데이터 로딩 ----------
  async function loadAll() {
    const supa = window.totalasAuth;
    if (!supa) throw new Error('Supabase 클라이언트(window.totalasAuth) 미초기화');

    const [cuRes, clRes, riRes] = await Promise.all([
      supa.from('rental_customers').select('id, company, trade_name, active, archived_at').range(0, 9999),
      supa.from('rental_collectors').select('*').range(0, 9999),
      supa.from('rental_items').select('id, asset_number, model, brand').range(0, 9999),
    ]);
    if (cuRes.error) throw cuRes.error;
    // rental_collectors 는 33_collector_init.sql 미적용 시 에러 → 무시하고 빈 배열
    if (clRes.error) {
      console.warn('[rental-equipment] rental_collectors 조회 실패 (33_collector_init.sql 미적용?):', clRes.error.message);
      state.collectors = [];
    } else {
      state.collectors = clRes.data || [];
    }
    // rental_items 자산 매핑 (device.item_id → asset_number 표시용)
    state.itemById = new Map();
    if (!riRes.error) {
      for (const it of (riRes.data || [])) state.itemById.set(it.id, it);
    }

    // 실시간 수집기 데이터 (devices + 최신 readings)
    // - registered=true 인 장비만 표시 (35_collector_device_registered.sql 이후)
    //   고객 PC scan_ui 에서 명시적으로 체크/업로드한 장비만 등록됨
    // - 미등록 device 는 백그라운드 폴링으로 들어와도 readings 가 폐기되므로 자연스럽게 사라지지만
    //   목록 자체에 안 보이도록 명시적 필터
    // - hidden=true (사용자가 ✕ 로 숨김) 도 제외
    state.collectorDevices = [];
    state.readingByDevice = new Map();
    try {
      const [cdRes, rdRes] = await Promise.all([
        supa.from('rental_collector_devices').select('*')
            .eq('registered', true)
            .or('hidden.is.null,hidden.eq.false')
            .range(0, 9999),
        supa.from('rental_counter_readings')
            .select('device_id, bw, color, total_pages, toner_k, toner_c, toner_m, toner_y, alert_text, read_at')
            .order('read_at', { ascending: false })
            .range(0, 99999),
      ]);
      if (!cdRes.error) {
        state.collectorDevices = cdRes.data || [];
      } else {
        // registered 컬럼이 없으면(35 미적용) graceful degrade — 기존 동작
        console.warn('[rental-equipment] registered 필터 실패 (35 미적용?):', cdRes.error.message);
        const fallback = await supa.from('rental_collector_devices').select('*')
          .or('hidden.is.null,hidden.eq.false')
          .range(0, 9999);
        if (!fallback.error) state.collectorDevices = fallback.data || [];
      }
      if (!rdRes.error) {
        state.tonerSeriesByDevice = new Map();
        for (const r of rdRes.data || []) {
          if (!state.readingByDevice.has(r.device_id)) {
            state.readingByDevice.set(r.device_id, r);
          }
          // 교체 감지용 토너 이력 누적 (토너값이 하나라도 있는 reading 만)
          if (r.toner_k != null || r.toner_c != null || r.toner_m != null || r.toner_y != null) {
            let arr = state.tonerSeriesByDevice.get(r.device_id);
            if (!arr) { arr = []; state.tonerSeriesByDevice.set(r.device_id, arr); }
            arr.push(r);
          }
        }
      }
    } catch (e) {
      console.warn('[rental-equipment] live data 조회 실패:', e);
    }

    // 소모품 여분 재고 + 알람 설정 (51_device_supplies.sql 미적용 시 graceful)
    state.suppliesByDevice = new Map();
    state.supplyConfig = new Map();
    state.suppliesAvailable = true;
    try {
      const [spRes, cfRes] = await Promise.all([
        supa.from('rental_device_supplies').select('device_id, color, spare_count, set_at').range(0, 9999),
        supa.from('rental_device_supply_config').select('device_id, alarm_enabled').range(0, 9999),
      ]);
      if (spRes.error) {
        state.suppliesAvailable = false;
        console.warn('[rental-equipment] rental_device_supplies 조회 실패 (51 미적용?):', spRes.error.message);
      } else {
        for (const s of spRes.data || []) {
          let m = state.suppliesByDevice.get(s.device_id);
          if (!m) { m = {}; state.suppliesByDevice.set(s.device_id, m); }
          m[s.color] = { spare_count: s.spare_count, set_at: s.set_at };
        }
      }
      if (!cfRes.error) {
        for (const c of cfRes.data || []) state.supplyConfig.set(c.device_id, c.alarm_enabled);
      }
    } catch (e) {
      state.suppliesAvailable = false;
      console.warn('[rental-equipment] 소모품 설정 조회 실패:', e);
    }

    state.customers = cuRes.data || [];

    state.loaded = true;
  }

  // ---------- 수집기 패널 ----------
  function classifyCollector(c) {
    if (c.status === 'pending' || !c.customer_id) return 'pending';
    if (!c.last_seen_at) return 'offline';
    const lastMs = new Date(c.last_seen_at).getTime();
    const diffMin = (Date.now() - lastMs) / 60000;
    return diffMin > COLLECTOR_OFFLINE_MIN ? 'offline' : 'online';
  }

  function renderCollectorPanel() {
    // 통계 단위: 장비(device). 표의 상태 배지와 동일 기준으로 일치시킴.
    //   - 매핑대기: device 가 속한 collector 가 status=pending 또는 customer_id 없음
    //   - 온/오프라인: device.last_seen_at (또는 최신 reading.read_at) 기준 30분 초과
    // 배너 카운트는 사용자가 매핑 작업할 collector(PC) 수 — 별도 카운트
    const counts = { online: 0, offline: 0, pending: 0 };
    const collectorById = new Map(state.collectors.map(c => [c.id, c]));
    const pendingCollectorIds = new Set(
      state.collectors.filter(c => c.status === 'pending' || !c.customer_id).map(c => c.id)
    );
    for (const d of state.collectorDevices) {
      if (pendingCollectorIds.has(d.collector_id)) { counts.pending++; continue; }
      const reading = state.readingByDevice?.get?.(d.id);
      const tsStr = (reading && reading.read_at) || d.last_seen_at;
      const ageMin = tsStr ? (Date.now() - new Date(tsStr).getTime()) / 60000 : null;
      if (ageMin == null || ageMin > 30) counts.offline++;
      else counts.online++;
    }
    $('#cp-online').textContent  = counts.online;
    $('#cp-offline').textContent = counts.offline;
    $('#cp-offline').classList.toggle('alert', counts.offline > 0);
    $('#cp-pending').textContent = counts.pending;

    // 신규 수집기 배너 — 매핑대기 PC(=collector) 수 기준 (액션이 collector 단위라 그대로)
    const banner = $('#new-collector-banner');
    if (pendingCollectorIds.size > 0) {
      $('#ncb-count').textContent = pendingCollectorIds.size;
      banner.style.display = 'flex';
    } else {
      banner.style.display = 'none';
    }
  }

  // ============================================================
  // 소모품(토너/잉크) 교체 감지 · 여분 재고 · 부족 알람
  // ============================================================
  // 토너 잔량이 직전 대비 +SUPPLY_JUMP 이상 상승 = 교체. 색상별 이벤트 배열(asc) 반환.
  function _detectReplacements(readings) {
    if (!readings || !readings.length) return [];
    const sorted = readings.slice().sort((a, b) => String(a.read_at || '').localeCompare(String(b.read_at || '')));
    const events = [];
    const prev = { K: null, C: null, M: null, Y: null };
    for (const r of sorted) {
      for (const c of SUPPLY_COLORS) {
        const v = r[c.tk];
        if (v == null) continue;
        const nv = Number(v);
        if (prev[c.key] != null && (nv - prev[c.key]) >= SUPPLY_JUMP) {
          events.push({ color: c.key, t: r.read_at, from: prev[c.key], to: nv });
        }
        prev[c.key] = nv;
      }
    }
    return events;
  }

  // 장비 1대의 색상별 소모품 상태 (잔량/여분/교체이력/배송필요)
  function _supplyStatus(deviceId, latestReading, events) {
    const evs = events || _detectReplacements(state.tonerSeriesByDevice.get(deviceId) || []);
    const supplies = state.suppliesByDevice.get(deviceId) || {};
    const alarmEnabled = state.supplyConfig.has(deviceId) ? !!state.supplyConfig.get(deviceId) : true;
    const colors = [];
    let needDelivery = false;
    for (const c of SUPPLY_COLORS) {
      const lv = latestReading ? latestReading[c.tk] : null;
      if (lv == null) continue; // 장착되지 않은 색상 제외
      const level = Number(lv);
      const sup = supplies[c.key];
      const baseline = sup ? (Number(sup.spare_count) || 0) : 0;
      const setAt = sup ? sup.set_at : null;
      const colorEvents = evs.filter(e => e.color === c.key)
        .sort((a, b) => String(b.t).localeCompare(String(a.t)));
      const consumed = setAt
        ? colorEvents.filter(e => new Date(e.t) > new Date(setAt)).length
        : colorEvents.length;
      const remaining = Math.max(0, baseline - consumed);
      const low = level <= SUPPLY_LOW;
      // 51 미적용(여분 추적 불가) 시에는 배송필요 알림을 띄우지 않음 (오탐 방지)
      const deliver = state.suppliesAvailable && low && remaining === 0 && alarmEnabled;
      if (deliver) needDelivery = true;
      colors.push({ ...c, level, baseline, setAt, consumed, remaining, low, deliver, events: colorEvents });
    }
    return { colors, needDelivery, alarmEnabled };
  }

  // 전 장비 소모품 상태 캐시 재계산 (메인 배너/행 배지용)
  function recomputeSupplyStatus() {
    state.supplyStatusByDevice = new Map();
    for (const d of state.collectorDevices) {
      const latest = state.readingByDevice.get(d.id) || null;
      if (!latest) continue;
      const evs = _detectReplacements(state.tonerSeriesByDevice.get(d.id) || []);
      state.supplyStatusByDevice.set(d.id, _supplyStatus(d.id, latest, evs));
    }
  }

  // 상단 '소모품 배송 필요' 배너
  function renderSupplyBanner() {
    const banner = $('#supply-banner');
    if (!banner) return;
    if (!state.suppliesAvailable) { banner.style.display = 'none'; return; }
    const collectorById = new Map(state.collectors.map(c => [c.id, c]));
    const custById      = new Map(state.customers.map(c => [c.id, c]));
    const list = [];
    for (const d of state.collectorDevices) {
      const st = state.supplyStatusByDevice.get(d.id);
      if (!st || !st.needDelivery) continue;
      const c = collectorById.get(d.collector_id);
      const cust = c && c.customer_id ? custById.get(c.customer_id) : null;
      const cols = st.colors.filter(x => x.deliver).map(x => `${x.label} ${x.level}%`).join(', ');
      list.push({
        cust: cust ? (_custDisplayName(cust) || cust.company) : '미매핑',
        model: d.model || '(모델 미상)',
        asset: d.asset_number || '',
        cols,
      });
    }
    if (!list.length) { banner.style.display = 'none'; return; }
    $('#sb-count').textContent = list.length;
    $('#sb-list').innerHTML = list.map(x =>
      `<div class="sb-item">🏢 <strong>${escapeHtml(x.cust)}</strong> · ${escapeHtml(x.model)}${x.asset ? ` <span style="color:#9a3412;">(${escapeHtml(x.asset)})</span>` : ''} — <span class="sb-cols">${escapeHtml(x.cols)}</span></div>`
    ).join('');
    banner.style.display = 'flex';
  }

  // ---------- 실시간 수집기 데이터 ----------
  // 토너 본연 색상 — inline style 로 직접 박아 어떤 캐시 환경에서도 보장
  const TONER_COLORS = { K: '#1f2937', C: '#06b6d4', M: '#ec4899', Y: '#eab308' };

  // 토너 한 줄 (라벨 + % + 색상 막대) — 두 줄로 묶어 한 td 에 K/C 또는 M/Y 표시
  function _fmtTonerRow(label, val, color) {
    const hasVal = val != null && val !== '' && !Number.isNaN(Number(val));
    const n = hasVal ? Math.max(0, Math.min(100, Number(val))) : 0;
    const pctText = hasVal ? `${n}%` : '–';
    const pctColor = hasVal ? '#0f172a' : '#94a3b8';
    return `<div style="display:flex;align-items:center;gap:4px;height:14px;line-height:14px;">
      <span style="width:11px;font-size:9.5px;font-weight:800;color:${color};text-align:center;flex-shrink:0;">${label}</span>
      <span style="width:30px;font-size:10.5px;font-weight:700;font-variant-numeric:tabular-nums;text-align:right;color:${pctColor};flex-shrink:0;">${pctText}</span>
      <span style="flex:0 0 40px;height:8px;background:#eef2f7;border-radius:2px;overflow:hidden;box-shadow:inset 0 0 0 1px rgba(0,0,0,.05);">
        <span style="display:block;height:100%;width:${n}%;background:${color};transition:width .25s;"></span>
      </span>
    </div>`;
  }

  function _fmtPct(v, colorKey) {
    const ck = (colorKey || '').toUpperCase();
    const col = TONER_COLORS[ck] || '#94a3b8';
    if (v == null || v === '' || Number.isNaN(Number(v))) {
      return `<span class="tonr-cell na" style="position:relative;display:block;width:100%;height:18px;">
                <span class="tonr-bar" style="position:absolute;inset:0;background:#eef2f7;border-radius:4px;overflow:hidden;box-shadow:inset 0 0 0 1px rgba(0,0,0,.06);">
                  <span class="tonr-fill ${ck}" style="width:0;height:100%;background:${col};border-radius:4px 0 0 4px;"></span>
                </span>
                <span class="tonr-text" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;color:#94a3b8;">–</span>
              </span>`;
    }
    const n = Math.max(0, Math.min(100, Number(v)));
    return `<span class="tonr-cell" style="position:relative;display:block;width:100%;height:18px;">
              <span class="tonr-bar" style="position:absolute;inset:0;background:#eef2f7;border-radius:4px;overflow:hidden;box-shadow:inset 0 0 0 1px rgba(0,0,0,.06);">
                <span class="tonr-fill ${ck}" style="width:${n}%;height:100%;background:${col};border-radius:4px 0 0 4px;transition:width .25s;"></span>
              </span>
              <span class="tonr-text" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;color:#0f172a;text-shadow:-1px -1px 0 rgba(255,255,255,.95),1px -1px 0 rgba(255,255,255,.95),-1px 1px 0 rgba(255,255,255,.95),1px 1px 0 rgba(255,255,255,.95),0 0 3px rgba(255,255,255,.6);pointer-events:none;">${n}%</span>
            </span>`;
  }

  // ---------- 상태 배지 ----------
  function _statusBadges(device, latestRead) {
    const tags = [];
    const tsStr = (latestRead && latestRead.read_at) || device.last_seen_at;
    const ageMin = tsStr ? (Date.now() - new Date(tsStr).getTime()) / 60000 : null;
    // 온/오프라인 — 30분 초과 미응답이면 오프라인
    if (ageMin == null || ageMin > 30) {
      tags.push({ cls: 'offline', label: '오프라인' });
    } else {
      tags.push({ cls: 'online', label: '온라인' });
    }
    // SNMP 미응답 (PORT 후보: 네트워크 장비인데 manufacturer=null)
    const isUsb = String(device.mac || '').startsWith('USB:');
    if (!isUsb && !device.manufacturer) {
      tags.push({ cls: 'warn', label: 'SNMP꺼짐' });
    }
    // 토너 부족 (어느 하나라도 < 5%) — 정말 임박할 때만 알림
    if (latestRead) {
      const toners = [latestRead.toner_k, latestRead.toner_c, latestRead.toner_m, latestRead.toner_y]
        .filter(v => v != null);
      if (toners.length && toners.some(v => v < 5)) {
        tags.push({ cls: 'danger', label: '토너부족' });
      }
    }
    // alert_text 메시지 → 배지. collector-agent 가 SNMP hrPrinterDetectedErrorState
    // 비트를 디코드해 한국어 메시지를 콤마 구분으로 보내면 그대로 표시.
    // 'USB local printer' / 'Enable SNMP' 안내 메시지는 SNMP꺼짐/정상 안내라 제외.
    const rawAlert = String((latestRead && latestRead.alert_text) || '');
    const isInfoMsg = /usb local printer|enable snmp/i.test(rawAlert);
    if (rawAlert && !isInfoMsg) {
      const parts = rawAlert.split(/[,;/|]+/).map(s => s.trim()).filter(Boolean);
      for (const p of parts) {
        // 위험(danger): 용지걸림 / 용지없음 / 토너없음 / 도어열림 / 서비스요청 / error 등
        // 경고(warn):  용지부족 / 토너부족 / warning 등
        let cls;
        if (/(걸림|없음|jam|stuck|misfeed|out\b|empty|critical|fatal|error|에러|오류|failure|서비스|service|도어|door)/i.test(p)) {
          cls = 'danger';
        } else if (/(부족|low|warning|warn|경고)/i.test(p)) {
          cls = 'warn';
        } else {
          cls = 'warn';
        }
        tags.push({ cls, label: p });
      }
    }
    return tags.map(t =>
      `<span class="st-tag ${t.cls}" title="${escapeHtml(rawAlert)}"><span class="st-dot"></span>${t.label}</span>`
    ).join('');
  }
  function _fmtAgoKor(iso) {
    if (!iso) return '–';
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return '–';
    const diffMin = Math.round((Date.now() - t) / 60000);
    if (diffMin < 1)   return '방금';
    if (diffMin < 60)  return `${diffMin}분 전`;
    const h = Math.floor(diffMin / 60);
    if (h < 24)        return `${h}시간 전`;
    const d = Math.floor(h / 24);
    return `${d}일 전`;
  }
  function _classifySource(dev) {
    const mac = String(dev.mac || '');
    if (mac.startsWith('USB:'))            return 'USB';
    if ((dev.manufacturer || '') === '')    return 'PORT';
    return 'SNMP';
  }
  function _buildRowHtml(d, c, cust, r) {
    const src = _classifySource(d);
    const modelCell = d.manufacturer
      ? `${escapeHtml(d.model || '–')} <span class="muted-cell" style="font-size:11px;">(${escapeHtml(d.manufacturer)})</span>`
      : escapeHtml(d.model || '–');
    // 자산번호 셀: device.asset_number 수기 입력 값을 그대로 표시. 더블클릭 시 직접 편집.
    // 거래처에 동일 모델 2대 이상이면 자동 매핑이 모호하므로 device 별로 사용자가 직접 식별.
    const devAsset = (d.asset_number || '').trim();
    const assetCell = devAsset
      ? `<span style="font-weight:600;color:#0369a1;">🏷 ${escapeHtml(devAsset)}</span>`
      : `<span style="color:#94a3b8;font-style:italic;">미입력</span>`;
    // 인라인 편집 가능 셀에 데이터 속성 (PC 셀은 행에서 제거됨 → 서브 그룹 헤더로 이동)
    const modelAttr =       ` data-edit="model" data-device-id="${escapeHtml(d.id)}"`;
    const assetAttr =       ` data-edit="asset" data-device-id="${escapeHtml(d.id)}"`;
    // 거래처 인라인 편집 속성 — collector 단위로 변경 (해당 PC의 customer_id)
    const collectorId   = c ? c.id : '';
    const currentCustId = c ? (c.customer_id || '') : '';
    const custAttr = collectorId
      ? ` data-edit="customer" data-collector-id="${escapeHtml(collectorId)}" data-current-id="${escapeHtml(currentCustId)}"`
      : '';
    // IP 셀: USB면 'USB' 라벨, 네트워크면 IP만 표시 (MAC 제거)
    const ipDisplay = src === 'USB'
      ? `<span style="font-size:11px;color:#6b7280;font-family:monospace;">USB</span>`
      : `<span style="font-size:11.5px;">${escapeHtml(d.ip || '–')}</span>`;
    const ts = r.read_at || d.last_seen_at;
    const ago = _fmtAgoKor(ts);
    const stale = ts && (Date.now() - new Date(ts).getTime()) > 30 * 60 * 1000;
    let statusBadgesHtml = _statusBadges(d, r);
    // 소모품 배송 필요 배지 (여분 없음 + 잔량≤10% + 알람 ON)
    const supSt = state.supplyStatusByDevice && state.supplyStatusByDevice.get(d.id);
    if (supSt && supSt.needDelivery) {
      const cols = supSt.colors.filter(x => x.deliver).map(x => x.label).join('/');
      statusBadgesHtml += `<span class="st-tag danger" title="여분 소모품 없음 (${escapeHtml(cols)}) — 배송 필요"><span class="st-dot"></span>🧴 소모품</span>`;
    }

    // 거래처명 (카드 줄1에 표시용) — 거래처상호(trade_name) 우선, 없으면 사업자상호(company)
    const custName = cust ? escapeHtml(cust.trade_name || cust.company || '') : '';

    // 거래처 셀 내용 — 매핑된 거래처명 또는 "미매핑" 표시
    const custCellContent = cust
      ? `<span style="font-weight:600;color:#1e40af;">${custName}</span>`
      : (collectorId
        ? `<span style="color:#f59e0b;font-style:italic;font-size:11px;">미매핑 ✎</span>`
        : `<span style="color:#94a3b8;font-size:11px;">–</span>`);

    // ── 모바일 카드 3줄 구조 ──
    // 줄1: [거래처명 · 자산번호] [상태배지(우정렬)] [✕]
    //      + 아래줄: 모델명 (ellipsis)
    // 줄2: 토너 K/C/M/Y 막대 (4개 가로 배치)
    // 줄3: 카운터 흑백 / 컬러 / 합계 (가로 배치)
    const mobileLine1 = `
      <td class="mobile-only-td mob-line-1">
        <div class="mob-l1-top">
          <span class="mob-cust-asset">
            ${collectorId
              ? `<span${custAttr} class="mob-cust-name" title="탭하여 거래처 변경" style="${cust ? 'color:#1e40af;' : 'color:#f59e0b;font-style:italic;font-size:12px;'}">${cust ? custName : '미매핑'}</span><span class="mob-sep"> · </span>`
              : (custName ? `<span class="mob-cust-name">${custName}</span><span class="mob-sep"> · </span>` : '')}
            <span${assetAttr} class="mob-asset" title="탭하여 자산번호 입력">${assetCell}</span>
          </span>
          <span class="mob-status">${statusBadgesHtml}</span>
          <button class="btn-detail mob-detail" type="button" data-detail="${escapeHtml(d.id)}" title="상세 보기">🔍</button>
          <button class="btn-hide mob-hide" type="button" data-hide="${escapeHtml(d.id)}" title="삭제">✕</button>
        </div>
        <div${modelAttr} class="mob-model" title="탭하여 모델명 변경">${modelCell}${src === 'USB' ? '<span style="margin-left:6px;font-size:10px;color:#6b7280;font-family:monospace;background:#f3f4f6;padding:1px 5px;border-radius:3px;vertical-align:middle;">USB</span>' : ''}</div>
      </td>`;

    // 줄2: 토너 4개 — 모바일 전용 td
    const tonerCombinedTd = `
      <td class="live-toner-row mobile-only-td">
        <div class="live-toner-item">
          <div class="lt-key K" style="color:#1f2937;">K</div>
          ${_fmtPct(r.toner_k, 'K')}
        </div>
        <div class="live-toner-item">
          <div class="lt-key C" style="color:#06b6d4;">C</div>
          ${_fmtPct(r.toner_c, 'C')}
        </div>
        <div class="live-toner-item">
          <div class="lt-key M" style="color:#ec4899;">M</div>
          ${_fmtPct(r.toner_m, 'M')}
        </div>
        <div class="live-toner-item">
          <div class="lt-key Y" style="color:#eab308;">Y</div>
          ${_fmtPct(r.toner_y, 'Y')}
        </div>
      </td>`;

    // 줄3: 카운터 — 모바일 전용 td
    const cntCombinedTd = `
      <td class="live-cnt-row mobile-only-td">
        <div class="live-cnt-item">
          <span class="lci-label">흑백</span>
          <span class="lci-val">${r.bw == null ? '–' : fmtInt(r.bw)}</span>
        </div>
        <div class="live-cnt-item">
          <span class="lci-label">컬러</span>
          <span class="lci-val">${r.color == null ? '–' : fmtInt(r.color)}</span>
        </div>
        <div class="live-cnt-item lci-total">
          <span class="lci-label">합계</span>
          <span class="lci-val lci-total-val">${r.total_pages == null ? '–' : fmtInt(r.total_pages)}</span>
        </div>
      </td>`;

    return `
      <tr>
        ${mobileLine1}
        ${tonerCombinedTd}
        ${cntCombinedTd}
        <td class="desktop-only-td model-with-status" data-label="모델">
          <div${modelAttr} class="model-name" title="더블클릭으로 모델명 변경">${modelCell}</div>
          <div class="model-status-row">${statusBadgesHtml}</div>
        </td>
        <td class="desktop-only-td"${assetAttr} data-label="자산번호" title="더블클릭으로 자산번호 입력 (수기)" style="font-size:14px;">${assetCell}</td>
        <td class="tonr-col-pair desktop-only-td">
          ${_fmtTonerRow('K', r.toner_k, '#1f2937')}
          <div style="height:3px;"></div>
          ${_fmtTonerRow('C', r.toner_c, '#06b6d4')}
        </td>
        <td class="tonr-col-pair desktop-only-td">
          ${_fmtTonerRow('M', r.toner_m, '#ec4899')}
          <div style="height:3px;"></div>
          ${_fmtTonerRow('Y', r.toner_y, '#eab308')}
        </td>
        <td class="num desktop-only-td">${r.bw == null ? '–' : fmtInt(r.bw)}</td>
        <td class="num desktop-only-td">${r.color == null ? '–' : fmtInt(r.color)}</td>
        <td class="num desktop-only-td">${r.total_pages == null ? '–' : fmtInt(r.total_pages)}</td>
        <td class="hide-mobile ${stale ? 'ts-stale' : ''}">${ago}</td>
        <td class="hide-mobile" style="max-width:100px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;" title="${escapeHtml(d.ip || '')}">${ipDisplay}</td>
        <td class="desktop-only-td"${custAttr} data-label="거래처"
            title="${collectorId ? '더블클릭으로 거래처 변경' : ''}"
            style="min-width:90px;max-width:130px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;"
            >${custCellContent}</td>
        <td class="desktop-only-td" style="white-space:nowrap;"><button class="btn-detail" type="button" data-detail="${escapeHtml(d.id)}" title="장비 상세 보기">🔍</button><button class="btn-hide" type="button" data-hide="${escapeHtml(d.id)}" title="이 장비를 실시간 목록에서 삭제 (디직스코리아 제품 아님 등)">✕</button></td>
      </tr>`;
  }

  function renderLiveSection() {
    const collectorById = new Map(state.collectors.map(c => [c.id, c]));
    const custById      = new Map(state.customers.map(c => [c.id, c]));
    const tbody = $('#live-table tbody');
    const latestEl = $('#lh-latest');
    const devEl    = $('#lh-dev');

    devEl.textContent = state.collectorDevices.length.toLocaleString();

    if (!state.collectorDevices.length) {
      tbody.innerHTML = `<tr><td class="live-empty" colspan="15">
        등록된 실시간 장비가 없습니다.<br>
        <span style="font-size:11.5px;color:#94a3b8;">
          고객 PC 의 <strong>디직스코리아 카운터 수집기</strong> → 트레이 → LAN 스캔 → 디직스코리아 제품 체크 → "선택 항목 업로드" 로 등록됩니다.
        </span>
      </td></tr>`;
      latestEl.textContent = '–';
      return;
    }

    // 1) 각 device 에 collector/customer/reading 매핑
    const enriched = state.collectorDevices.map(d => {
      const c    = collectorById.get(d.collector_id);
      const cust = c && c.customer_id ? custById.get(c.customer_id) : null;
      const r    = state.readingByDevice.get(d.id) || {};
      return { device: d, collector: c, customer: cust, reading: r };
    });

    // 1-b) 검색어 필터링 (거래처명 / 모델명 / 자산번호 — 부분 일치, 대소문자 무시)
    const searchQ = (state.collectorSearch || '').trim().toLowerCase();
    const filteredEnriched = searchQ
      ? enriched.filter(({ device: d, customer: cust }) => {
          const custName  = cust ? (cust.trade_name || cust.company || '').toLowerCase() : '';
          const model     = (d.model    || '').toLowerCase();
          const assetNum  = (d.asset_number || '').toLowerCase();
          return custName.includes(searchQ) || model.includes(searchQ) || assetNum.includes(searchQ);
        })
      : enriched;

    // 검색 결과 카운트 표시
    const countEl = document.getElementById('live-search-count');
    if (countEl) {
      if (searchQ) {
        countEl.style.display = 'inline';
        countEl.innerHTML = `<strong>${filteredEnriched.length}</strong> / ${enriched.length}대`;
      } else {
        countEl.style.display = 'none';
      }
    }

    if (searchQ && filteredEnriched.length === 0) {
      tbody.innerHTML = `<tr><td class="live-empty" colspan="15" style="padding:28px;text-align:center;color:var(--muted);">
        "<strong>${escapeHtml(state.collectorSearch)}</strong>" 에 해당하는 장비가 없습니다.
      </td></tr>`;
      latestEl.textContent = '–';
      return;
    }

    // 2) customer_id 기준 그룹화 (미매핑은 별도)
    const groups = new Map();
    for (const item of filteredEnriched) {
      const key = item.customer ? item.customer.id : '__unmapped__';
      if (!groups.has(key)) {
        groups.set(key, { customer: item.customer, items: [] });
      }
      groups.get(key).items.push(item);
    }

    // 3) 그룹 정렬: 거래처명 가나다 → 미매핑 마지막
    const groupArr = Array.from(groups.values()).sort((a, b) => {
      if (!a.customer && !b.customer) return 0;
      if (!a.customer) return 1;
      if (!b.customer) return -1;
      return (a.customer.trade_name || a.customer.company || '').localeCompare(b.customer.trade_name || b.customer.company || '', 'ko');
    });

    // 4) 각 그룹 내부 정렬: 최근 갱신 우선
    groupArr.forEach(g => g.items.sort((a, b) =>
      String(b.reading.read_at || '').localeCompare(String(a.reading.read_at || ''))));

    // 5) 렌더 + 최신 timestamp 추적
    //    구조: 거래처 그룹 헤더 → collector 서브 헤더 ('💻 프로그램설치PC: 이름') → device 행
    //    같은 PC 의 장비가 여러 대일 때 PC 이름이 행마다 반복되는 것을 방지하기 위해 서브 그룹화.
    let latestTs = null;
    const blocks = groupArr.map(g => {
      const unmapped = !g.customer;
      const title = unmapped
        ? `<span class="group-icon">🏷</span>(미매핑)`
        : `<span class="group-icon">🏢</span>${escapeHtml(g.customer.trade_name || g.customer.company)}`;
      // 그룹 안 collector 들 — 거래처 일괄 변경 대상
      const collectorIds = [...new Set(g.items.map(i => i.collector && i.collector.id).filter(Boolean))];
      const editGroupBtn = collectorIds.length
        ? `<button type="button" class="group-edit-btn"
              data-collector-ids="${escapeHtml(collectorIds.join(','))}"
              data-current-cust="${escapeHtml(g.customer ? g.customer.id : '')}"
              title="이 그룹의 PC ${collectorIds.length}대를 다른 거래처로 변경">거래처변경</button>`
        : '';

      // 5-1) 그룹 안 collector 별로 묶어서 PC 이름 칩(💻)을 그룹 헤더 옆에 나열.
      // 같은 collector 의 device 들은 행 순서로 인접하지만 별도 서브 헤더는 두지 않음.
      const subMap = new Map();
      for (const it of g.items) {
        const cid = it.collector ? it.collector.id : '__nocoll__';
        if (!subMap.has(cid)) subMap.set(cid, { collector: it.collector, items: [] });
        subMap.get(cid).items.push(it);
      }
      const subArr = Array.from(subMap.values()).sort((a, b) =>
        ((a.collector && a.collector.pc_name) || '').localeCompare((b.collector && b.collector.pc_name) || '', 'ko'));

      const pcChipsHtml = subArr.map(sg => {
        const pcName = sg.collector ? (sg.collector.pc_name || '(이름없음)') : '(수집기 미확인)';
        const pcAttr = sg.collector
          ? ` data-edit="pc" data-collector-id="${escapeHtml(sg.collector.id)}" title="더블클릭으로 PC 이름 변경"`
          : '';
        return `<span class="group-pc-chip"${pcAttr}>💻 ${escapeHtml(pcName)}</span>`;
      }).join('');

      const head = `
        <tr class="group-row${unmapped ? ' unmapped' : ''}">
          <td colspan="15">${title}<span class="group-count">${g.items.length}대</span>${pcChipsHtml}${editGroupBtn}</td>
        </tr>`;

      const rowsHtml = subArr.map(sg =>
        sg.items.map(({ device: d, collector: c, customer: cust, reading: r }) => {
          if (r.read_at && (!latestTs || r.read_at > latestTs)) latestTs = r.read_at;
          return _buildRowHtml(d, c, cust, r);
        }).join('')
      ).join('');

      return head + rowsHtml;
    }).join('');

    tbody.innerHTML = blocks;
    latestEl.textContent = _fmtAgoKor(latestTs);
  }

  // ---------- 인라인 편집 (PC / 모델 / 거래처) ----------
  function _editText(cell, currentText, onSave) {
    cell.innerHTML = `<input type="text" class="inline-edit" value="${escapeHtml(currentText)}">`;
    const input = cell.querySelector('input');
    input.focus(); input.select();
    let done = false;
    const finish = (commit) => {
      if (done) return; done = true;
      if (commit) {
        const val = input.value.trim();
        onSave(val);
      } else {
        renderLiveSection();
      }
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter')  { ev.preventDefault(); finish(true); }
      if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
  }

  // ── 거래처 검색 콤보박스 (데스크탑 인라인 편집용) ──
  // customers: [{id, company, trade_name}] 배열, currentId: 현재 선택 id, onSave(id|null) 콜백
  // 표시·검색은 거래처상호(trade_name) 우선, 없으면 사업자상호(company) fallback
  function _custDisplayName(c) { return c.trade_name || c.company || ''; }
  function _editCustomerCombo(cell, customers, currentId, onSave) {
    const MAX = 20;
    const sortedCusts = customers
      .filter(c => c.active !== false && !c.archived_at)
      .sort((a, b) => _custDisplayName(a).localeCompare(_custDisplayName(b), 'ko'));
    const currentName = currentId
      ? (_custDisplayName(sortedCusts.find(c => c.id === currentId) || {}))
      : '';

    cell.innerHTML = `
      <div class="custmap-combo" style="position:relative;min-width:160px;">
        <input type="search"
               class="custmap-input inline-edit"
               value="${escapeHtml(currentName)}"
               placeholder="거래처 검색…"
               autocomplete="off" autocorrect="off" spellcheck="false"
               style="width:100%;padding:3px 6px;box-sizing:border-box;">
      </div>`;

    const input = cell.querySelector('.custmap-input');

    // 드롭다운을 body에 portal로 붙여 overflow:hidden 잘림 방지
    const list = document.createElement('div');
    list.className = 'custmap-list';
    list.style.cssText = 'display:none;position:fixed;background:#fff;border:1px solid #2563eb;border-radius:0 0 6px 6px;box-shadow:0 4px 12px rgba(0,0,0,.2);z-index:99999;max-height:220px;overflow-y:auto;font-size:12px;';
    document.body.appendChild(list);

    // 입력창 위치에 맞춰 드롭다운 좌표 계산 (fixed 기준)
    function positionList() {
      const r = input.getBoundingClientRect();
      const spaceBelow = window.innerHeight - r.bottom;
      const listH = Math.min(220, list.scrollHeight || 220);
      list.style.width = Math.max(r.width, 160) + 'px';
      list.style.left   = r.left + 'px';
      list.style.zIndex = '99999'; // 표 행/sticky헤더/모달보다 항상 위에
      if (spaceBelow >= listH || spaceBelow >= 120) {
        // 아래쪽으로 펼치기
        list.style.top    = r.bottom + 'px';
        list.style.bottom = 'auto';
        list.style.borderRadius = '0 0 6px 6px';
      } else {
        // 공간 부족 — 위쪽으로 펼치기
        list.style.bottom = (window.innerHeight - r.top) + 'px';
        list.style.top    = 'auto';
        list.style.borderRadius = '6px 6px 0 0';
      }
    }

    let selectedId = currentId || null;
    let done = false;

    function renderList(q) {
      const lq = (q || '').toLowerCase();
      const matched = lq
        ? sortedCusts.filter(c => _custDisplayName(c).toLowerCase().includes(lq))
        : sortedCusts;
      const items = [{ id: '', company: '— 미매핑 —', trade_name: '' }, ...matched];
      const shown = items.slice(0, MAX + 1); // +1 = "더 입력" 안내 판단용
      let html = '';
      for (let i = 0; i < Math.min(shown.length, MAX); i++) {
        const c = shown[i];
        const sel = c.id === (selectedId || '') ? ' style="background:#eff6ff;font-weight:700;"' : '';
        html += `<div class="custmap-item" data-id="${escapeHtml(c.id)}"${sel}
                  style="padding:6px 10px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
                  >${escapeHtml(_custDisplayName(c) || c.company)}</div>`;
      }
      if (matched.length > MAX) {
        html += `<div style="padding:5px 10px;color:#94a3b8;font-size:11px;border-top:1px solid #f1f5f9;">더 입력하면 결과가 줄어듭니다 (${matched.length}건 중 ${MAX}건 표시)</div>`;
      }
      list.innerHTML = html;
      list.style.display = 'block';
      positionList();
    }

    // 스크롤/리사이즈 시 드롭다운 위치 재계산
    const reposition = () => { if (list.style.display !== 'none') positionList(); };
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);

    function finish(commit) {
      if (done) return; done = true;
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      list.style.display = 'none';
      list.remove(); // body에서 portal 제거
      if (commit) onSave(selectedId);
      else renderLiveSection();
    }

    // 아이템 클릭 — mousedown 으로 blur 보다 먼저 처리
    list.addEventListener('mousedown', (e) => {
      const item = e.target.closest('.custmap-item');
      if (!item) return;
      e.preventDefault();
      selectedId = item.dataset.id || null;
      done = false; // finish 재진입 허용
      finish(true);
    });

    input.addEventListener('input', () => {
      selectedId = null; // 직접 입력 중 = 미선택
      renderList(input.value);
    });
    input.addEventListener('focus', () => renderList(input.value));
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
      if (ev.key === 'Enter') {
        // Enter 시 첫 번째 아이템 선택
        const first = list.querySelector('.custmap-item');
        if (first) { selectedId = first.dataset.id || null; finish(true); }
        else finish(false);
        ev.preventDefault();
      }
      if (ev.key === 'ArrowDown') {
        const items = list.querySelectorAll('.custmap-item');
        if (items.length) { items[0].focus(); ev.preventDefault(); }
      }
    });
    input.addEventListener('blur', () => {
      // list mousedown 이 먼저 실행된 경우 done=true 이므로 무시됨
      setTimeout(() => finish(selectedId !== undefined ? true : false), 150);
    });

    // 키보드 방향키 — list 아이템 포커스
    list.addEventListener('keydown', (ev) => {
      const items = Array.from(list.querySelectorAll('.custmap-item'));
      const idx = items.indexOf(document.activeElement);
      if (ev.key === 'ArrowDown' && idx < items.length - 1) { items[idx + 1].focus(); ev.preventDefault(); }
      if (ev.key === 'ArrowUp') {
        if (idx > 0) { items[idx - 1].focus(); ev.preventDefault(); }
        else { input.focus(); ev.preventDefault(); }
      }
      if (ev.key === 'Enter' && idx >= 0) {
        selectedId = items[idx].dataset.id || null;
        finish(true); ev.preventDefault();
      }
      if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
    });
    // list 아이템 tabindex
    list.addEventListener('mouseenter', () => {
      list.querySelectorAll('.custmap-item').forEach(el => el.setAttribute('tabindex', '-1'));
    });

    input.focus(); input.select();
    renderList('');
  }

  function _editSelect(cell, options, currentId, onSave) {
    cell.innerHTML = `<select class="inline-edit">${options}</select>`;
    const sel = cell.querySelector('select');
    sel.value = currentId || '';
    sel.focus();
    let done = false;
    const finish = (commit) => {
      if (done) return; done = true;
      if (commit) onSave(sel.value || null);
      else renderLiveSection();
    };
    sel.addEventListener('change', () => finish(true));
    sel.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
    });
    sel.addEventListener('blur', () => setTimeout(() => finish(true), 100));
  }

  async function editPcName(collectorId, cell) {
    const cur = state.collectors.find(c => c.id === collectorId);
    _editText(cell, cur?.pc_name || '', async (val) => {
      try {
        const supa = window.totalasAuth;
        const { error } = await supa.from('rental_collectors')
          .update({ pc_name: val, updated_at: new Date().toISOString() })
          .eq('id', collectorId);
        if (error) throw error;
        if (cur) cur.pc_name = val;
        renderLiveSection();
        showToast('PC 이름 변경됨');
      } catch (e) {
        showToast('저장 실패: ' + (e.message || e));
        renderLiveSection();
      }
    });
  }

  async function editModel(deviceId, cell) {
    const cur = state.collectorDevices.find(d => d.id === deviceId);
    _editText(cell, cur?.model || '', async (val) => {
      try {
        const supa = window.totalasAuth;
        const { error } = await supa.from('rental_collector_devices')
          .update({ model: val })
          .eq('id', deviceId);
        if (error) throw error;
        if (cur) cur.model = val;
        renderLiveSection();
        showToast('모델명 변경됨');
      } catch (e) {
        showToast('저장 실패: ' + (e.message || e));
        renderLiveSection();
      }
    });
  }

  // 그룹 헤더 — 거래처 일괄 변경 (잘못 입력된 거래처명 정정 등)
  // 그룹 안의 모든 collector 의 customer_id 를 한 번에 변경. 임대거래처 마스터에서 선택.
  function openGroupCustomerEdit(btn) {
    const collectorIds = (btn.dataset.collectorIds || '').split(',').filter(Boolean);
    const currentId = btn.dataset.currentCust || '';
    if (!collectorIds.length) return;
    const cell = btn.closest('td');
    if (!cell) return;
    const originalHTML = cell.innerHTML;

    // combobox wrapper + 취소/저장 버튼 (드롭다운은 body portal — absolute 방식은 테이블 행에 덮힘)
    cell.innerHTML = `
      <div style="display:inline-flex;gap:6px;align-items:center;padding:2px 0;flex-wrap:wrap;">
        <span style="font-weight:700;color:#1e40af;font-size:12.5px;">PC ${collectorIds.length}대 → 거래처:</span>
        <div class="group-cust-combo" style="position:relative;display:inline-block;min-width:200px;vertical-align:middle;">
          <input type="search" class="group-cust-input"
            style="width:100%;padding:4px 8px;border:1px solid #2563eb;border-radius:4px;font-size:12.5px;font-family:inherit;box-sizing:border-box;"
            placeholder="거래처 검색…" autocomplete="off" autocorrect="off" spellcheck="false">
        </div>
        <button type="button" class="group-cust-cancel btn-mini" style="padding:3px 10px;border:1px solid #cbd5e1;background:#fff;border-radius:4px;cursor:pointer;font-size:12px;">취소</button>
        <button type="button" class="group-cust-save btn-mini primary" style="padding:3px 12px;border:0;background:#1e40af;color:#fff;border-radius:4px;cursor:pointer;font-weight:700;font-size:12px;">저장</button>
      </div>
    `;

    const sortedCusts = state.customers
      .filter(c => c.active !== false && !c.archived_at)
      .sort((a, b) => _custDisplayName(a).localeCompare(_custDisplayName(b), 'ko'));
    const currentName = currentId ? _custDisplayName(sortedCusts.find(c => c.id === currentId) || {}) : '';

    const input = cell.querySelector('.group-cust-input');
    input.value = currentName;
    let selectedId = currentId || null;
    const MAX = 20;

    // 드롭다운을 body에 portal로 붙여 테이블 행/sticky헤더에 의한 z-index 덮힘 방지
    const list = document.createElement('div');
    list.className = 'group-cust-list';
    list.style.cssText = 'display:none;position:fixed;background:#fff;border:1px solid #2563eb;border-radius:0 0 6px 6px;box-shadow:0 4px 12px rgba(0,0,0,.2);z-index:2147483647;max-height:220px;overflow-y:auto;font-size:12px;';
    document.body.appendChild(list);

    function positionGroupList() {
      const r = input.getBoundingClientRect();
      const spaceBelow = window.innerHeight - r.bottom;
      const listH = Math.min(220, list.scrollHeight || 220);
      list.style.width = Math.max(r.width, 200) + 'px';
      list.style.left  = r.left + 'px';
      if (spaceBelow >= listH || spaceBelow >= 120) {
        list.style.top    = r.bottom + 'px';
        list.style.bottom = 'auto';
        list.style.borderRadius = '0 0 6px 6px';
      } else {
        list.style.bottom = (window.innerHeight - r.top) + 'px';
        list.style.top    = 'auto';
        list.style.borderRadius = '6px 6px 0 0';
      }
    }

    const repositionGroup = () => { if (list.style.display !== 'none') positionGroupList(); };
    window.addEventListener('scroll', repositionGroup, true);
    window.addEventListener('resize', repositionGroup);

    function hideGroupList() {
      list.style.display = 'none';
    }

    function cleanupGroupList() {
      window.removeEventListener('scroll', repositionGroup, true);
      window.removeEventListener('resize', repositionGroup);
      list.remove();
    }

    function renderGroupList(q) {
      const lq = (q || '').toLowerCase();
      const matched = lq
        ? sortedCusts.filter(c => _custDisplayName(c).toLowerCase().includes(lq))
        : sortedCusts;
      const pool = [{ id: '', company: '— 미매핑 —', trade_name: '' }, ...matched];
      let html = '';
      for (let i = 0; i < Math.min(pool.length, MAX); i++) {
        const c = pool[i];
        const sel = c.id === (selectedId || '') ? ' style="background:#eff6ff;font-weight:700;"' : '';
        html += `<div class="group-cust-item" data-id="${escapeHtml(c.id)}"${sel}
                   style="padding:6px 10px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
                 >${escapeHtml(_custDisplayName(c) || c.company)}</div>`;
      }
      if (matched.length > MAX) {
        html += `<div style="padding:5px 10px;color:#94a3b8;font-size:11px;border-top:1px solid #f1f5f9;">더 입력하면 결과가 줄어듭니다 (${matched.length}건 중 ${MAX}건 표시)</div>`;
      }
      list.innerHTML = html;
      list.style.display = 'block';
      positionGroupList();
    }

    list.addEventListener('mousedown', (e) => {
      const item = e.target.closest('.group-cust-item');
      if (!item) return;
      e.preventDefault();
      selectedId = item.dataset.id || null;
      input.value = item.textContent.trim() === '— 미매핑 —' ? '' : item.textContent.trim();
      hideGroupList();
      input.focus();
    });
    input.addEventListener('input', () => { selectedId = null; renderGroupList(input.value); });
    input.addEventListener('focus', () => renderGroupList(input.value));
    input.addEventListener('blur', () => setTimeout(() => hideGroupList(), 150));
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { cleanupGroupList(); cell.innerHTML = originalHTML; ev.preventDefault(); }
    });

    cell.querySelector('.group-cust-cancel').addEventListener('click', () => {
      cleanupGroupList();
      cell.innerHTML = originalHTML;
    });

    cell.querySelector('.group-cust-save').addEventListener('click', async () => {
      cleanupGroupList();
      // selectedId 가 null 이면 입력값으로 재검색해 단일 매치 사용
      let newId = selectedId;
      if (!newId && newId !== '') {
        const q = (input.value || '').trim().toLowerCase();
        const m = q ? sortedCusts.filter(c => _custDisplayName(c).toLowerCase().includes(q)) : [];
        newId = m.length === 1 ? m[0].id : null;
      }
      newId = newId || null;
      try {
        const supa = window.totalasAuth;
        const { error } = await supa.from('rental_collectors')
          .update({
            customer_id: newId,
            status: newId ? 'active' : 'pending',
            updated_at: new Date().toISOString(),
          })
          .in('id', collectorIds);
        if (error) throw error;
        for (const id of collectorIds) {
          const c = state.collectors.find(x => x.id === id);
          if (c) { c.customer_id = newId; c.status = newId ? 'active' : 'pending'; }
        }
        renderLiveSection();
        renderCollectorPanel();
        const dest = newId ? (_custDisplayName(state.customers.find(c => c.id === newId) || {}) || '거래처') : '미매핑';
        showToast(`PC ${collectorIds.length}대 → ${dest} 로 이동 완료`);
      } catch (e) {
        showToast('저장 실패: ' + (e.message || e));
        renderLiveSection();
      }
    });

    input.focus(); input.select();
    renderGroupList('');
  }

  // 🏷 자산번호 수기 입력 — device 별로 직접 저장 (rental_collector_devices.asset_number)
  async function editAssetNumber(deviceId, cell) {
    const cur = state.collectorDevices.find(d => d.id === deviceId);
    _editText(cell, cur?.asset_number || '', async (val) => {
      try {
        const supa = window.totalasAuth;
        const { error } = await supa.from('rental_collector_devices')
          .update({ asset_number: val || null })
          .eq('id', deviceId);
        if (error) throw error;
        if (cur) cur.asset_number = val || null;
        renderLiveSection();
        showToast(val ? `자산번호 '${val}' 저장됨` : '자산번호 해제됨');
      } catch (e) {
        showToast('저장 실패: ' + (e.message || e));
        renderLiveSection();
      }
    });
  }

  async function editCustomer(collectorId, currentId, cell) {
    _editCustomerCombo(cell, state.customers, currentId, async (val) => {
      try {
        const supa = window.totalasAuth;
        const { error } = await supa.from('rental_collectors')
          .update({
            customer_id: val || null,
            status: val ? 'active' : 'pending',
            updated_at: new Date().toISOString(),
          })
          .eq('id', collectorId);
        if (error) throw error;
        const cur = state.collectors.find(c => c.id === collectorId);
        if (cur) { cur.customer_id = val || null; cur.status = val ? 'active' : 'pending'; }
        renderLiveSection();
        renderCollectorPanel();
        showToast(val ? '거래처 변경됨' : '거래처 해제됨');
      } catch (e) {
        showToast('저장 실패: ' + (e.message || e));
        renderLiveSection();
      }
    });
  }

  async function hideLiveDevice(deviceId) {
    const supa = window.totalasAuth;
    try {
      const { error } = await supa.from('rental_collector_devices')
        .update({ hidden: true })
        .eq('id', deviceId);
      if (error) throw error;
      // 로컬 state 에서 즉시 제거
      state.collectorDevices = state.collectorDevices.filter(x => x.id !== deviceId);
      state.readingByDevice.delete(deviceId);
      renderLiveSection();
      renderCollectorPanel();
      showToast('삭제됨 — 다음 폴링에서도 재등장하지 않습니다');
    } catch (e) {
      console.error('[rental-equipment] hide device 실패:', e);
      const msg = (e && e.message) || String(e);
      if (/column .*hidden/i.test(msg)) {
        showToast('hidden 컬럼이 없습니다. 34_collector_device_hidden.sql 적용 필요');
      } else {
        showToast('삭제 실패: ' + msg);
      }
    }
  }

  // ---------- 모바일 인라인 편집 모달 ----------
  let _mobileEditCtx = null; // { kind, targetId, currentVal }

  function openMobileEditText(labelText, targetId, kind) {
    const dev = (kind === 'model' || kind === 'asset')
      ? state.collectorDevices.find(d => d.id === targetId)
      : null;
    const cur = kind === 'pc'
      ? (state.collectors.find(c => c.id === targetId)?.pc_name || '')
      : kind === 'asset'
        ? (dev?.asset_number || '')
        : (dev?.model || '');
    _mobileEditCtx = { kind, targetId };
    $('#mem-label').textContent = labelText;
    $('#mem-input-wrap').innerHTML =
      `<input type="text" id="mem-input" value="${escapeHtml(cur)}" placeholder="${escapeHtml(labelText)} 입력" autocomplete="off">`;
    $('#mobile-edit-modal').classList.add('show');
    requestAnimationFrame(() => {
      const inp = $('#mem-input');
      if (inp) { inp.focus(); inp.select(); }
    });
    // 저장 버튼 핸들러 (1회용)
    const saveBtn = $('#mem-save');
    const newSave = saveBtn.cloneNode(true);
    saveBtn.parentNode.replaceChild(newSave, saveBtn);
    newSave.addEventListener('click', async () => {
      const val = ($('#mem-input')?.value || '').trim();
      closeMobileEditModal();
      if (kind === 'pc') {
        const col = state.collectors.find(c => c.id === targetId);
        try {
          const { error } = await window.totalasAuth.from('rental_collectors')
            .update({ pc_name: val, updated_at: new Date().toISOString() })
            .eq('id', targetId);
          if (error) throw error;
          if (col) col.pc_name = val;
          renderLiveSection(); showToast('PC 이름 변경됨');
        } catch (e) { showToast('저장 실패: ' + (e.message || e)); renderLiveSection(); }
      } else if (kind === 'asset') {
        const dev = state.collectorDevices.find(d => d.id === targetId);
        try {
          const { error } = await window.totalasAuth.from('rental_collector_devices')
            .update({ asset_number: val || null })
            .eq('id', targetId);
          if (error) throw error;
          if (dev) dev.asset_number = val || null;
          renderLiveSection(); showToast(val ? `자산번호 '${val}' 저장됨` : '자산번호 해제됨');
        } catch (e) { showToast('저장 실패: ' + (e.message || e)); renderLiveSection(); }
      } else {
        const dev = state.collectorDevices.find(d => d.id === targetId);
        try {
          const { error } = await window.totalasAuth.from('rental_collector_devices')
            .update({ model: val })
            .eq('id', targetId);
          if (error) throw error;
          if (dev) dev.model = val;
          renderLiveSection(); showToast('모델명 변경됨');
        } catch (e) { showToast('저장 실패: ' + (e.message || e)); renderLiveSection(); }
      }
    });
  }

  function openMobileEditCustomer(collectorId, currentId) {
    _mobileEditCtx = { kind: 'customer', targetId: collectorId };
    $('#mem-label').textContent = '거래처';

    const sortedCusts = state.customers
      .filter(c => c.active !== false && !c.archived_at)
      .sort((a, b) => _custDisplayName(a).localeCompare(_custDisplayName(b), 'ko'));
    const currentName = currentId ? _custDisplayName(sortedCusts.find(c => c.id === currentId) || {}) : '';

    // 모바일: 검색 input + 결과 리스트 (절대 위치 불필요 — 모달 내부라 스크롤 가능)
    $('#mem-input-wrap').innerHTML = `
      <div style="position:relative;">
        <input type="search" id="mem-cust-search"
          value="${escapeHtml(currentName)}"
          placeholder="거래처 이름 검색…"
          autocomplete="off" autocorrect="off" spellcheck="false"
          style="width:100%;padding:14px 16px;border:2px solid #2563eb;border-radius:10px;font-size:16px;font-family:inherit;background:#fff;color:var(--text);outline:none;box-sizing:border-box;">
        <div id="mem-cust-list" style="margin-top:6px;border:1px solid #e2e8f0;border-radius:10px;overflow-y:auto;max-height:240px;background:#fff;"></div>
      </div>`;

    $('#mobile-edit-modal').classList.add('show');
    const input = $('#mem-cust-search');
    const list  = $('#mem-cust-list');
    let selectedId = currentId || null;
    const MAX = 20;

    function renderMobileList(q) {
      const lq = (q || '').toLowerCase();
      const matched = lq
        ? sortedCusts.filter(c => _custDisplayName(c).toLowerCase().includes(lq))
        : sortedCusts;
      const pool = [{ id: '', company: '— 미매핑 —', trade_name: '' }, ...matched];
      let html = '';
      for (let i = 0; i < Math.min(pool.length, MAX); i++) {
        const c = pool[i];
        const isSel = c.id === (selectedId || '');
        html += `<div class="mem-cust-item" data-id="${escapeHtml(c.id)}"
                   style="padding:13px 16px;cursor:pointer;font-size:15px;border-bottom:1px solid #f1f5f9;${isSel ? 'background:#eff6ff;font-weight:700;' : ''}"
                 >${escapeHtml(_custDisplayName(c) || c.company)}</div>`;
      }
      if (matched.length > MAX) {
        html += `<div style="padding:10px 16px;color:#94a3b8;font-size:13px;">더 입력하면 결과가 줄어듭니다 (${matched.length}건 중 ${MAX}건 표시)</div>`;
      }
      list.innerHTML = html;
    }

    // 모바일: touchstart / click 모두 처리
    list.addEventListener('click', (e) => {
      const item = e.target.closest('.mem-cust-item');
      if (!item) return;
      selectedId = item.dataset.id || null;
      // 선택 하이라이트 업데이트
      list.querySelectorAll('.mem-cust-item').forEach(el => {
        el.style.background = el === item ? '#eff6ff' : '';
        el.style.fontWeight  = el === item ? '700' : '';
      });
      input.value = selectedId
        ? _custDisplayName(sortedCusts.find(c => c.id === selectedId) || {})
        : '';
    });

    input.addEventListener('input', () => { selectedId = null; renderMobileList(input.value); });
    renderMobileList('');

    requestAnimationFrame(() => { if (input) input.focus(); });

    const saveBtn = $('#mem-save');
    const newSave = saveBtn.cloneNode(true);
    saveBtn.parentNode.replaceChild(newSave, saveBtn);
    newSave.addEventListener('click', async () => {
      // selectedId null = 직접 입력 → 단일 매치 적용
      let val = selectedId;
      if (!val && val !== '') {
        const q = (input.value || '').trim().toLowerCase();
        const m = q ? sortedCusts.filter(c => _custDisplayName(c).toLowerCase().includes(q)) : [];
        val = m.length === 1 ? m[0].id : null;
      }
      val = val || null;
      closeMobileEditModal();
      try {
        const { error } = await window.totalasAuth.from('rental_collectors')
          .update({ customer_id: val, status: val ? 'active' : 'pending', updated_at: new Date().toISOString() })
          .eq('id', collectorId);
        if (error) throw error;
        const cur = state.collectors.find(c => c.id === collectorId);
        if (cur) { cur.customer_id = val; cur.status = val ? 'active' : 'pending'; }
        renderLiveSection(); renderCollectorPanel();
        showToast(val ? '거래처 변경됨' : '거래처 해제됨');
      } catch (e) { showToast('저장 실패: ' + (e.message || e)); renderLiveSection(); }
    });
  }

  function closeMobileEditModal() {
    $('#mobile-edit-modal').classList.remove('show');
    _mobileEditCtx = null;
  }

  // ---------- 페어링 모달 ----------
  function openPairModal() {
    const pending = state.collectors.filter(c => classifyCollector(c) === 'pending');
    const tbody = $('#pair-table tbody');
    if (!pending.length) {
      tbody.innerHTML = `<tr><td colspan="3" class="empty-row">매핑 대기 중인 수집기가 없습니다.</td></tr>`;
    } else {
      // 각 행에 searchable combobox (input + list) 주입
      tbody.innerHTML = pending.map(c => `
        <tr data-id="${escapeHtml(c.id)}">
          <td>
            <div class="pc-name">${escapeHtml(c.pc_name || '(이름 없음)')}</div>
            <div class="pc-meta">${escapeHtml(c.os_user || '')} · v${escapeHtml(c.agent_version || '?')}</div>
          </td>
          <td class="muted-cell">${escapeHtml((c.paired_at || '').slice(0, 16).replace('T', ' '))}</td>
          <td class="pair-cust-td">
            <div class="pair-combo" style="position:relative;">
              <input type="search" class="pair-cust-input"
                placeholder="거래처 검색…"
                autocomplete="off" autocorrect="off" spellcheck="false"
                style="width:100%;padding:5px 8px;border:1px solid #cbd5e1;border-radius:6px;font-size:12.5px;font-family:inherit;box-sizing:border-box;">
              <div class="pair-cust-list" style="display:none;position:absolute;top:100%;left:0;right:0;background:#fff;border:1px solid #2563eb;border-radius:0 0 6px 6px;box-shadow:0 4px 12px rgba(0,0,0,.15);z-index:9999;max-height:200px;overflow-y:auto;font-size:12.5px;"></div>
              <input type="hidden" class="pair-customer-select" value="">
            </div>
          </td>
        </tr>`).join('');

      // 각 행에 combobox 동작 연결
      const sortedCusts = state.customers
        .filter(c => c.active !== false && !c.archived_at)
        .sort((a, b) => _custDisplayName(a).localeCompare(_custDisplayName(b), 'ko'));
      const MAX = 20;

      tbody.querySelectorAll('tr[data-id]').forEach(tr => {
        const input  = tr.querySelector('.pair-cust-input');
        const list   = tr.querySelector('.pair-cust-list');
        const hidden = tr.querySelector('.pair-customer-select');

        function renderPairList(q) {
          const lq = (q || '').toLowerCase();
          const matched = lq
            ? sortedCusts.filter(c => _custDisplayName(c).toLowerCase().includes(lq))
            : sortedCusts;
          let html = '';
          for (let i = 0; i < Math.min(matched.length, MAX); i++) {
            const c = matched[i];
            const isSel = c.id === hidden.value;
            html += `<div class="pair-cust-item" data-id="${escapeHtml(c.id)}"
                       style="padding:7px 10px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;${isSel ? 'background:#eff6ff;font-weight:700;' : ''}"
                     >${escapeHtml(_custDisplayName(c))}</div>`;
          }
          if (matched.length > MAX) {
            html += `<div style="padding:5px 10px;color:#94a3b8;font-size:11px;border-top:1px solid #f1f5f9;">더 입력하면 결과가 줄어듭니다 (${matched.length}건 중 ${MAX}건 표시)</div>`;
          }
          if (!html) {
            html = `<div style="padding:7px 10px;color:#94a3b8;">검색 결과 없음</div>`;
          }
          list.innerHTML = html;
          list.style.display = 'block';
        }

        list.addEventListener('mousedown', (e) => {
          const item = e.target.closest('.pair-cust-item');
          if (!item) return;
          e.preventDefault();
          hidden.value = item.dataset.id;
          input.value  = item.textContent.trim();
          list.style.display = 'none';
        });
        input.addEventListener('input', () => { hidden.value = ''; renderPairList(input.value); });
        input.addEventListener('focus', () => renderPairList(input.value));
        input.addEventListener('blur', () => setTimeout(() => { list.style.display = 'none'; }, 150));
        input.addEventListener('keydown', (ev) => {
          if (ev.key === 'Escape') { list.style.display = 'none'; }
          if (ev.key === 'ArrowDown') {
            const first = list.querySelector('.pair-cust-item');
            if (first) { first.setAttribute('tabindex', '-1'); first.focus(); ev.preventDefault(); }
          }
        });
        list.addEventListener('keydown', (ev) => {
          const items = Array.from(list.querySelectorAll('.pair-cust-item'));
          const idx = items.indexOf(document.activeElement);
          if (ev.key === 'ArrowDown' && idx < items.length - 1) { items[idx + 1].setAttribute('tabindex', '-1'); items[idx + 1].focus(); ev.preventDefault(); }
          if (ev.key === 'ArrowUp') {
            if (idx > 0) { items[idx - 1].setAttribute('tabindex', '-1'); items[idx - 1].focus(); ev.preventDefault(); }
            else { input.focus(); ev.preventDefault(); }
          }
          if (ev.key === 'Enter' && idx >= 0) {
            hidden.value = items[idx].dataset.id;
            input.value  = items[idx].textContent.trim();
            list.style.display = 'none';
            input.focus();
            ev.preventDefault();
          }
        });
      });
    }
    $('#pair-modal').classList.add('show');
  }

  function closePairModal() {
    $('#pair-modal').classList.remove('show');
  }

  async function savePairMappings() {
    const supa = window.totalasAuth;
    const rows = Array.from(document.querySelectorAll('#pair-table tbody tr[data-id]'));
    const updates = [];
    for (const tr of rows) {
      const id = tr.dataset.id;
      const customerId = tr.querySelector('.pair-customer-select')?.value;
      if (!customerId) continue;
      updates.push({ id, customer_id: customerId });
    }
    if (!updates.length) {
      showToast('매핑할 항목이 없습니다');
      return;
    }
    try {
      // 각각 UPDATE (Supabase 는 다중 UPDATE 한방 지원 X → upsert 활용)
      for (const u of updates) {
        const { error } = await supa.from('rental_collectors')
          .update({ customer_id: u.customer_id, status: 'active', updated_at: new Date().toISOString() })
          .eq('id', u.id);
        if (error) throw error;
      }
      showToast(`${updates.length}개 수집기 매핑 완료`);
      closePairModal();
      await init(true);
    } catch (err) {
      console.error('[rental-equipment] 매핑 저장 실패:', err);
      showToast('저장 실패: ' + (err.message || err));
    }
  }

  // ---------- 카운터 엑셀 다운로드 ----------
  // 실시간 수집기 데이터를 임대카운터(rental-counters/index.js)의 엑셀 업로드가
  // 그대로 받을 수 있는 "디직스카운터_YYYY_MM_DD-HH_MM_SS.xlsx" 포맷으로 내보냄.
  // 컬럼 규약(임대카운터 파서 기준): 9행부터 데이터, 열0 거래처 / 2 모델 / 3 일련 / 5 자산 / 6 IP / 9 일자 / 12 합계 / 13 흑백 / 14 컬러
  function exportCounterXlsx() {
    if (typeof XLSX === 'undefined') {
      showToast('엑셀 라이브러리 로드 실패');
      return;
    }
    const collectorById = new Map(state.collectors.map(c => [c.id, c]));
    const custById      = new Map(state.customers.map(c => [c.id, c]));

    const pad2 = n => String(n).padStart(2, '0');
    const fmtTs = iso => {
      if (!iso) return '';
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return '';
      return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
    };

    // 행 빌드 — 일련번호(열3)가 있어야 임대카운터 파서가 행으로 인정함
    const dataRows = [];
    let skipNoSerial = 0;
    let skipNoReading = 0;
    for (const d of state.collectorDevices) {
      const reading = state.readingByDevice.get(d.id);
      if (!reading || reading.bw == null && reading.color == null && reading.total_pages == null) {
        skipNoReading++;
        continue;
      }
      const serial = (d.serial_snmp || '').trim();
      if (!serial) { skipNoSerial++; continue; }
      const c    = collectorById.get(d.collector_id);
      const cust = c && c.customer_id ? custById.get(c.customer_id) : null;
      const company = cust ? (_custDisplayName(cust) || cust.company) : '1임대제품'; // 미매핑 → 파서가 자산번호로 fallback

      const row = new Array(15).fill('');
      row[0]  = company;
      row[2]  = d.model || '';
      row[3]  = serial;
      row[5]  = d.asset_number || '';
      row[6]  = d.ip || '';
      row[9]  = fmtTs(reading.read_at);
      row[12] = reading.total_pages != null ? Number(reading.total_pages) : '';
      row[13] = reading.bw != null ? Number(reading.bw) : '';
      row[14] = reading.color != null ? Number(reading.color) : '';
      dataRows.push(row);
    }

    if (!dataRows.length) {
      showToast('내보낼 카운터 데이터가 없습니다');
      return;
    }

    // ★ 파일명: 다음 달 1일 + 현재 시각 → 임대카운터의 ym 추출 결과 = "이번 달"
    //   (한별 수집기 관례상 5월 1일 파일 = 4월 마감 데이터 → 다음달 1일 파일명이 이번달 카운터)
    const now = new Date();
    const next1st = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const ymd = `${next1st.getFullYear()}_${pad2(next1st.getMonth()+1)}_${pad2(next1st.getDate())}`;
    const hms = `${pad2(now.getHours())}_${pad2(now.getMinutes())}_${pad2(now.getSeconds())}`;
    const fileName = `디직스카운터_${ymd}-${hms}.xlsx`;

    // 8행 헤더 블록 (임대카운터 파서가 9행부터 읽음 — 헤더 내용은 자유)
    const header = [
      ['디직스코리아 카운터 일괄집계'],
      [`생성: ${fmtTs(now.toISOString())}`],
      [`출처: 장비관리 실시간 수집기 데이터 (rental_collector_devices + rental_counter_readings)`],
      [`행수: ${dataRows.length}`],
      [],
      [],
      [],
      ['거래처', '', '모델', '일련번호', '', '자산번호', 'IP', '', '', '마지막갱신', '', '', '결합합계', '흑백', '컬러'],
    ];

    const ws = XLSX.utils.aoa_to_sheet(header.concat(dataRows));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '카운터');
    XLSX.writeFile(wb, fileName);

    const notes = [];
    if (skipNoReading) notes.push(`수신 없음 ${skipNoReading}대`);
    if (skipNoSerial)  notes.push(`일련번호 없음 ${skipNoSerial}대`);
    const tail = notes.length ? ` (${notes.join(', ')} 제외)` : '';
    showToast(`${dataRows.length}대 카운터 엑셀 생성됨${tail}`);
  }

  // ============================================================
  // 장비 상세 오버레이 (기본정보 + 현재상태 + 카운터/토너 추이 + 메모)
  // ============================================================
  let _detailDeviceId = null;
  let _detailCtx = null; // { d, readings, latest, notes, notesAvailable } — 소모품 섹션 부분 갱신용

  async function openDeviceDetail(deviceId) {
    const d = state.collectorDevices.find(x => x.id === deviceId);
    if (!d) { showToast('장비 정보를 찾을 수 없습니다'); return; }
    _detailDeviceId = deviceId;
    const c    = state.collectors.find(x => x.id === d.collector_id) || null;
    const cust = c && c.customer_id ? state.customers.find(x => x.id === c.customer_id) : null;
    const custName = cust ? (_custDisplayName(cust) || cust.company) : '미매핑';

    $('#dd-title').innerHTML = `🖨 ${escapeHtml(d.model || '(모델 미상)')}` +
      (d.asset_number ? ` <span style="font-size:13px;color:#0369a1;font-weight:700;">🏷 ${escapeHtml(d.asset_number)}</span>` : '');
    $('#dd-sub').textContent = `${custName}${c && c.pc_name ? ' · 💻 ' + c.pc_name : ''}`;
    $('#dd-body').innerHTML = `<div class="dd-empty">불러오는 중…</div>`;
    $('#device-detail-modal').classList.add('show');

    // 전체 이력(readings) + 메모(notes) 온디맨드 병렬 로딩
    const supa = window.totalasAuth;
    let readings = [], notes = [], notesAvailable = true;
    try {
      const [rdRes, ntRes] = await Promise.all([
        supa.from('rental_counter_readings')
            .select('bw, color, total_pages, toner_k, toner_c, toner_m, toner_y, alert_text, read_at')
            .eq('device_id', deviceId)
            .order('read_at', { ascending: true })
            .range(0, 99999),
        supa.from('rental_device_notes')
            .select('id, body, created_by, created_at')
            .eq('device_id', deviceId)
            .order('created_at', { ascending: false })
            .range(0, 9999),
      ]);
      if (!rdRes.error) readings = rdRes.data || [];
      if (ntRes.error) notesAvailable = false; // 50_device_notes.sql 미적용
      else notes = ntRes.data || [];
    } catch (e) {
      console.warn('[rental-equipment] 상세 데이터 로드 실패:', e);
    }

    // 자산(rental_items) 연결 → 월별 카운터(rental_counters) + 계약 기본카운터(rental_assignments)
    // 연결 우선순위: device.item_id → asset_number → serial_snmp
    let item = null, assignment = null, monthlyCounters = [];
    try {
      if (d.item_id) {
        const r = await supa.from('rental_items')
          .select('id, counter_mode, total_free_count, asset_number, serial').eq('id', d.item_id).maybeSingle();
        if (!r.error) item = r.data;
      } else {
        const ors = [];
        const an = (d.asset_number || '').trim().replace(/,/g, '');
        const sn = (d.serial_snmp || '').trim().replace(/,/g, '');
        if (an.length >= 2) ors.push(`asset_number.eq.${an}`);
        if (sn)            ors.push(`serial.eq.${sn}`);
        if (ors.length) {
          const r = await supa.from('rental_items')
            .select('id, counter_mode, total_free_count, asset_number, serial').or(ors.join(',')).limit(1);
          if (!r.error && r.data && r.data.length) item = r.data[0];
        }
      }
      if (item) {
        const [acRes, asRes] = await Promise.all([
          supa.from('rental_counters').select('ym, bw, color')
              .eq('item_id', item.id).order('ym', { ascending: true }).range(0, 9999),
          supa.from('rental_assignments')
              .select('bw_free, co_free, monthly_fee, customer_id, start_date, end_date').eq('item_id', item.id),
        ]);
        if (!acRes.error) monthlyCounters = acRes.data || [];
        if (!asRes.error && asRes.data && asRes.data.length) {
          const today = new Date().toISOString().slice(0, 10);
          const active = asRes.data.filter(a => !a.end_date || a.end_date >= today);
          assignment = (cust && active.find(a => a.customer_id === cust.id)) || active[0] || asRes.data[0];
        }
      }
    } catch (e) {
      console.warn('[rental-equipment] 자산/카운터 연동 로드 실패:', e);
    }

    if (_detailDeviceId !== deviceId) return; // 그 사이 닫힘/전환되면 폐기
    renderDeviceDetail(d, c, cust, readings, notes, notesAvailable, item, assignment, monthlyCounters);
  }

  function closeDeviceDetail() {
    $('#device-detail-modal').classList.remove('show');
    _detailDeviceId = null;
  }

  function renderDeviceDetail(d, c, cust, readings, notes, notesAvailable, item, assignment, monthlyCounters) {
    const latest = readings.length ? readings[readings.length - 1]
                 : (state.readingByDevice.get(d.id) || {});
    const src = _classifySource(d);
    const custName = cust ? (_custDisplayName(cust) || cust.company) : '미매핑';
    const kv = (k, v) => `<div class="dd-kv"><div class="dd-k">${k}</div><div class="dd-v">${v}</div></div>`;

    // 1. 기본정보
    const infoHtml = `
      <div class="dd-section">
        <div class="dd-h">📋 기본 정보</div>
        <div class="dd-grid">
          ${kv('거래처', escapeHtml(custName))}
          ${kv('설치 PC', escapeHtml((c && c.pc_name) || '–'))}
          ${kv('모델', escapeHtml(d.model || '–'))}
          ${kv('제조사', escapeHtml(d.manufacturer || '–'))}
          ${kv('자산번호', d.asset_number ? escapeHtml(d.asset_number) : '<span style="color:#94a3b8;">미입력</span>')}
          ${kv('일련번호', escapeHtml(d.serial_snmp || '–'))}
          ${kv('연결', src === 'USB' ? 'USB' : 'SNMP')}
          ${kv('IP', src === 'USB' ? 'USB' : escapeHtml(d.ip || '–'))}
          ${kv('유형', d.is_color ? '컬러기' : '흑백기')}
          ${kv('최초 발견', _fmtAgoKor(d.first_seen_at))}
        </div>
      </div>`;

    // 2. 현재 상태
    const statusBadgesHtml = _statusBadges(d, latest);
    const ts = latest.read_at || d.last_seen_at;
    const curHtml = `
      <div class="dd-section">
        <div class="dd-h">📊 현재 상태 <span class="dd-h-sub">${ts ? escapeHtml(_fmtAgoKor(ts)) + ' 기준' : '데이터 없음'}</span></div>
        <div class="dd-cnt">
          <div class="dd-cnt-card"><div class="dd-cnt-label">흑백 누적</div><div class="dd-cnt-val">${latest.bw == null ? '–' : fmtInt(latest.bw)}</div></div>
          <div class="dd-cnt-card"><div class="dd-cnt-label">컬러 누적</div><div class="dd-cnt-val">${latest.color == null ? '–' : fmtInt(latest.color)}</div></div>
          <div class="dd-cnt-card total"><div class="dd-cnt-label">합계 누적</div><div class="dd-cnt-val">${latest.total_pages == null ? '–' : fmtInt(latest.total_pages)}</div></div>
        </div>
        ${_renderThisMonth(_thisMonthUsage(readings, monthlyCounters), _thisMonthAllowance(item, assignment), !!item)}
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 16px;max-width:380px;margin-top:12px;">
          ${_fmtTonerRow('K', latest.toner_k, '#1f2937')}
          ${_fmtTonerRow('C', latest.toner_c, '#06b6d4')}
          ${_fmtTonerRow('M', latest.toner_m, '#ec4899')}
          ${_fmtTonerRow('Y', latest.toner_y, '#eab308')}
        </div>
        ${statusBadgesHtml ? `<div style="margin-top:10px;display:flex;gap:4px;flex-wrap:wrap;">${statusBadgesHtml}</div>` : ''}
      </div>`;

    // 3. 장치 로그 (이벤트)
    const logHtml = `
      <div class="dd-section">
        <div class="dd-h">🧾 장치 로그 <span class="dd-h-sub">용지걸림·오류 등 이벤트</span></div>
        ${_renderDeviceLog(readings)}
      </div>`;

    // 4. 카운터확인 (실시간 누적 추이 + 임대거래처 연동 월별 카운터 1년)
    const counterHtml = `
      <div class="dd-section">
        <div class="dd-h">📈 카운터확인 <span class="dd-h-sub">누적 카운터</span></div>
        ${_renderCounterTrend(readings)}
        <div class="dd-month-h">📅 월별 카운터 (최근 12개월) <span style="font-weight:500;color:var(--muted);">· 임대카운터 연동 · 1일~말일 기준</span></div>
        ${_renderMonthly12(monthlyCounters, item)}
      </div>`;

    // 5. 소모성 (토너 레벨)
    const tonerHtml = `
      <div class="dd-section">
        <div class="dd-h">🎨 소모성 <span class="dd-h-sub">토너 레벨</span></div>
        ${_renderTonerTrend(readings)}
      </div>`;

    // 6. 토너/잉크 교체 및 관리 (+ 관리 메모)
    _detailCtx = { d, readings, latest, notes, notesAvailable };
    const supplyHtml = _renderSupplySection(d, readings, latest, notes, notesAvailable);

    $('#dd-body').innerHTML = infoHtml + curHtml + logHtml + counterHtml + tonerHtml + supplyHtml;

    if (notesAvailable) {
      $('#dd-note-add').addEventListener('click', () => addDeviceNote(d.id, $('#dd-note-input').value));
    }
  }

  // 소모품 교체·여분 관리 섹션 (교체이력은 readings 에서 산출 / 여분·알람은 51 테이블)
  function _renderSupplySection(d, readings, latest, notes, notesAvailable) {
    const events = _detectReplacements(readings);
    const status = _supplyStatus(d.id, latest, events);
    const alarmEnabled = status.alarmEnabled;

    const alarmToggle = `
      <span class="dd-h-sub">
        <label class="dd-alarm"><input type="checkbox" id="dd-alarm" data-device-id="${escapeHtml(d.id)}" ${alarmEnabled ? 'checked' : ''}${state.suppliesAvailable ? '' : ' disabled'}> 부족 알람</label>
      </span>`;

    // 색상별 카드
    let colorsHtml;
    if (!status.colors.length) {
      colorsHtml = `<div class="dd-empty">토너 잔량 데이터가 없는 장비입니다.</div>`;
    } else {
      colorsHtml = status.colors.map(col => {
        const stTxt = !col.low
          ? '<span style="color:#047857;font-weight:600;">정상</span>'
          : !state.suppliesAvailable
            ? '<span style="color:#92400e;font-weight:700;">잔량 부족</span>'
            : col.remaining > 0
              ? '<span style="color:#92400e;font-weight:700;">교체 임박 (여분 사용)</span>'
              : '<span class="dd-over">❗ 여분 없음 · 배송 필요</span>';
        const spareBox = state.suppliesAvailable
          ? `고객사무실 여분 <strong class="ds-rem ds-spare-edit" data-device-id="${escapeHtml(d.id)}" data-color="${col.key}" data-cur="${col.remaining}" title="클릭하여 재고 수정">${col.remaining}</strong>개
             <button class="ds-spare-edit" type="button" data-device-id="${escapeHtml(d.id)}" data-color="${col.key}" data-cur="${col.remaining}">재고 입력</button>
             ${col.consumed ? `<span class="ds-consumed">(입력 후 ${col.consumed}회 교체 차감)</span>` : ''}`
          : `<span class="dd-sub-note" style="margin:0;">여분/알람: 51_device_supplies.sql 적용 필요</span>`;
        const hist = col.events.length
          ? `<div class="ds-history">${col.events.slice(0, 12).map(e =>
                `<div class="ds-hist-item">🔄 ${escapeHtml(_fmtFullTime(e.t))} <span class="ds-hist-delta">${e.from}% → ${e.to}%</span></div>`).join('')}</div>`
          : `<div class="ds-history"><span class="dd-sub-note" style="margin:0;">교체 기록 없음</span></div>`;
        return `
          <div class="ds-card${col.deliver ? ' deliver' : ''}">
            <div class="ds-top">
              <span class="ds-color"><span class="dd-swatch" style="background:${col.color};"></span>${col.label} (${col.key})</span>
              <span class="ds-level ${col.low ? 'low' : ''}">잔량 ${col.level}%</span>
              <span class="ds-spare">${spareBox}</span>
              <span class="ds-status">${stTxt}</span>
            </div>
            ${hist}
          </div>`;
      }).join('');
    }

    const memoBlock = `
      <div class="dd-month-h">📝 관리 메모</div>
      ${notesAvailable ? `
        <div class="dd-note-form">
          <textarea id="dd-note-input" placeholder="점검·AS·기타 관리 기록을 입력하고 추가하세요"></textarea>
          <button class="dd-note-btn" id="dd-note-add" type="button">추가</button>
        </div>
        <div class="dd-note-list" id="dd-note-list">${_renderNotes(notes)}</div>
      ` : `<div class="dd-empty">메모 기능을 쓰려면 <code>tools/sql/50_device_notes.sql</code> 을 Supabase 에 적용하세요.</div>`}`;

    return `
      <div class="dd-section">
        <div class="dd-h">🧴 토너/잉크 교체 및 관리 ${alarmToggle}</div>
        <div class="ds-cards">${colorsHtml}</div>
        ${memoBlock}
      </div>`;
  }

  function _fmtNoteTime(iso) {
    if (!iso) return '';
    const dt = new Date(iso);
    if (Number.isNaN(dt.getTime())) return '';
    const p = n => String(n).padStart(2, '0');
    return `${dt.getFullYear()}-${p(dt.getMonth()+1)}-${p(dt.getDate())} ${p(dt.getHours())}:${p(dt.getMinutes())}`;
  }

  function _renderNotes(notes) {
    if (!notes.length) return `<div class="dd-empty">아직 메모가 없습니다.</div>`;
    return notes.map(n => `
      <div class="dd-note-item">
        <div class="dd-note-body">${escapeHtml(n.body)}</div>
        <div class="dd-note-meta">
          <span>🕒 ${escapeHtml(_fmtNoteTime(n.created_at))}</span>
          ${n.created_by ? `<span>· ${escapeHtml(n.created_by)}</span>` : ''}
          <button class="dd-note-del" type="button" data-note-id="${escapeHtml(n.id)}" title="삭제">🗑</button>
        </div>
      </div>`).join('');
  }

  async function addDeviceNote(deviceId, body) {
    const text = (body || '').trim();
    if (!text) { showToast('메모 내용을 입력하세요'); return; }
    const addBtn = $('#dd-note-add');
    if (addBtn) { addBtn.disabled = true; addBtn.textContent = '저장 중…'; }
    const author = (window.currentUser &&
      (window.currentUser.full_name || window.currentUser.display_id || window.currentUser.email)) || null;
    try {
      const supa = window.totalasAuth;
      const { data, error } = await supa.from('rental_device_notes')
        .insert({ device_id: deviceId, body: text, created_by: author })
        .select('id, body, created_by, created_at');
      if (error) throw error;
      const input = $('#dd-note-input');
      if (input) input.value = '';
      const listEl = $('#dd-note-list');
      if (listEl) {
        if (listEl.querySelector('.dd-empty')) listEl.innerHTML = '';
        listEl.insertAdjacentHTML('afterbegin', _renderNotes(data || []));
      }
      if (_detailCtx && data && data[0]) _detailCtx.notes.unshift(data[0]); // 부분 갱신 캐시 동기화
      showToast('메모 추가됨');
    } catch (e) {
      showToast('저장 실패: ' + (e.message || e));
    } finally {
      if (addBtn) { addBtn.disabled = false; addBtn.textContent = '추가'; }
    }
  }

  async function deleteDeviceNote(noteId, itemEl) {
    try {
      const supa = window.totalasAuth;
      const { error } = await supa.from('rental_device_notes').delete().eq('id', noteId);
      if (error) throw error;
      if (itemEl) itemEl.remove();
      const listEl = $('#dd-note-list');
      if (listEl && !listEl.children.length) listEl.innerHTML = `<div class="dd-empty">아직 메모가 없습니다.</div>`;
      if (_detailCtx) _detailCtx.notes = _detailCtx.notes.filter(n => String(n.id) !== String(noteId));
      showToast('메모 삭제됨');
    } catch (e) {
      showToast('삭제 실패: ' + (e.message || e));
    }
  }

  // ── 소모품 여분/알람 저장 + 부분 갱신 ──
  function _refreshSupplyUI(deviceId) {
    recomputeSupplyStatus();
    renderSupplyBanner();
    renderLiveSection();
    if (_detailDeviceId === deviceId && _detailCtx) {
      const html = _renderSupplySection(_detailCtx.d, _detailCtx.readings, _detailCtx.latest, _detailCtx.notes, _detailCtx.notesAvailable);
      const sections = $('#dd-body').querySelectorAll('.dd-section');
      if (sections.length) {
        const wrap = document.createElement('div');
        wrap.innerHTML = html;
        sections[sections.length - 1].replaceWith(wrap.firstElementChild);
        if (_detailCtx.notesAvailable) {
          const addBtn = $('#dd-note-add');
          if (addBtn) addBtn.addEventListener('click', () => addDeviceNote(deviceId, $('#dd-note-input').value));
        }
      }
    }
  }

  async function saveSpare(deviceId, color, value) {
    const n = Math.max(0, Math.floor(Number(value)));
    if (!Number.isFinite(n)) { showToast('숫자를 입력하세요'); return; }
    const nowIso = new Date().toISOString();
    try {
      const supa = window.totalasAuth;
      const { error } = await supa.from('rental_device_supplies')
        .upsert({ device_id: deviceId, color, spare_count: n, set_at: nowIso, updated_at: nowIso }, { onConflict: 'device_id,color' });
      if (error) throw error;
      let m = state.suppliesByDevice.get(deviceId);
      if (!m) { m = {}; state.suppliesByDevice.set(deviceId, m); }
      m[color] = { spare_count: n, set_at: nowIso };
      _refreshSupplyUI(deviceId);
      showToast(`여분 ${n}개로 설정됨 (지금 시점 기준)`);
    } catch (e) {
      showToast('저장 실패: ' + (e.message || e));
    }
  }

  async function toggleAlarm(deviceId, enabled) {
    const nowIso = new Date().toISOString();
    try {
      const supa = window.totalasAuth;
      const { error } = await supa.from('rental_device_supply_config')
        .upsert({ device_id: deviceId, alarm_enabled: enabled, updated_at: nowIso }, { onConflict: 'device_id' });
      if (error) throw error;
      state.supplyConfig.set(deviceId, enabled);
      _refreshSupplyUI(deviceId);
      showToast(enabled ? '부족 알람 켜짐' : '부족 알람 꺼짐');
    } catch (e) {
      showToast('저장 실패: ' + (e.message || e));
    }
  }

  // 여분 인라인 편집기 (수정 버튼 클릭 시)
  function _startSpareEdit(btn) {
    const span = btn.closest('.ds-spare');
    if (!span) return;
    const deviceId = btn.dataset.deviceId, color = btn.dataset.color, cur = btn.dataset.cur || '0';
    span.innerHTML = `여분 <input type="number" min="0" class="ds-spare-input" value="${escapeHtml(cur)}"> 개
      <button class="ds-spare-save" type="button">저장</button>
      <button class="ds-spare-cancel" type="button">취소</button>`;
    const inp = span.querySelector('.ds-spare-input');
    inp.focus(); inp.select();
    span.querySelector('.ds-spare-save').addEventListener('click', () => saveSpare(deviceId, color, inp.value));
    span.querySelector('.ds-spare-cancel').addEventListener('click', () => _refreshSupplyUI(deviceId));
    inp.addEventListener('keydown', ev => {
      if (ev.key === 'Enter')  { ev.preventDefault(); saveSpare(deviceId, color, inp.value); }
      if (ev.key === 'Escape') { ev.preventDefault(); _refreshSupplyUI(deviceId); }
    });
  }

  // ── 추이 차트 (의존성 없는 인라인 SVG) ──
  // 하루 1포인트로 다운샘플 (5분 폴링 → 일별 마지막 reading). readings 는 asc 정렬.
  function _dailyBuckets(readings) {
    const map = new Map();
    for (const r of readings) {
      if (!r.read_at) continue;
      map.set(String(r.read_at).slice(0, 10), r); // 같은 날 뒤쪽(최신)이 덮어씀
    }
    return Array.from(map.values())
      .map(r => ({ t: new Date(r.read_at).getTime(), r }))
      .filter(d => !Number.isNaN(d.t))
      .sort((a, b) => a.t - b.t);
  }

  function _niceMax(v) {
    if (v <= 0) return 1;
    const pow = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / pow;
    const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
    return m * pow;
  }

  // 시간축 다계열 라인 차트 (마커 + 우측 범례) — 샘플 레이아웃
  // series: [{label, color, points:[{t,v}]}]
  // opts: { yMax, yTicks:[...], fmtY, legendTitle, axisLabel }
  function _timeLineChart(series, opts) {
    const live = series.filter(s => s.points.length);
    const allPts = live.flatMap(s => s.points);
    if (allPts.length < 2) return null;
    const W = 580, H = 210, padL = 46, padR = 10, padT = 12, padB = 46;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const times = allPts.map(p => p.t);
    const tMin = Math.min(...times), tMax = Math.max(...times);
    const yMax = opts.yMax != null ? opts.yMax : _niceMax(Math.max(...allPts.map(p => p.v)));
    const yTicks = opts.yTicks || [0, 0.25, 0.5, 0.75, 1].map(f => Math.round(yMax * f));
    const xOf = t => padL + (tMax > tMin ? (t - tMin) / (tMax - tMin) : 0.5) * plotW;
    const yOf = v => padT + (1 - Math.max(0, Math.min(yMax, v)) / (yMax || 1)) * plotH;

    let grid = '';
    yTicks.forEach(v => {
      const y = yOf(v);
      grid += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W-padR}" y2="${y.toFixed(1)}" stroke="#eef2f7"></line>`;
      grid += `<text x="${padL-6}" y="${(y+3).toFixed(1)}" text-anchor="end" font-size="8.5" fill="#94a3b8">${opts.fmtY ? opts.fmtY(v) : fmtInt(v)}</text>`;
    });

    // x 날짜 라벨 (~8개, -35° 회전)
    const uniqT = [...new Set(times)].sort((a, b) => a - b);
    const N = Math.min(8, uniqT.length);
    const p2 = n => String(n).padStart(2, '0');
    let xlabels = '';
    for (let i = 0; i < N; i++) {
      const idx = N > 1 ? Math.round(i * (uniqT.length - 1) / (N - 1)) : 0;
      const t = uniqT[idx], x = xOf(t), dt = new Date(t);
      const lab = `${dt.getFullYear()}/${p2(dt.getMonth()+1)}/${p2(dt.getDate())}`;
      const ly = H - padB + 13;
      xlabels += `<text x="${x.toFixed(1)}" y="${ly}" text-anchor="end" font-size="8.5" fill="#94a3b8" transform="rotate(-35 ${x.toFixed(1)} ${ly})">${lab}</text>`;
    }

    const axis =
      `<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT+plotH}" stroke="#e2e8f0"></line>` +
      `<line x1="${padL}" y1="${padT+plotH}" x2="${W-padR}" y2="${padT+plotH}" stroke="#e2e8f0"></line>`;

    let body = '';
    live.forEach(s => {
      const pts = s.points.slice().sort((a, b) => a.t - b.t);
      if (pts.length >= 2) {
        body += `<path d="${pts.map((p, i) => `${i ? 'L' : 'M'}${xOf(p.t).toFixed(1)},${yOf(p.v).toFixed(1)}`).join(' ')}" fill="none" stroke="${s.color}" stroke-width="1.6" stroke-linejoin="round"></path>`;
      }
      body += pts.map(p => `<circle cx="${xOf(p.t).toFixed(1)}" cy="${yOf(p.v).toFixed(1)}" r="2.3" fill="${s.color}"></circle>`).join('');
    });

    const titleHtml = opts.axisLabel ? `<div class="dd-chart-title">${escapeHtml(opts.axisLabel)}</div>` : '';
    const svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${escapeHtml(opts.legendTitle || '추이')}">${grid}${axis}${xlabels}${body}</svg>`;
    const legend = `<div class="dd-legend-v">` +
      (opts.legendTitle ? `<span class="dd-legend-h">${escapeHtml(opts.legendTitle)}</span>` : '') +
      live.map(s => `<span class="dd-leg"><span class="dd-swatch" style="background:${s.color};"></span>${escapeHtml(s.label)}</span>`).join('') +
      `</div>`;
    return `<div class="dd-chartrow"><div class="dd-chart">${titleHtml}${svg}</div>${legend}</div>`;
  }

  // 카운터확인 — 실시간 누적 카운터 라인 (흑백/풀컬러/결합 합계)
  function _renderCounterTrend(readings) {
    const days = _dailyBuckets(readings);
    const mk = pick => days.filter(d => d.r[pick] != null).map(d => ({ t: d.t, v: Number(d.r[pick]) }));
    const series = [
      { label: '흑백 합계',   color: '#2563eb', points: mk('bw') },
      { label: '풀컬러 합계', color: '#a855f7', points: mk('color') },
      { label: '결합 합계',   color: '#0891b2', points: mk('total_pages') },
    ];
    const chart = _timeLineChart(series, { legendTitle: '범례', axisLabel: '카운터', fmtY: fmtInt });
    return chart || `<div class="dd-empty">실시간 카운터 추이를 보려면 2일 이상의 기록이 필요합니다.</div>`;
  }

  // ── 임대카운터 연동: 월별/이번달 카운터 ──
  function _ymString(date) {
    const p = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}`;
  }

  // 이번달(1일~말일) 실사용 = 현재 누적 − 이달 시작 시점 누적
  // baseline 우선순위: rental_counters 전월 누적 → 월초 직전 live reading → (없으면) 이달 첫 reading(부분)
  function _thisMonthUsage(readings, monthlyCounters) {
    if (!readings.length) return null;
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const latest = readings[readings.length - 1];
    const latTotal = latest.total_pages != null ? Number(latest.total_pages)
                   : (latest.bw != null || latest.color != null) ? (Number(latest.bw) || 0) + (Number(latest.color) || 0) : null;
    const sub = (a, b) => (a != null && b != null) ? Math.max(0, Number(a) - Number(b)) : null;

    let baseBw = null, baseColor = null, baseTotal = null, partial = false;
    const prevYm = _ymString(new Date(now.getFullYear(), now.getMonth() - 1, 1));
    const prevC = (monthlyCounters || []).find(c => c.ym === prevYm);
    if (prevC) {
      baseBw = prevC.bw; baseColor = prevC.color;
      baseTotal = (Number(prevC.bw) || 0) + (Number(prevC.color) || 0);
    } else {
      let b = null;
      for (let i = readings.length - 1; i >= 0; i--) {
        if (new Date(readings[i].read_at).getTime() < monthStart) { b = readings[i]; break; }
      }
      if (!b) { b = readings.find(r => new Date(r.read_at).getTime() >= monthStart); partial = true; }
      if (b) {
        baseBw = b.bw; baseColor = b.color;
        baseTotal = b.total_pages != null ? Number(b.total_pages) : (Number(b.bw) || 0) + (Number(b.color) || 0);
      }
    }
    return { partial, bw: sub(latest.bw, baseBw), color: sub(latest.color, baseColor), total: sub(latTotal, baseTotal) };
  }

  // 이달 사용가능(계약 기본카운터): split→bw_free/co_free, total→total_free_count
  function _thisMonthAllowance(item, assignment) {
    if (!item) return null;
    if ((item.counter_mode || 'split') === 'total') {
      return { mode: 'total', total: Number(item.total_free_count) || 0 };
    }
    return { mode: 'split', bw: Number(assignment && assignment.bw_free) || 0, color: Number(assignment && assignment.co_free) || 0 };
  }

  // 현재상태 하단: 이번달 실사용 + 사용가능 + 잔여 표
  function _renderThisMonth(usage, allow, itemLinked) {
    if (!usage && !allow) return '';
    const cell = v => (v == null ? '–' : fmtInt(v));
    const rem = (avail, used) => {
      if (avail == null || used == null) return '–';
      const r = avail - used;
      return r < 0 ? `<span class="dd-over">${fmtInt(-r)} 초과</span>` : fmtInt(r);
    };
    const u = usage || {};
    const usedTot = u.total;

    let allowBw = null, allowCo = null, allowTot = null;
    if (allow) {
      if (allow.mode === 'total') { allowTot = allow.total; }
      else { allowBw = allow.bw; allowCo = allow.color; allowTot = (allow.bw || 0) + (allow.color || 0); }
    }

    const note = !itemLinked
      ? `<div class="dd-sub-note">⚠ 자산(임대거래처)과 연결되지 않아 사용가능 카운터를 표시할 수 없습니다. 자산번호/일련번호를 맞춰주세요.</div>`
      : (u.partial ? `<div class="dd-sub-note">※ 이달 시작 이전 검침값이 없어 부분 기간 기준입니다.</div>` : '');

    const allowRow = allow
      ? `<tr><td>사용가능</td><td>${allow.mode === 'total' ? '–' : cell(allowBw)}</td><td>${allow.mode === 'total' ? '–' : cell(allowCo)}</td><td>${cell(allowTot)}</td></tr>
         <tr><td>잔여</td><td>${allow.mode === 'total' ? '–' : rem(allowBw, u.bw)}</td><td>${allow.mode === 'total' ? '–' : rem(allowCo, u.color)}</td><td>${rem(allowTot, usedTot)}</td></tr>`
      : '';

    return `
      <div class="dd-month-h">📆 이번달 (${_ymString(new Date())} · 1일~말일)</div>
      <table class="dd-table dd-tm-table">
        <thead><tr><th>구분</th><th>흑백</th><th>컬러</th><th>합계</th></tr></thead>
        <tbody>
          <tr class="dd-tm-used"><td>실사용</td><td>${cell(u.bw)}</td><td>${cell(u.color)}</td><td class="dd-use">${cell(usedTot)}</td></tr>
          ${allowRow}
        </tbody>
      </table>
      ${note}`;
  }

  // 월별 카운터(최근 12개월) — rental_counters 연동. 월 사용량 = 당월누적 − 전월누적(음수=0)
  function _renderMonthly12(monthlyCounters, item) {
    if (!item) {
      return `<div class="dd-empty">자산(임대거래처)과 연결되지 않았습니다. 자산번호 또는 일련번호를 맞추면 월별 카운터가 표시됩니다.</div>`;
    }
    const sorted = (monthlyCounters || []).slice().sort((a, b) => (a.ym || '').localeCompare(b.ym || ''));
    if (sorted.length < 2) {
      return `<div class="dd-empty">월 사용량 계산에는 2개월 이상의 누적 카운터가 필요합니다. (현재 ${sorted.length}개월)</div>`;
    }
    const rows = [];
    for (let i = 1; i < sorted.length; i++) {
      const cur = sorted[i], prev = sorted[i - 1];
      rows.push({
        ym: cur.ym,
        bw: Math.max(0, (Number(cur.bw) || 0) - (Number(prev.bw) || 0)),
        co: Math.max(0, (Number(cur.color) || 0) - (Number(prev.color) || 0)),
      });
    }
    const last12 = rows.slice(-12);
    const head = `<th>구분</th>` + last12.map(r => `<th>${(r.ym || '').slice(2).replace('-', '/')}</th>`).join('');
    const bwRow = `<td>흑백</td>` + last12.map(r => `<td>${fmtInt(r.bw)}</td>`).join('');
    const coRow = `<td>컬러</td>` + last12.map(r => `<td>${fmtInt(r.co)}</td>`).join('');
    const totRow = `<td>합계</td>` + last12.map(r => `<td class="dd-use">${fmtInt(r.bw + r.co)}</td>`).join('');
    return `<div class="dd-chart" style="overflow-x:auto;">
      <table class="dd-table dd-month-table">
        <thead><tr>${head}</tr></thead>
        <tbody><tr>${bwRow}</tr><tr>${coRow}</tr><tr>${totRow}</tr></tbody>
      </table></div>`;
  }

  // 소모성 — 토너 레벨 라인 (블랙/시안/마젠타/옐로우)
  function _renderTonerTrend(readings) {
    const days = _dailyBuckets(readings);
    const mk = pick => days.filter(d => d.r[pick] != null).map(d => ({ t: d.t, v: Number(d.r[pick]) }));
    const series = [
      { label: '블랙',   color: '#111827', points: mk('toner_k') },
      { label: '시안',   color: '#38bdf8', points: mk('toner_c') },
      { label: '마젠타', color: '#ec4899', points: mk('toner_m') },
      { label: '옐로우', color: '#eab308', points: mk('toner_y') },
    ];
    const chart = _timeLineChart(series, {
      legendTitle: '범례', axisLabel: '토너 레벨',
      yMax: 100, yTicks: [0, 25, 50, 75, 100], fmtY: v => v + '%',
    });
    return chart || `<div class="dd-empty">토너 추이를 보려면 2일 이상의 기록이 필요합니다.</div>`;
  }

  // 장치 로그 — readings.alert_text 에서 이벤트 추출 (용지걸림·오류 등)
  function _renderDeviceLog(readings) {
    const events = [];
    for (let i = readings.length - 1; i >= 0 && events.length < 50; i--) {
      const r = readings[i];
      const raw = String(r.alert_text || '').trim();
      if (!raw) continue;
      if (/usb local printer|enable snmp/i.test(raw)) continue; // 안내성 메시지 제외
      const parts = raw.split(/[,;/|]+/).map(s => s.trim()).filter(Boolean);
      for (const p of parts) {
        events.push({ cat: p, ts: r.read_at });
        if (events.length >= 50) break;
      }
    }
    if (!events.length) return `<div class="dd-empty">기록된 장치 이벤트가 없습니다.</div>`;
    let tbl = `<table class="dd-table dd-log"><thead><tr><th>종류</th><th>범주</th><th>타임스탬프 (GMT+9:00)</th></tr></thead><tbody>`;
    for (const e of events) {
      tbl += `<tr><td><span class="dd-log-type">이벤트</span></td><td>${escapeHtml(e.cat)}</td><td>${escapeHtml(_fmtFullTime(e.ts))}</td></tr>`;
    }
    tbl += `</tbody></table>`;
    return tbl;
  }

  function _fmtFullTime(iso) {
    if (!iso) return '';
    const dt = new Date(iso);
    if (Number.isNaN(dt.getTime())) return '';
    const p = n => String(n).padStart(2, '0');
    return `${dt.getFullYear()}/${p(dt.getMonth()+1)}/${p(dt.getDate())} ${p(dt.getHours())}:${p(dt.getMinutes())}:${p(dt.getSeconds())}`;
  }

  // ---------- 이벤트 바인딩 ----------
  function bindFilters() {
    $('#btn-refresh').addEventListener('click', () => init(true));

    // 실시간 수집기 검색 (거래처 / 모델 / 자산번호)
    let _searchTimer = null;
    const searchInput = document.getElementById('live-search');
    const clearBtn    = document.getElementById('live-search-clear');
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        clearTimeout(_searchTimer);
        _searchTimer = setTimeout(() => {
          state.collectorSearch = searchInput.value;
          clearBtn && clearBtn.classList.toggle('visible', !!searchInput.value.trim());
          renderLiveSection();
        }, 200);
      });
    }
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        if (searchInput) { searchInput.value = ''; searchInput.focus(); }
        clearBtn.classList.remove('visible');
        state.collectorSearch = '';
        document.getElementById('live-search-count') && (document.getElementById('live-search-count').style.display = 'none');
        renderLiveSection();
      });
    }

    // 소모품 배송 배너 — 자세히 토글
    const sbToggle = document.getElementById('sb-toggle');
    if (sbToggle) {
      sbToggle.addEventListener('click', () => {
        const list = document.getElementById('sb-list');
        if (!list) return;
        const open = list.style.display !== 'none';
        list.style.display = open ? 'none' : 'flex';
        sbToggle.textContent = open ? '자세히 ▾' : '접기 ▴';
      });
    }

    // 수집기 패널
    $('#btn-open-pair').addEventListener('click', openPairModal);
    $('#ncb-open-pair').addEventListener('click', openPairModal);
    $('#btn-export-counter-xlsx').addEventListener('click', exportCounterXlsx);
    $('#lh-refresh').addEventListener('click', () => init(true));

    // 실시간 수집기 데이터 ✕ 삭제 (이벤트 위임) — 확인 모달 경유
    const liveTable = document.getElementById('live-table');
    const hideModal = $('#confirm-hide-modal');
    const closeHideModal = () => {
      hideModal.classList.remove('show');
      delete hideModal.dataset.hideId;
    };
    liveTable.addEventListener('click', (e) => {
      const btn = e.target.closest('.btn-hide');
      if (!btn) return;
      const id = btn.dataset.hide;
      if (!id) return;
      hideModal.dataset.hideId = id;
      hideModal.classList.add('show');
    });
    $('#btn-close-hide').addEventListener('click', closeHideModal);
    $('#btn-cancel-hide').addEventListener('click', closeHideModal);
    hideModal.addEventListener('click', (e) => {
      if (e.target === hideModal) closeHideModal();
    });
    $('#btn-confirm-hide').addEventListener('click', () => {
      const id = hideModal.dataset.hideId;
      closeHideModal();
      if (id) hideLiveDevice(id);
    });

    // 인라인 편집 (PC / 모델 / 거래처)
    // 데스크탑: 더블클릭 → 셀 내 인라인 edit
    // 모바일(max-width 768):   단순 클릭 → 확대 모달
    // iframe 안 폭이 768 이상이라도 핸드폰 UA 면 모바일 처리.
    const isMobile = () => {
      const ua = (navigator.userAgent || '');
      const isPhoneUA = /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(ua);
      return isPhoneUA || window.innerWidth <= 768;
    };

    liveTable.addEventListener('dblclick', (e) => {
      if (isMobile()) return; // 모바일은 dblclick 무시 (click으로 처리)
      // td 가 아니라 span(.sub-group-pc-name 등)에 data-edit 가 붙은 경우도 처리
      const target = e.target.closest('[data-edit]');
      if (!target) return;
      const kind = target.dataset.edit;
      if (kind === 'pc') {
        editPcName(target.dataset.collectorId, target);
      } else if (kind === 'model') {
        editModel(target.dataset.deviceId, target);
      } else if (kind === 'asset') {
        editAssetNumber(target.dataset.deviceId, target);
      } else if (kind === 'customer') {
        editCustomer(target.dataset.collectorId, target.dataset.currentId, target);
      }
    });

    // 그룹 헤더 [✏ 거래처] 버튼 — 데스크탑/모바일 공통
    liveTable.addEventListener('click', (e) => {
      const btn = e.target.closest('.group-edit-btn');
      if (!btn) return;
      e.stopPropagation();
      openGroupCustomerEdit(btn);
    });

    // 장비 상세 버튼 (🔍) — 데스크탑/모바일 공통
    liveTable.addEventListener('click', (e) => {
      const btn = e.target.closest('.btn-detail');
      if (!btn) return;
      e.stopPropagation();
      if (btn.dataset.detail) openDeviceDetail(btn.dataset.detail);
    });

    // 상세 오버레이 — 닫기 / 배경 클릭 / 메모 삭제 / 여분 수정 / 알람 토글 (위임)
    const detailModal = $('#device-detail-modal');
    $('#btn-close-detail').addEventListener('click', closeDeviceDetail);
    detailModal.addEventListener('click', (e) => {
      if (e.target === detailModal) { closeDeviceDetail(); return; }
      const del = e.target.closest('.dd-note-del');
      if (del) { deleteDeviceNote(del.dataset.noteId, del.closest('.dd-note-item')); return; }
      const spareBtn = e.target.closest('.ds-spare-edit');
      if (spareBtn) { _startSpareEdit(spareBtn); return; }
    });
    detailModal.addEventListener('change', (e) => {
      const alarm = e.target.closest('#dd-alarm');
      if (alarm) toggleAlarm(alarm.dataset.deviceId, alarm.checked);
    });

    // 모바일 탭 → 모달 편집
    liveTable.addEventListener('click', (e) => {
      if (!isMobile()) return;
      const target = e.target.closest('[data-edit]');
      if (!target) return;
      const kind = target.dataset.edit;
      if (kind === 'pc') {
        openMobileEditText('PC 이름', target.dataset.collectorId, 'pc');
      } else if (kind === 'model') {
        openMobileEditText('모델명', target.dataset.deviceId, 'model');
      } else if (kind === 'asset') {
        openMobileEditText('자산번호', target.dataset.deviceId, 'asset');
      } else if (kind === 'customer') {
        openMobileEditCustomer(target.dataset.collectorId, target.dataset.currentId);
      }
    });

    // 모바일 편집 모달 — 취소
    $('#mem-cancel').addEventListener('click', closeMobileEditModal);
    $('#mobile-edit-modal').addEventListener('click', (e) => {
      if (e.target === $('#mobile-edit-modal')) closeMobileEditModal();
    });

    $('#btn-close-pair').addEventListener('click', closePairModal);
    $('#btn-cancel-pair').addEventListener('click', closePairModal);
    $('#btn-save-pair').addEventListener('click', savePairMappings);
  }

  // ---------- 고객 카운터프로그램 버전 표시 ----------
  // downloads/collector-version.json 을 읽어 버튼에 업데이트 날짜 표시.
  async function loadCollectorVersion() {
    const btn = document.getElementById('btn-collector-download');
    if (!btn) return;
    try {
      const res = await fetch('../downloads/collector-version.json?ts=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) return;
      const v = await res.json();
      if (!v || !v.updated_at) return;
      const fname = v.filename || 'hanbyeol-collector.zip';
      const isZip = /\.zip$/i.test(fname);
      const label = isZip ? '고객 카운터프로그램 (ZIP)' : '고객 카운터프로그램';
      btn.innerHTML = `⬇ ${label} <span style="opacity:.7;font-size:11px;font-weight:500;">(${v.updated_at})</span>`;
      btn.title = (
        `업데이트: ${v.updated_at} · 크기: ${v.size_mb}MB · 페어링 코드: hanbyeol\n` +
        (isZip ? '설치: ZIP 압축 풀기 → 안의 hanbyeol-collector 폴더의 EXE 더블클릭\n' : '') +
        '안랩 V3 가 차단하면 LocalAppData\\HanbyeolCollector 폴더를 V3 예외에 추가'
      );
      btn.setAttribute('download', fname);
      btn.href = `../downloads/${fname}?v=${encodeURIComponent(v.version || v.updated_at)}`;
    } catch (e) {
      console.warn('[collector-version] 로드 실패 (캐시 미반영 가능):', e);
    }
  }

  // ---------- init ----------
  async function init(force) {
    try {
      await loadAll();
      recomputeSupplyStatus();
      renderCollectorPanel();
      renderSupplyBanner();
      renderLiveSection();
      loadCollectorVersion();
    } catch (e) {
      console.error('[rental-equipment] 로드 실패:', e);
      showToast('데이터 로드 실패: ' + (e.message || String(e)));
    }
  }

  // ---------- 부트 ----------
  // applyMobileForce — 테이블 뷰 통일로 카드 강제 불필요. is-mobile-force 클래스 미사용.
  // isMobile() 은 편집 모달 트리거 용도로만 사용 (dblclick vs tap 구분).
  function applyMobileForce() {
    // 의도적 no-op: 모바일에서도 데스크탑 테이블 그대로 표시
  }

  let booted = false;
  function boot() {
    if (booted) return;
    booted = true;
    applyMobileForce();
    bindFilters();
    init(false);
  }

  if (window.totalasAuth) {
    boot();
  } else {
    document.addEventListener('totalas:ready', boot, { once: true });
    // 안전망: 2초 후에도 미부팅이면 강제 실행
    setTimeout(() => {
      if (!booted && window.totalasAuth) boot();
      else if (!booted) console.warn('[rental-equipment] window.totalasAuth 미초기화 — auth.js 점검 필요');
    }, 2000);
  }
})();
