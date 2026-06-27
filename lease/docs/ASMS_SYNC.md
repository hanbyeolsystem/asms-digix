# ASMS → 임대거래처 무상수리내역 자동 동기화

> ASMS 접수관리툴(`orders`)에서 발생한 임대 관련 출장/설치/교체/PC유지보수 건을
> 임대거래처 무상수리내역(`rental_repairs`)에 자동 적재하는 시스템.
>
> 최초 구축: 2026-06-08

## 목적

- 임대 거래처의 원가 산정을 위해 ASMS 접수 중 임대 관련 건을 무상수리내역으로 자동 누적
- 거래처별 합계(마이너스)를 임대거래처 페이지에서 한눈에 확인
- ASMS에서 완료/출고 처리되는 순간 실시간 반영 (DB 트리거)

## 적재 규칙

| 항목 | 규칙 |
|---|---|
| 추출 대상 (`product` 또는 `mo_engname`) | `임대출장`, `임대초기설치`, `임대제품교체`, `PC 유지보수 출장` |
| 상태 필터 (`re_now` 또는 `status`) | `완료` 또는 `출고` |
| 거래처 매칭 | `orders.cu_name` ↔ `rental_customers.company` **정확 일치** (TRIM 후) |
| 동명 거래처 처리 | 가장 작은 `customer_id` 우선 (예: 유승산업 → `c_0076`) |
| 매칭 실패 | 조용히 skip (오류 없음, ASMS 정상 동작 영향 없음) |
| 중복 차단 | PK `rp_asms_{seq_no}` + `ON CONFLICT DO NOTHING` |
| 출처 표시 | `notes = 'ASMS#{seq_no}'` |

### 금액 / item_type

| 제품명 | `item_type` | `amount` |
|---|---|---|
| 임대출장 | `출장` | -30,000 |
| PC 유지보수 출장 | `출장` | -30,000 |
| 임대초기설치 | `부품교체` | 0 *(모델별 단가는 사용자 수동 입력)* |
| 임대제품교체 | `부품교체` | 0 *(모델별 단가는 사용자 수동 입력)* |

### service_date — 완료 우선 책략 (가후)

1. `re_content` 를 **의견 단위로 해체** (sentinel `\x01` 로 안전 분리)
2. 상태값 enum: `완료|출고|진행|접수|견적|센터|택배|보류`
3. **`완료` 의견 우선** → 없으면 **`출고` 의견**
4. 같은 상태 내에서는 가장 늦은 시각 채택
5. 의견 일시(`MM월 DD일`)의 **연도 보정**:
   - 후보: 작년(`process_date.year - 1`), 같은 해(`process_date.year`)
   - 제약: `process_date + 14일` 이내만 허용 (의견은 처리 후 며칠까지만 가능)
   - 그 중 `process_date` 와 가장 가까운 날짜 선택
6. 파싱 실패 시 → `process_date` 그대로 fallback

### work_desc

- 임대출장 / PC 유지보수 출장 → 선택된 의견의 **본문 그대로** (200자 제한). 본문 없으면 `cu_want` 대체
- 임대초기설치 → `'임대초기설치 - ' || 본문` (180자 제한)
- 임대제품교체 → `'제품교체 - ' || 본문` (180자 제한)

## 트리거 함수

### 함수 정의

```sql
CREATE OR REPLACE FUNCTION sync_asms_to_rental_repairs()
RETURNS TRIGGER AS $$
DECLARE
  v_kind text; v_status text; v_company text; v_customer_id text;
  v_proc_date date; v_svc_date date; v_work_desc text;
  v_amount int; v_item_type text; v_repair_id text;
  v_mm int; v_dd int; v_body text;
BEGIN
  v_kind   := COALESCE(NEW.product, NEW.mo_engname);
  v_status := COALESCE(NEW.re_now, NEW.status);

  -- 1) 대상 키워드 + 상태 필터
  IF v_kind NOT IN ('임대출장','임대초기설치','임대제품교체','PC 유지보수 출장')
     OR v_status NOT IN ('완료','출고') THEN RETURN NEW; END IF;

  v_repair_id := 'rp_asms_' || NEW.seq_no;

  -- 2) 중복방지
  IF EXISTS (SELECT 1 FROM rental_repairs WHERE id = v_repair_id) THEN RETURN NEW; END IF;

  -- 3) 거래처 매칭 (회사명 정확 일치, 동명 시 작은 id)
  v_company := TRIM(NEW.cu_name);
  SELECT id INTO v_customer_id FROM rental_customers
   WHERE TRIM(company) = v_company AND active IS NOT FALSE
   ORDER BY id LIMIT 1;
  IF v_customer_id IS NULL THEN RETURN NEW; END IF;

  -- 4) process_date 파싱
  BEGIN v_proc_date := TO_DATE(NEW.process_date, 'YYYY/MM/DD');
  EXCEPTION WHEN OTHERS THEN v_proc_date := CURRENT_DATE; END;

  -- 5) re_content 해체 → 완료 우선 의견 추출
  WITH norm AS (
    SELECT REGEXP_REPLACE(COALESCE(NEW.re_content,''),
                          '(\d{2}월\s+\d{2}일\s+\d{2}시\s+\d{2}분)', E'\x01\\1', 'g') AS rc
  ),
  chunks AS (SELECT regexp_split_to_table(rc, E'\x01') AS chunk FROM norm),
  ops AS (
    SELECT chunk,
           regexp_match(chunk,
             '(\d{2})월\s+(\d{2})일\s+(\d{2})시\s+(\d{2})분\s+\S+\s+기사의 의견\s*:\s*(완료|출고|진행|접수|견적|센터|택배|보류)(?:<br\s*/?>)?(.*)',
             's') AS m FROM chunks
  ),
  parsed AS (
    SELECT (m[1])::int AS mm, (m[2])::int AS dd, (m[3])::int AS hh, (m[4])::int AS mi,
           m[5] AS st,
           NULLIF(TRIM(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(m[6], '<br\s*/?>', ' ', 'g'), '[\r\n]+', ' ', 'g'), '\s+', ' ', 'g')), '') AS body
      FROM ops WHERE m IS NOT NULL
  )
  SELECT mm, dd, body INTO v_mm, v_dd, v_body FROM parsed
   WHERE st IN ('완료','출고')
   ORDER BY CASE st WHEN '완료' THEN 1 WHEN '출고' THEN 2 END,
            mm DESC, dd DESC, hh DESC, mi DESC LIMIT 1;

  -- 6) service_date: 가장 가까운 과거(또는 +14일 이내), 미래 차단
  IF v_mm IS NULL THEN
    v_svc_date := v_proc_date;
  ELSE
    BEGIN
      SELECT dt INTO v_svc_date FROM (
        SELECT MAKE_DATE(EXTRACT(YEAR FROM v_proc_date)::int - 1, v_mm, v_dd) AS dt
        UNION ALL SELECT MAKE_DATE(EXTRACT(YEAR FROM v_proc_date)::int,     v_mm, v_dd)
      ) c WHERE dt <= v_proc_date + INTERVAL '14 days'
        ORDER BY ABS(dt - v_proc_date) LIMIT 1;
    EXCEPTION WHEN OTHERS THEN v_svc_date := v_proc_date; END;
    IF v_svc_date IS NULL THEN v_svc_date := v_proc_date; END IF;
  END IF;

  -- 7) work_desc / item_type / amount
  IF v_kind IN ('임대출장','PC 유지보수 출장') THEN
    v_amount := -30000; v_item_type := '출장';
    v_work_desc := LEFT(COALESCE(v_body, NEW.cu_want, ''), 200);
  ELSIF v_kind = '임대초기설치' THEN
    v_amount := 0; v_item_type := '부품교체';
    v_work_desc := '임대초기설치 - ' || LEFT(COALESCE(v_body, NEW.cu_want, ''), 180);
  ELSE  -- 임대제품교체
    v_amount := 0; v_item_type := '부품교체';
    v_work_desc := '제품교체 - ' || LEFT(COALESCE(v_body, NEW.cu_want, ''), 180);
  END IF;

  -- 8) INSERT
  INSERT INTO rental_repairs (id, customer_id, service_date, item_type, work_desc, amount, notes)
  VALUES (v_repair_id, v_customer_id, v_svc_date, v_item_type, v_work_desc, v_amount, 'ASMS#' || NEW.seq_no)
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- ASMS 정상 동작 절대 방해 안 함
  RAISE WARNING 'sync_asms_to_rental_repairs failed seq_no=%: %', NEW.seq_no, SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

### 트리거 정의

```sql
DROP TRIGGER IF EXISTS tr_sync_asms_to_repairs ON orders;

CREATE TRIGGER tr_sync_asms_to_repairs
AFTER INSERT OR UPDATE ON orders
FOR EACH ROW
WHEN (COALESCE(NEW.re_now, NEW.status) IN ('완료','출고'))
EXECUTE FUNCTION sync_asms_to_rental_repairs();
```

### 발동 케이스
- ASMS UI에서 status를 `완료` 또는 `출고`로 변경하는 순간 → 자동 INSERT
- 처음부터 `완료/출고`로 INSERT되는 새 접수 → 자동 INSERT
- 이미 적재된 건의 status 변경 → `ON CONFLICT DO NOTHING` 으로 skip (완료 시점 유지)
- 매칭 안 되는 거래처(임대 거래처가 아닌 일반 AS 고객) → 조용히 skip

## 과거 데이터 백필 (1년치 등)

신규 기간 일괄 적재 시 사용. 트리거가 향후 건만 처리하므로 과거 분량은 아래 SQL로 한 번에.

```sql
WITH src AS (
  SELECT
    o.seq_no,
    o.process_date,
    o.cu_want,
    COALESCE(o.product, o.mo_engname) AS kind,
    TRIM(o.cu_name) AS cu_name,
    REGEXP_REPLACE(COALESCE(o.re_content,''),
                   '(\d{2}월\s+\d{2}일\s+\d{2}시\s+\d{2}분)', E'\x01\\1', 'g') AS rc
  FROM orders o
  WHERE COALESCE(o.product, o.mo_engname)
        IN ('임대출장','임대초기설치','임대제품교체','PC 유지보수 출장')
    AND COALESCE(o.re_now, o.status) IN ('완료','출고')
    AND o.process_date >= '2025/06/08'    -- 시작일
    AND o.process_date <= '2026/06/08'    -- 종료일
    AND o.seq_no NOT IN (54458)           -- 수동 SKIP 목록 (예가로드 임대제품교체)
),
joined AS (
  SELECT DISTINCT ON (s.seq_no) s.*, rc.id AS rc_id
    FROM src s
    JOIN rental_customers rc ON TRIM(rc.company) = s.cu_name AND rc.active IS NOT FALSE
   ORDER BY s.seq_no, rc.id
),
chunks AS (SELECT j.*, regexp_split_to_table(j.rc, E'\x01') AS chunk FROM joined j),
ops AS (
  SELECT seq_no, process_date, cu_want, kind, rc_id, chunk,
         regexp_match(chunk,
           '(\d{2})월\s+(\d{2})일\s+(\d{2})시\s+(\d{2})분\s+\S+\s+기사의 의견\s*:\s*(완료|출고|진행|접수|견적|센터|택배|보류)(?:<br\s*/?>)?(.*)',
           's') AS m
    FROM chunks
),
parsed AS (
  SELECT seq_no, process_date, cu_want, kind, rc_id,
         (m[1])::int AS mm, (m[2])::int AS dd, (m[3])::int AS hh, (m[4])::int AS mi,
         m[5] AS st,
         NULLIF(TRIM(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(m[6], '<br\s*/?>', ' ', 'g'), '[\r\n]+', ' ', 'g'), '\s+', ' ', 'g')), '') AS body
    FROM ops WHERE m IS NOT NULL
),
chosen AS (
  SELECT DISTINCT ON (seq_no)
    seq_no, process_date, cu_want, kind, rc_id, mm, dd, body
    FROM parsed
   WHERE st IN ('완료','출고')
   ORDER BY seq_no, CASE st WHEN '완료' THEN 1 WHEN '출고' THEN 2 END,
            mm DESC, dd DESC, hh DESC, mi DESC
),
final AS (
  SELECT c.*,
         COALESCE(
           (SELECT dt FROM (
              SELECT MAKE_DATE(EXTRACT(YEAR FROM TO_DATE(c.process_date,'YYYY/MM/DD'))::int - 1, c.mm, c.dd) AS dt
              UNION ALL SELECT MAKE_DATE(EXTRACT(YEAR FROM TO_DATE(c.process_date,'YYYY/MM/DD'))::int,     c.mm, c.dd)
            ) x
            WHERE dt <= TO_DATE(c.process_date,'YYYY/MM/DD') + INTERVAL '14 days'
            ORDER BY ABS(dt - TO_DATE(c.process_date,'YYYY/MM/DD')) LIMIT 1),
           TO_DATE(c.process_date,'YYYY/MM/DD')
         ) AS svc_date
    FROM chosen c
)
INSERT INTO rental_repairs (id, customer_id, service_date, item_type, work_desc, amount, notes)
SELECT
  'rp_asms_' || f.seq_no,
  f.rc_id,
  f.svc_date,
  CASE WHEN f.kind IN ('임대출장','PC 유지보수 출장') THEN '출장' ELSE '부품교체' END,
  CASE
    WHEN f.kind = '임대초기설치' THEN '임대초기설치 - ' || LEFT(COALESCE(f.body, f.cu_want, ''), 180)
    WHEN f.kind = '임대제품교체' THEN '제품교체 - '       || LEFT(COALESCE(f.body, f.cu_want, ''), 180)
    ELSE LEFT(COALESCE(f.body, f.cu_want, ''), 200)
  END,
  CASE WHEN f.kind IN ('임대출장','PC 유지보수 출장') THEN -30000 ELSE 0 END,
  'ASMS#' || f.seq_no
FROM final f
ON CONFLICT (id) DO NOTHING
RETURNING id, customer_id, service_date, amount;
```

**임대초기설치/교체의 모델별 단가**는 백필 후 임대거래처 UI에서 수동 입력하거나,
별도 UPDATE SQL로 일괄 갱신:

```sql
UPDATE rental_repairs SET amount = -2400000
 WHERE id = 'rp_asms_54131';  -- 엠오비엔터테인먼트 교세라 ECOSYS M251ci
```

## 운영 가이드

### 트리거 비활성/재활성

```sql
ALTER TABLE orders DISABLE TRIGGER tr_sync_asms_to_repairs;  -- 비활성
ALTER TABLE orders ENABLE  TRIGGER tr_sync_asms_to_repairs;  -- 재활성
```

### 적재 현황 확인

```sql
-- 거래처별 합계
SELECT rc.company, COUNT(*) AS rows, SUM(r.amount) AS total
  FROM rental_repairs r
  JOIN rental_customers rc ON rc.id = r.customer_id
 WHERE r.notes LIKE 'ASMS#%'
 GROUP BY rc.company ORDER BY total ASC;

-- 미래 날짜 잡힌 행 (이상)
SELECT id, service_date FROM rental_repairs
 WHERE notes LIKE 'ASMS#%' AND service_date > CURRENT_DATE;

-- 매칭 안 된 ASMS 건 추적 (임대 거래처일 가능성 점검용)
SELECT o.seq_no, o.cu_name, o.process_date, COALESCE(o.product, o.mo_engname) AS kind
  FROM orders o
 WHERE COALESCE(o.product, o.mo_engname)
       IN ('임대출장','임대초기설치','임대제품교체','PC 유지보수 출장')
   AND COALESCE(o.re_now, o.status) IN ('완료','출고')
   AND o.process_date >= '2025/06/08'
   AND NOT EXISTS (
     SELECT 1 FROM rental_customers rc
      WHERE TRIM(rc.company) = TRIM(o.cu_name) AND rc.active IS NOT FALSE
   );
```

### 잘못 적재된 건 삭제 후 재적재

```sql
-- 특정 ASMS 건 삭제
DELETE FROM rental_repairs WHERE id = 'rp_asms_54458';

-- 해당 ASMS 행을 한 번 더 같은 값으로 UPDATE → 트리거 재발동
UPDATE orders SET status = status WHERE seq_no = 54458;
```

## 수동 단가 마스터 (기록)

임대초기설치/제품교체 시 자동 단가 매핑이 불가능하므로 사용자 회신 단가를 기록.

| 모델 | 단가 (네이버 최저가 기준) | 회신일 | 적용 ASMS seq |
|---|---|---|---|
| 브라더 MFC-930DW | -400,000 | 2026-06-08 | 54913 (티에스에프(TSF)) |
| 교세라 ECOSYS M251ci | -2,400,000 | 2026-06-08 | 54131 (엠오비엔터테인먼트) |

## 알려진 한계 / 미해결

### 1. 모델 정보 없는 임대제품교체 — 수동 SKIP

- **예가로드 (seq 54458, 2026-03-09)**: ASMS의 `serial=M40026` 가 `rental_items` 시리얼과 매칭 안 됨
- 백필 SQL에서 `o.seq_no NOT IN (54458)` 로 명시적 제외
- 향후 비슷한 케이스는 사용자가 직접 임대거래처 UI에 추가하거나 SKIP 목록에 추가

### 2. 연락처 매칭 보류

- 회사명 정확 매칭만 사용. 연락처(`cu_tel`/`cu_mobile`) 매칭은 ASMS에 한별시스템 본사 번호가 잘못 저장된 케이스 등으로 오매칭 위험 → 1차 적재에선 제외
- 향후 보강 시 사용자 검토 흐름 + 회사명 부분일치(LIKE)와 조합 권장

### 3. 동명 거래처

`rental_customers` 마스터에 동명 회사 중복 (2026-06-08 시점):
- 신독엔지니어링 2층 (4개)
- 엠에이텍 (2개)
- 우진레이저 (2개)
- 유승산업 (2개)

→ 트리거는 가장 작은 `customer_id` 로 일관 매칭. 다른 매장은 누락됨. 필요 시 임대거래처 마스터 정리 후 재처리.

### 4. ASMS re_content 파싱 한계

- 의견 마지막에 `<br>` 없이 끝나는 케이스 → `(?:<br>)?` optional 패턴으로 처리
- 본문 안에 `\r\n` 포함 시 → sentinel `\x01` 로 헤더 분리하여 본문 보존
- "기사 접수"(`기사의 의견` 아닌 헤더) → 무시됨, 의도된 동작

## 변경 이력

| 일자 | 내용 |
|---|---|
| 2026-06-08 | 1달치 14건 1차 시드 INSERT |
| 2026-06-08 | 1년치 49건 추가 (총 63건) |
| 2026-06-08 | 가후 책략 적용: `service_date` 를 완료 의견 일시로 정렬, work_desc 본문 재추출 |
| 2026-06-08 | 미래 날짜 5건 보정 (process_date+14일 이내 제약) |
| 2026-06-08 | `sync_asms_to_rental_repairs()` 함수 + `tr_sync_asms_to_repairs` 트리거 설치 |
| 2026-06-08 | PC 유지보수 출장 추가 (9건, 엠에이텍 c_0048) — 총 72건 / -4,930,000원 |

## 참고

- 임대거래처 페이지: https://hanbyeolsystem.github.io/totalas/asms.html#rental-customers/index.html
- ASMS 관리툴: https://hanbyeolsystem.github.io/asms-web/
- Supabase 프로젝트: `wghjnlhfqypamiwukeio` (공용 DB)
- 관련 테이블: `orders` (ASMS), `rental_customers` / `rental_repairs` / `rental_items` (임대)
