# totalas — 한별시스템 통합 관리 시스템

한별시스템의 임대 / 카운터 / 계약 / 자료 통합 관리 사이트.
정적 HTML/CSS/JS + Supabase + NAS 백업.

## 구조

```
임대관리/
├─ index.html          임대홈
├─ asms.html           접수관리툴 (iframe → asms-web)
├─ errorcode.html      에러코드 (iframe → hanbyeol-errorcode)
├─ customers.html      임대거래처 + OCR + ASMS 연동
├─ contracts.html      임대계약서 (3페이지 A4 양식)
├─ counters.html       임대카운터 (월별 시리얼)
├─ prices.html         가격표 (게시판)
├─ meetings.html       음성미팅관리
├─ archive.html        고객자료실
├─ app.js              공통 store + 거래처 페이지
├─ db.js               IndexedDB Blob 저장소
├─ asms-sync.js        ASMS Supabase 클라이언트
├─ contracts.js        계약서 페이지 로직
├─ counters.js         카운터 페이지 로직
├─ ...
├─ tools/              Python 추출 스크립트
│  ├─ extract_master.py     한별시스템 임대현황.xlsx → seed_customers.json
│  ├─ extract_counters.py   NAS 월별카운터 → seed_counters.json
│  ├─ extract_contracts.py  NAS 세부현황 → seed_contracts.json
│  └─ build_seed.py         3개 JSON → seed-data.js (gitignore)
└─ supabase/
   └─ migrations/      Supabase 스키마
```

## 데이터 저장소

- **Supabase**: `wghjnlhfqypamiwukeio.supabase.co`
  - `rental_customers` — 거래처 마스터
  - `rental_contracts` — 임대계약서
  - `rental_printers` — 시리얼 마스터
  - `rental_counters` — 월별 카운터 (period × serial)
  - `rental_meetings` — 음성미팅 메타데이터
  - `rental_archive` — 고객자료 메타데이터
  - Storage bucket `rental-files` — 첨부 이미지/오디오/PDF
- **NAS**: `\\192.168.0.249\data\rental-backup-YYYYMMDD-vN\`
  - 매일 자동 백업 (Windows 작업스케줄러 + PowerShell)
  - JSON dump + Storage 파일 전체

## 배포

GitHub Pages: `https://hanbyeolsystem.github.io/totalas/` (private repo, 추후 public 전환 시 활성화)

## 로컬 개발

```bash
# 정적 파일이라 별도 빌드 없음
# 브라우저에서 index.html 열기 (file:// 또는 단순 HTTP 서버)
python -m http.server 8000
# → http://localhost:8000
```

## 시드 데이터 재생성

```bash
# 1. 거래처 마스터 추출
python tools/extract_master.py
# 2. NAS 월별카운터 추출
python tools/extract_counters.py
# 3. NAS 세부현황 계약서 추출
python tools/extract_contracts.py
# 4. 시드 빌드
python tools/build_seed.py
# → seed-data.js 생성됨 (gitignore)
```
