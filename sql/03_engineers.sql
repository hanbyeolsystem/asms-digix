-- engineers 테이블: A/S 엔지니어(사용자) 정보
CREATE TABLE IF NOT EXISTS public.engineers (
  en_id        TEXT PRIMARY KEY,            -- 로그인 ID 역할 (이메일 prefix)
  email        TEXT UNIQUE NOT NULL,        -- 인증용 이메일 (auth.users 와 매칭)
  en_name      TEXT NOT NULL,
  en_branch    TEXT DEFAULT '본사',
  en_tel       TEXT,
  en_mobile    TEXT,
  en_role      TEXT DEFAULT 'engineer',     -- 'admin' | 'engineer'
  user_id      UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_engineers_name   ON public.engineers (en_name);
CREATE INDEX IF NOT EXISTS idx_engineers_branch ON public.engineers (en_branch);

DROP TRIGGER IF EXISTS trg_engineers_updated ON public.engineers;
CREATE TRIGGER trg_engineers_updated BEFORE UPDATE ON public.engineers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.engineers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "auth all - engineers" ON public.engineers;
CREATE POLICY "auth all - engineers"
  ON public.engineers FOR ALL
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');
