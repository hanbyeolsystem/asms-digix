# [디직스] 접수관리툴 → 임대거래처 수리내역 자동 기록

> 디직스 전용. Supabase `wghjnlhfqypamiwukeio` 의 `orders` 트리거로
> 접수 건을 임대거래처(rental-customers) 수리내역(`rental_repairs`)에 자동 적재.
> 최초 구축: 2026-07-02

## 규칙

| 접수 제품(`orders.product`) | 발동 시점(상태) | 기록 카드 | `item_type` | `amount` |
|---|---|---|---|---|
| `임대출장` | `완료` 또는 `출고` | 무상수리내역(지출) | `출장` | **-30000** (3만원, 지출이라 음수) |
| `임대(소모품)판매` | **접수 시점부터**(상태 무관) | 유상판매수리내역(수익) | `판매` | **0** (빈값, 추후 임대거래처에서 입력) |

- 무상/유상 구분은 `rental_repairs.item_type` 으로 결정 (프론트 `REPAIR_CATS`: expense=출장/여분토너/부품교체, income=판매/수리).
- 거래처 매칭: `TRIM(orders.cu_name)` = `TRIM(rental_customers.company)`, `active IS NOT FALSE`, 동명 시 가장 작은 `id`. 매칭 실패 시 조용히 skip(접수관리툴 정상 동작 영향 없음).
- 중복 차단: `id = 'rp_asms_' || seq_no` + `ON CONFLICT DO NOTHING` (주문 1건 = 기록 1건).
- `service_date` = `orders.process_date`(YYYY/MM/DD), 파싱 실패 시 `CURRENT_DATE`.
- `work_desc` = `re_content` 의 마지막 "기사의 의견 :" 본문(HTML 제거) → 없으면 `cu_want` → 없으면 제품명. 200자 제한.
- 출처: `notes = 'ASMS#' || seq_no`.

## 오브젝트
- 함수 `sync_orders_to_rental_repairs_digix()`
- 트리거 `tr_sync_orders_repairs_digix` (`AFTER INSERT OR UPDATE ON orders`,
  `WHEN product IN ('임대출장','임대(소모품)판매')`)

## 운영
```sql
-- 비활성/재활성
ALTER TABLE orders DISABLE TRIGGER tr_sync_orders_repairs_digix;
ALTER TABLE orders ENABLE  TRIGGER tr_sync_orders_repairs_digix;

-- 기존 주문 백필(재발동)
UPDATE orders SET updated_at = now() WHERE product IN ('임대출장','임대(소모품)판매');

-- 적재 현황
SELECT r.*, c.company FROM rental_repairs r
  JOIN rental_customers c ON c.id = r.customer_id
 WHERE r.notes LIKE 'ASMS#%' ORDER BY r.created_at DESC;

-- 잘못 적재 건 삭제 후 재적재
DELETE FROM rental_repairs WHERE id = 'rp_asms_<seq>';
UPDATE orders SET status = status WHERE seq_no = <seq>;
```

## 참고 / 한계
- 유상(소모품판매)은 **접수 즉시** 기록되므로, 접수 취소 시 유상 기록이 남을 수 있음 → 임대거래처에서 수동 삭제.
- 한별판(무상만, 여러 제품 대상)과 규칙이 다름: 여기선 임대출장(무상)·임대(소모품)판매(유상) 2종만 대상.
- 임대초기설치/임대제품교체 등은 대상 아님(요청 범위 밖).
