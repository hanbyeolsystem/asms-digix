"""디직스코리아 로고(원형 DK 배지)로 트레이/EXE 아이콘 생성.

입력: assets/digix_logo.png  (디직스코리아 원형 로고 — 정사각형에 가까운 완성형 배지)
출력:
  - icon-source.png  256x256 디버그용
  - icon.png         128x128 (트레이 아이콘)
  - icon.ico         16/24/32/48/64/128/256 다중 해상도 (EXE 아이콘)

전략:
  디직스 로고는 자체 완결된 원형 배지이므로 별도 추출 없이
  투명 정사각형 캔버스에 비율 유지로 올린 뒤 리사이즈한다.

실행: py -3.14 _make_icons.py
"""
import os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'digix_logo.png')

ICO_SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]


def main():
    img = Image.open(SRC).convert('RGBA')
    print(f'source: {SRC} size={img.size}')

    # 정사각형 투명 캔버스 (비율 유지, 약간의 여백)
    w, h = img.size
    side = max(w, h)
    pad = side // 16
    canvas = Image.new('RGBA', (side + pad * 2, side + pad * 2), (255, 255, 255, 0))
    canvas.paste(img, ((canvas.width - w) // 2, (canvas.height - h) // 2), img)

    base = canvas.resize((256, 256), Image.LANCZOS)
    base.save(os.path.join(HERE, 'icon-source.png'), 'PNG')
    print('saved icon-source.png (256x256)')

    tray = base.resize((128, 128), Image.LANCZOS)
    tray.save(os.path.join(HERE, 'icon.png'), 'PNG')
    print('saved icon.png (128x128)')

    base.save(os.path.join(HERE, 'icon.ico'), format='ICO', sizes=ICO_SIZES)
    print(f'saved icon.ico (sizes={ICO_SIZES})')


if __name__ == '__main__':
    main()
