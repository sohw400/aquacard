# 화면 글꼴

2026-10-13 3차 개편부터 앱 전체에 **Pretendard Variable**을 사용한다. 기기 기본 글꼴은 대체 글꼴로만 남긴다.

```css
font-family: 'Pretendard Variable', Pretendard, -apple-system, BlinkMacSystemFont,
  'Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans KR', sans-serif;
```

## 바꾼 이유

기기 기본 글꼴만 쓰면 iPhone은 Apple SD Gothic Neo, Windows는 맑은 고딕, Android는 기기마다 다른 글꼴로 보인다. 같은 금액과 버튼이 기기마다 다른 두께와 폭으로 보여 화면 설계를 맞추기 어려웠다. 특히 맑은 고딕은 큰 금액과 굵은 제목에서 화면 품질이 크게 떨어진다.

Pretendard는 Inter 기반 라틴·숫자와 본고딕 계열 한글을 맞춘 글꼴로, 국내 금융·커머스 앱에서 흔히 쓰는 인상과 가깝다. 가변 글꼴이라 한 파일로 400부터 800까지 필요한 굵기를 쓴다.

## 배포 방식

- npm `pretendard@1.3.9`의 동적 서브셋 CSS(`pretendardvariable-dynamic-subset.css`)를 `src/main.tsx`에서 불러온다.
- Vite가 92개 woff2 조각을 빌드 결과에 함께 넣는다. 화면에 나온 글자가 속한 조각만 내려받는다.
- 외부 글꼴 서비스(CDN)를 쓰지 않는다. 브라우저 검사의 외부 요청 금지 조건을 그대로 통과한다.
- `font-display: swap`이라 글꼴을 받기 전에는 대체 글꼴로 먼저 표시한다.

## 숫자와 워드마크

- 금액, 날짜, 수량은 `font-variant-numeric: tabular-nums`로 자릿수 폭을 맞춘다.
- 큰 금액의 `원`은 숫자보다 작고 가늘게 쓴다. 숫자가 먼저 읽히도록 하기 위해서다.
- 앱 머리의 `aqua` 워드마크는 카드 표면과 같은 세리프 이탤릭(Georgia)을 쓴다. 카드 표면 디자인은 바꾸지 않았다.

## 라이선스

Pretendard는 SIL Open Font License 1.1로 배포된다. 앱에 포함해 재배포할 수 있고 글꼴만 따로 판매하는 것은 금지된다. 저작권 표시와 라이선스 전문을 [public/licenses/pretendard-OFL-1.1.txt](../public/licenses/pretendard-OFL-1.1.txt)에 두었고, 빌드 결과의 `licenses/` 경로로 함께 배포된다.

## 검증 범위

브라우저 검사에서 `body`의 계산된 글꼴이 Pretendard Variable인지와 외부 요청이 없는지를 확인한다. 기기 프로필 검사는 Chromium에서 화면 크기만 모사한다. 실제 iOS Safari와 Android Chrome의 렌더링 확인은 별도다.
