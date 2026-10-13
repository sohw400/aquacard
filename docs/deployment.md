# Aqua Card 웹 배포

작성일: 2026-10-13 · 대상: GitHub Pages

## 배포 구성

GitHub의 `main` 브랜치 변경 또는 수동 실행으로 `.github/workflows/pages.yml`이 동작한다. 의존성을 lockfile대로 설치하고 금융 로직 테스트를 실행한 다음, Pages 설정의 실제 경로를 반영해 정적 사이트를 빌드·업로드·게시한다. Actions는 공식 저장소에서 확인한 커밋으로 고정했다.

공개 주소는 [https://sohw400.github.io/aquacard/](https://sohw400.github.io/aquacard/)이다. 2026-10-13 [배포 실행](https://github.com/sohw400/aquacard/actions/runs/38338232648)의 `build`와 `deploy`가 성공했고, 공개 주소의 HTTP 200 응답과 Aqua Card 제목을 확인했다. JS·CSS·favicon도 올바른 콘텐츠 형식으로 HTTP 200을 반환하며, 내려받은 HTML·파일은 검증한 프로덕션 빌드와 바이트 단위로 일치한다.

현재 앱은 정적 웹 PoC이며 API 서버·비밀값·실제 결제 기능이 필요하지 않다. 공개 화면에도 데모임을 표시한다. 브라우저의 데모 상태는 공개 사이트에서 별도로 생성되고 다른 방문자와 공유되지 않는다.

## 최초 GitHub 설정

현재 저장소는 사용자가 공개로 변경했으며, Pages의 `build_type`은 `workflow`이고 HTTPS 강제가 활성화되어 있다. 아래 절차는 최초 설정 또는 재설정 시 사용한다.

1. [저장소 Pages 설정](https://github.com/sohw400/aquacard/settings/pages)에서 **Build and deployment → Source → GitHub Actions**를 선택한다. 이미 선택돼 있으면 유지한다.
2. [배포 워크플로](https://github.com/sohw400/aquacard/actions/workflows/pages.yml)에서 **Run workflow → main**을 실행한다. 활성화 전 실패한 실행이 있으면 다시 실행한다.
3. `build`와 `deploy`가 성공한 뒤 GitHub가 제공한 게시 주소를 연다.

Pages 최초 활성화에는 저장소 관리 권한이 필요하다. `configure-pages`의 기본 Actions 토큰만으로 최초 활성화를 보장할 수 없다. 저장소 공개 여부·GitHub 요금제에 따라 Pages 사용 가능 여부도 확인해야 하며, 배포를 위해 저장소의 공개 범위를 자동 변경하지 않는다.

## 로컬 배포 빌드 검증

```bash
cd /workspace/aquacard
npm run build:pages
npm run preview:pages
```

다른 터미널에서 프로젝트 경로를 지정해 브라우저 검증을 실행한다.

```bash
cd /workspace/aquacard
AQUA_BASE_URL=http://127.0.0.1:4173/aquacard/ npm run test:browser
AQUA_BASE_URL=http://127.0.0.1:4173/aquacard/ npm run test:devices
```

이는 GitHub Pages의 하위 경로에서 JS·CSS·favicon이 로드되고 카드·지갑 기능이 동작하는지 확인하는 내부 검증이다. 실제 GitHub 게시 성공을 대신하지 않는다.

## 공개 사이트 검증과 환경 인증서

`api.github.com`과 `sohw400.github.io` 허용 설정 적용 및 환경 재시작 후 GitHub API와 공개 사이트 조회가 동작했다. HTTPS 인증서를 검증하는 HTTP 클라이언트로 공개 HTML·파일을 확인했다.

이 클라우드 환경의 Chromium은 공개 주소에서 `ERR_CERT_AUTHORITY_INVALID`를 반환했다. 환경 프록시 CA를 브라우저의 영구 인증서 저장소에 추가하는 작업은 자동 승인 검토에서 거절됐으며, 인증서 검증을 끄지 않았다. 대신 HTTPS 검증을 거쳐 내려받은 실제 배포 파일을 내부 서버로 제공해 기존 기능·기기 화면 테스트를 실행했다. 이는 공개 주소를 Chromium에서 직접 연 검증과 구분한다. 기기 테스트는 Chromium 화면·터치 모사이며 실제 iOS Safari나 Android 기기 검증을 대신하지 않는다.

참고: [공식 Pages 설정 안내](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site), [configure-pages의 최초 활성화 권한](https://github.com/actions/configure-pages/blob/main/action.yml).
