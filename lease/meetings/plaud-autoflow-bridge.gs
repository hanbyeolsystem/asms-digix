// ============================================================
// plaud-autoflow-bridge.gs
// Plaud AutoFlow → Gmail(acapaper78@gmail.com) → Supabase rental_meetings
//
// 배포 방법:
//   1. https://script.google.com → 새 프로젝트
//   2. 이 파일 내용 전체 붙여넣기
//   3. 아래 SUPABASE_URL / SUPABASE_ANON_KEY 값 채우기
//   4. installTrigger() 함수 1회 실행 → Google 권한 허용
//   5. 5분마다 자동 실행 확인 (시계 아이콘 > 트리거)
// ============================================================

// ── 상수 (반드시 채우세요) ────────────────────────────────
var SUPABASE_URL      = 'https://wghjnlhfqypamiwukeio.supabase.co';   // ← 이미 입력됨
var SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY_HERE';                // ← Supabase Dashboard > Settings > API > anon key 붙여넣기

// Gmail 라벨 이름 (없으면 자동 생성)
var LABEL_PENDING = 'Plaud';        // Plaud 메일 감지 대상 라벨
var LABEL_DONE    = 'PlaudDone';    // 처리 성공 시 추가
var LABEL_ERROR   = 'PlaudError';   // 처리 실패 시 추가

// Plaud 발신 주소 패턴 (Gmail search 용)
var PLAUD_SENDER_QUERY = 'from:(plaud.ai OR noreply@plaud.ai OR no-reply@plaud.ai OR hello@plaud.ai)';

// ── 메인 실행 함수 (트리거가 호출) ───────────────────────
function processPlaudEmails() {
  try {
    _ensureLabels();

    // 라벨 "Plaud" 가 있는 미읽은 메일 검색 (없으면 발신 주소 검색)
    var query = 'label:' + LABEL_PENDING + ' is:unread';
    var threads = GmailApp.search(query, 0, 50);

    // 라벨 기반 검색 결과가 없으면 발신 주소로 재검색 (라벨 필터 미설정 시 폴백)
    if (threads.length === 0) {
      query = PLAUD_SENDER_QUERY + ' is:unread newer_than:2d';
      threads = GmailApp.search(query, 0, 50);
    }

    Logger.log('[processPlaudEmails] 처리 대상 스레드: ' + threads.length + '건');

    threads.forEach(function(thread) {
      var messages = thread.getMessages();
      messages.forEach(function(msg) {
        if (!msg.isUnread()) return; // 이미 읽은 메시지 스킵
        _processSingleMessage(msg);
      });
    });

  } catch (e) {
    Logger.log('[processPlaudEmails] 오류: ' + e.toString());
  }
}

// ── 메시지 단건 처리 ─────────────────────────────────────
function _processSingleMessage(msg) {
  var messageId = msg.getId();   // Gmail 내부 ID (중복 방지 키)
  var subject   = msg.getSubject() || '(제목없음)';
  var date      = msg.getDate();
  var body      = msg.getPlainBody() || msg.getBody() || '';

  Logger.log('[_processSingleMessage] ID=' + messageId + ' / Subject=' + subject);

  // 중복 체크 — Supabase 에 이미 있는지 확인
  if (_isDuplicate(messageId)) {
    Logger.log('  → 이미 처리된 메시지 (중복). 스킵.');
    msg.markRead();
    return;
  }

  // 본문에서 전사문 / 요약문 파싱
  var parsed = _parseBody(body);

  // 날짜 변환 (YYYY-MM-DD, HH:MM:SS)
  var meetingDate = Utilities.formatDate(date, 'Asia/Seoul', 'yyyy-MM-dd');
  var meetingTime = Utilities.formatDate(date, 'Asia/Seoul', 'HH:mm:ss');

  // Supabase INSERT
  var payload = {
    title:             subject,
    meeting_date:      meetingDate,
    meeting_time:      meetingTime,
    transcript_text:   parsed.transcript || null,
    summary_md:        parsed.summary    || null,
    source:            'plaud_autoflow',
    plaud_message_id:  messageId,
    auto_imported:     true,
    import_source:     'plaud_autoflow',
    customer_id:       null,   // UI 에서 수동 매핑
    updated_at:        new Date().toISOString(),
  };

  var result = _supabaseInsert('/rest/v1/rental_meetings', payload);

  if (result.ok) {
    Logger.log('  → INSERT 성공. meeting_id=' + (result.data && result.data[0] && result.data[0].id));
    msg.markRead();
    _addLabelToMessage(msg, LABEL_DONE);
    _removeLabelFromMessage(msg, LABEL_ERROR);
  } else {
    Logger.log('  → INSERT 실패: ' + result.error);
    _addLabelToMessage(msg, LABEL_ERROR);
  }
}

// ── 본문 파싱: Transcript / Summary 분리 ────────────────
// Plaud AutoFlow 이메일 본문 구조 (확인된 패턴):
//   상단: AI Summary 섹션
//   중단: Transcript 섹션
// 구분자: "Transcript", "AI Summary", "Summary" 등의 헤더
function _parseBody(rawBody) {
  var result = { transcript: '', summary: '' };
  if (!rawBody) return result;

  // HTML 태그 제거 (plainBody 가 아닌 경우 대비)
  var text = rawBody.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // 섹션 분리 시도 — 대소문자 무시
  // 패턴 1: "Transcript:" 또는 "Transcript\n" 헤더
  var transcriptMatch = text.match(/transcript[:\s]*\n([\s\S]+?)(?=summary|ai summary|$)/i);
  var summaryMatch    = text.match(/(?:ai\s+)?summary[:\s]*\n([\s\S]+?)(?=transcript|$)/i);

  if (transcriptMatch) {
    result.transcript = transcriptMatch[1].trim();
  }
  if (summaryMatch) {
    result.summary = summaryMatch[1].trim();
  }

  // 패턴 2: 섹션 헤더 미발견 시 전체 본문 → transcript 로 저장
  if (!result.transcript && !result.summary) {
    // 첨부 .txt 파일이 있으면 우선 (아래 _parseAttachment 에서 처리)
    result.transcript = text.trim();
    result.summary    = '';
  }

  // 너무 짧으면 (시스템 메일 등) 빈 문자열 유지
  if (result.transcript.length < 20) result.transcript = '';

  return result;
}

// ── 중복 체크 (plaud_message_id UNIQUE) ─────────────────
function _isDuplicate(messageId) {
  try {
    var res = _supabaseFetch(
      '/rest/v1/rental_meetings?plaud_message_id=eq.' + encodeURIComponent(messageId) +
      '&select=id&limit=1'
    );
    return res.ok && Array.isArray(res.data) && res.data.length > 0;
  } catch (e) {
    return false; // 확인 실패 시 중복이 아닌 것으로 간주 (안전 방향)
  }
}

// ── Supabase REST API — GET ───────────────────────────────
function _supabaseFetch(path) {
  var url = SUPABASE_URL + path;
  var options = {
    method: 'get',
    headers: {
      'apikey':        SUPABASE_ANON_KEY,
      'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
      'Content-Type':  'application/json',
    },
    muteHttpExceptions: true,
  };
  var response = UrlFetchApp.fetch(url, options);
  var code = response.getResponseCode();
  var body = response.getContentText('utf-8');
  if (code >= 200 && code < 300) {
    return { ok: true, data: JSON.parse(body) };
  } else {
    return { ok: false, error: '[HTTP ' + code + '] ' + body };
  }
}

// ── Supabase REST API — POST (INSERT) ────────────────────
function _supabaseInsert(path, payload) {
  var url = SUPABASE_URL + path;
  var options = {
    method: 'post',
    headers: {
      'apikey':        SUPABASE_ANON_KEY,
      'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
      'Content-Type':  'application/json',
      'Prefer':        'return=representation',  // 삽입된 row 반환
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };
  var response = UrlFetchApp.fetch(url, options);
  var code = response.getResponseCode();
  var body = response.getContentText('utf-8');
  if (code >= 200 && code < 300) {
    var parsed = null;
    try { parsed = JSON.parse(body); } catch (_) {}
    return { ok: true, data: parsed };
  } else {
    return { ok: false, error: '[HTTP ' + code + '] ' + body };
  }
}

// ── Gmail 라벨 유틸 ──────────────────────────────────────
function _ensureLabels() {
  var labels = [LABEL_PENDING, LABEL_DONE, LABEL_ERROR];
  labels.forEach(function(name) {
    if (!GmailApp.getUserLabelByName(name)) {
      GmailApp.createLabel(name);
      Logger.log('라벨 생성: ' + name);
    }
  });
}

function _addLabelToMessage(msg, labelName) {
  try {
    var label = GmailApp.getUserLabelByName(labelName);
    if (!label) label = GmailApp.createLabel(labelName);
    msg.getThread().addLabel(label);
  } catch (e) {
    Logger.log('라벨 추가 실패(' + labelName + '): ' + e.toString());
  }
}

function _removeLabelFromMessage(msg, labelName) {
  try {
    var label = GmailApp.getUserLabelByName(labelName);
    if (label) msg.getThread().removeLabel(label);
  } catch (e) {}
}

// ── 트리거 설치 (1회만 실행) ─────────────────────────────
// 이 함수를 Apps Script 편집기에서 직접 실행하세요.
function installTrigger() {
  // 기존 트리거 중복 방지 — 같은 함수명 트리거 삭제
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'processPlaudEmails') {
      ScriptApp.deleteTrigger(t);
    }
  });

  // 5분마다 실행
  ScriptApp.newTrigger('processPlaudEmails')
    .timeBased()
    .everyMinutes(5)
    .create();

  Logger.log('트리거 설치 완료: processPlaudEmails 5분마다 실행');
}

// ── 트리거 제거 (비상용) ─────────────────────────────────
function uninstallTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'processPlaudEmails') {
      ScriptApp.deleteTrigger(t);
      Logger.log('트리거 삭제됨');
    }
  });
}

// ── 수동 테스트용 ────────────────────────────────────────
// Apps Script 편집기에서 직접 실행하면 최근 5일치 Plaud 메일을 처리합니다.
function testRun() {
  Logger.log('=== testRun 시작 ===');
  processPlaudEmails();
  Logger.log('=== testRun 완료 ===');
}
