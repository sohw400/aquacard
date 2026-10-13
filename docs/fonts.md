# 화면 글꼴

2026-10-13 개편부터 기기에 설치된 기본 글꼴을 사용한다. 별도 웹 글꼴을 내려받지 않는다.

```css
font-family: -apple-system, BlinkMacSystemFont,
  'Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans CJK KR', sans-serif;
```

사용하는 기기와 브라우저에서 지원하는 순서에 따라 글꼴이 결정된다. iPhone의 한글은 Apple SD Gothic Neo, Windows는 맑은 고딕, 그 밖의 기기는 설치된 시스템 글꼴로 표시한다. 숫자는 금액 간 정렬을 위해 tabular-nums를 지정한다.

카드 표면의 기존 워드마크와 3D 디자인은 유지한다. 앱의 메뉴, 버튼, 잔액 및 안내에는 기본 글꼴을 사용한다.

이전 Aqua Sans 웹 글꼴과 관련 배포 파일은 제거했다. 글꼴 요청이 없으므로 별도 다운로드나 외부 글꼴 서비스 연결이 필요하지 않다.

기기 프로필 검사는 Chromium에서 지정한 화면 크기로 실행한다. 실제 iOS의 시스템 글꼴과 Safari 렌더링 검증은 별도다.
