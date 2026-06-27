// ============================================================
// totalas — 임대장비관리 (rental-equipment)
// 실시간 수집기 데이터(rental_collectors / rental_collector_devices /
// rental_counter_readings) + 거래처 그룹화 + 신규 매핑.
// 의존: window.totalasAuth (auth.js), supabase-js v2
// ============================================================
(function () {
  'use strict';

  const COLLECTOR_OFFLINE_MIN = 15; // 15분간 heartbeat 없으면 offline

  const state = {
    customers: [],
    collectors: [],            // rental_collectors
    collectorDevices: [],      // rental_collector_devices
    readingByDevice: new Map(),// device_id → 최신 rental_counter_readings
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
        for (const r of rdRes.data || []) {
          if (!state.readingByDevice.has(r.device_id)) {
            state.readingByDevice.set(r.device_id, r);
          }
        }
      }
    } catch (e) {
      console.warn('[rental-equipment] live data 조회 실패:', e);
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
    const statusBadgesHtml = _statusBadges(d, r);

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
        <td class="desktop-only-td"><button class="btn-hide" type="button" data-hide="${escapeHtml(d.id)}" title="이 장비를 실시간 목록에서 삭제 (디직스코리아 제품 아님 등)">✕</button></td>
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
      renderCollectorPanel();
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
