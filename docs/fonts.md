# 자체 호스팅 글꼴

Aqua Card는 Pretendard 1.3.9의 가변 글꼴을 현재 화면에 필요한 문자로 줄인 **Aqua Sans**를 사용합니다. 외부 글꼴 서버에 요청하지 않으며 npm 의존성을 추가하지 않았습니다.

## 출처와 라이선스

- 원본 프로젝트: [orioncactus/pretendard](https://github.com/orioncactus/pretendard)
- npm 패키지: [`pretendard@1.3.9`](https://www.npmjs.com/package/pretendard/v/1.3.9)
- 공식 아카이브: `https://registry.npmjs.org/pretendard/-/pretendard-1.3.9.tgz`
- 원본 글꼴 경로: `package/dist/public/variable/PretendardVariable.ttf`
- 라이선스: SIL Open Font License 1.1. [원문](../public/fonts/LICENSE.txt)을 함께 배포합니다.

원본 라이선스의 Reserved Font Name은 `Pretendard`입니다. 문자를 삭제한 수정본은 이 이름을 사용할 수 없으므로 배포 글꼴의 family·full name·PostScript 이름을 `Aqua Sans` / `AquaSansVariable`로 변경했습니다. 원본 저작권과 라이선스 정보는 보존했습니다. 원본 저자가 이 수정본을 보증한다는 의미는 아닙니다.

## 배포 파일과 범위

| 항목 | 값 |
| --- | --- |
| 파일 | `public/fonts/AquaSansVariable.woff2` |
| 크기 | 121,936 bytes, 약 119 KiB |
| 비교한 원본 WOFF2 크기 | 2,057,688 bytes |
| 감소율 | 약 94% |
| 문자 / 글리프 | 676 code points / 1,070 glyphs |
| 가변 축 | `wght`: 45–930, 기본 400 |
| 생성 도구 | FontTools 4.61.1, Brotli 1.1.0 |

현재 `src/**/*.ts`와 `src/**/*.tsx`에 사용된 문자, 기본 라틴 문자, Latin-1, 일반 문장부호, 통화 기호, 한글 호환 자모를 포함합니다. [unicode-range.txt](../public/fonts/unicode-range.txt)는 실제 글꼴에 포함된 문자 범위입니다. [font-metadata.json](../public/fonts/font-metadata.json)에 범위와 해시를 기록했습니다.

사용자가 입력한 가맹점명 등의 추가 문자는 시스템 글꼴로 표시됩니다. 앱 문구를 바꿀 때 새 한글 음절이 추가되면 이 글꼴도 다시 생성하세요.

## CSS 적용

```css
@font-face {
  font-family: 'Aqua Sans';
  src: url('/fonts/AquaSansVariable.woff2') format('woff2');
  font-style: normal;
  font-weight: 45 930;
  font-display: swap;
  /* unicode-range: unicode-range.txt의 한 줄 전체를 여기에 사용 */
}

:root {
  font-family: 'Aqua Sans', -apple-system, BlinkMacSystemFont,
    'Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans CJK KR', sans-serif;
}
```

`unicode-range`를 생략해도 없는 글리프는 fallback으로 표시됩니다. 명시하면 포함되지 않은 문자에는 처음부터 시스템 글꼴을 사용합니다. 가변 축을 유지했으므로 450, 550, 650 등의 중간 굵기도 실제 글꼴에서 렌더링합니다.

## 무결성

공식 npm 아카이브의 TLS 및 npm integrity 검증을 유지했고, 추출 전 SHA-512도 대조했습니다.

```text
npm archive integrity:
sha512-PaQAADyLY5v4kYFwkpSJHbSSYIkiriY/1xXw75TKoZ9UQQqeU+tvP05yTdZAWibiIYoo8ZKtRv8PM7w0IaywSw==

source PretendardVariable.ttf SHA-256:
3090ccde0442bb347aa7685d9ba8b17436a60682df6e8f92a9a670de14056e22

source PretendardVariable.woff2 SHA-256:
9599f12fd42fc0bce1cd50b47a0c022e108d7aa64dd0d1bb0ed44f3282d900b4

AquaSansVariable.woff2 SHA-256:
6eab0ca3dedfb9183c1c6001e0fac7745d1b211b0392f8cc9d6beb9244547a82

LICENSE.txt SHA-256:
b04538c9abec39a3db75108cf0af0fd9c77032fe8aa2cf38345b4d250e98e38e
```

## 다시 생성하기

도구와 원본은 `/tmp`에서 준비하며 저장소의 `package.json`이나 lockfile을 바꾸지 않습니다. npm 아카이브는 여러 글꼴이 포함되어 약 72 MB이므로 전체 패키지를 설치하지 않고 필요한 파일만 추출합니다.

```bash
npm pack pretendard@1.3.9 --ignore-scripts \
  --cache /tmp/aquacard-npm-cache --pack-destination /tmp --json \
  > /tmp/aquacard-pretendard-pack.json

python -m pip install fonttools==4.61.1 Brotli==1.1.0 \
  --target /tmp/aquacard-font-tools --index-url https://pypi.org/simple \
  --disable-pip-version-check --no-deps --no-cache-dir
```

저장소 루트에서 다음 Python 스크립트를 `PYTHONPATH=/tmp/aquacard-font-tools python`으로 실행합니다. 원본 해시가 일치하지 않으면 중단합니다. 생성 후 메타데이터의 크기·해시와 이 문서를 갱신하세요.

```python
from pathlib import Path
from fontTools import subset
from fontTools.ttLib import TTFont
import base64, hashlib, json, tarfile

root = Path.cwd()
archive = Path('/tmp/pretendard-1.3.9.tgz')
expected = 'PaQAADyLY5v4kYFwkpSJHbSSYIkiriY/1xXw75TKoZ9UQQqeU+tvP05yTdZAWibiIYoo8ZKtRv8PM7w0IaywSw=='
assert base64.b64encode(hashlib.sha512(archive.read_bytes()).digest()).decode() == expected
source_dir = Path('/tmp/aquacard-font-source')
source_dir.mkdir(exist_ok=True)
with tarfile.open(archive) as package:
    for name in ['dist/public/variable/PretendardVariable.ttf', 'dist/LICENSE.txt']:
        data = package.extractfile(f'package/{name}').read()
        (source_dir / Path(name).name).write_bytes(data)

source = source_dir / 'PretendardVariable.ttf'
font = TTFont(source, recalcTimestamp=False)
text = ''.join(p.read_text() for p in sorted((root / 'src').rglob('*'))
               if p.suffix in {'.ts', '.tsx'})
requested = (set(range(0x20, 0x7f)) | set(range(0xa0, 0x100))
             | set(range(0x2000, 0x2070)) | set(range(0x20a0, 0x20d0))
             | set(range(0x3131, 0x3164)) | {ord(c) for c in text if ord(c) >= 0x20})
unicodes = sorted(requested & set(font.getBestCmap()))
options = subset.Options()
options.layout_features = ['*']
options.name_IDs = ['*']
options.name_legacy = True
options.name_languages = ['*']
options.notdef_glyph = True
options.notdef_outline = True
options.recommended_glyphs = True
builder = subset.Subsetter(options=options)
builder.populate(unicodes=unicodes)
builder.subset(font)
names = {1: 'Aqua Sans', 3: 'AquaSansVariable-1.3.9-AquaSubset',
         4: 'Aqua Sans Variable', 6: 'AquaSansVariable',
         16: 'Aqua Sans', 25: 'AquaSans'}
for record in font['name'].names:
    if record.nameID in names:
        record.string = names[record.nameID].encode(record.getEncoding())
font.flavor = 'woff2'
output_dir = root / 'public/fonts'
output_dir.mkdir(exist_ok=True)
output = output_dir / 'AquaSansVariable.woff2'
font.save(output)
(output_dir / 'LICENSE.txt').write_bytes((source_dir / 'LICENSE.txt').read_bytes())
ranges = []
for point in unicodes:
    if ranges and point == ranges[-1][1] + 1:
        ranges[-1][1] = point
    else:
        ranges.append([point, point])
unicode_range = ','.join(f'U+{a:04X}' if a == b else f'U+{a:04X}-{b:04X}'
                         for a, b in ranges)
(output_dir / 'unicode-range.txt').write_text(unicode_range + '\n')
metadata = {
    'upstream': 'pretendard', 'version': '1.3.9', 'license': 'OFL-1.1',
    'family': 'Aqua Sans', 'file': output.name,
    'sizeBytes': output.stat().st_size,
    'sha256': hashlib.sha256(output.read_bytes()).hexdigest(),
    'sourceTtfSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
    'fontTools': '4.61.1', 'brotli': '1.1.0',
    'unicodeCount': len(unicodes), 'glyphCount': font['maxp'].numGlyphs,
    'variationAxes': [{'tag': a.axisTag, 'min': a.minValue,
                       'default': a.defaultValue, 'max': a.maxValue}
                      for a in font['fvar'].axes],
    'unicodeRange': unicode_range,
}
(output_dir / 'font-metadata.json').write_text(
    json.dumps(metadata, ensure_ascii=False, indent=2) + '\n')
print(metadata['sizeBytes'], metadata['sha256'])
```

## 확인한 결과

- 현재 소스에 포함되고 원본 글꼴이 지원하는 문자 중 subset에서 빠진 문자 없음.
- Chromium에서 `/fonts/AquaSansVariable.woff2` 응답 200, 121,936 bytes.
- `FontFace.load()` 완료, 550 굵기의 한국어·원화 숫자 `document.fonts.check()` 통과.
- 글꼴 디코딩 관련 페이지 오류 없음.
