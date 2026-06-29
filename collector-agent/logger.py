"""에이전트 로그 — %APPDATA%\\digix-collector\\agent.log"""
import os, datetime
import config

PATH = os.path.join(config.BASE, 'agent.log')
MAX_BYTES = 2_000_000  # 2MB 넘으면 .1 백업으로 회전


def log(msg: str) -> None:
    ts = datetime.datetime.now().isoformat(timespec='seconds')
    line = f'[{ts}] {msg}\n'
    try:
        if os.path.exists(PATH) and os.path.getsize(PATH) > MAX_BYTES:
            bak = PATH + '.1'
            try:
                if os.path.exists(bak):
                    os.remove(bak)
                os.replace(PATH, bak)
            except Exception:
                pass
        with open(PATH, 'a', encoding='utf-8') as f:
            f.write(line)
    except Exception:
        pass
    # stderr 출력은 --noconsole 빌드에서 무시되지만 개발 중엔 보임
    try:
        print(line, end='')
    except Exception:
        pass
