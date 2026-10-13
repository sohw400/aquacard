# Aqua Card 웹 배포

작성일: 2026-10-13 · 대상: GitHub Pages

## 배포 구성

GitHub의 `main` 브랜치 변경 또는 수동 실행으로 `.github/workflows/pages.yml`이 동작한다. 의존성을 lockfile대로 설치하고 금융 로직 테스트를 실행한 다음, Pages 설정의 실제 경로를 반영해 정적 사이트를 빌드·업로드·게시한다. Actions는 공식 저장소에서 확인한 커밋으로 고정했다.

기본 프로젝트 주소는 `https://sohw400.github.io/aquacard/`가 될 수 있다. **주소를 적었다는 것이 현재 서비스가 게시되거나 접속 검증됐다는 뜻은 아니다.** 실제 주소와 성공 여부는 GitHub Pages 설정·배포 결과로 확인한다.

현재 앱은 정적 웹 PoC이며 API 서버·비밀값·실제 결제 기능이 필요하지 않다. 공개 화면에도 데모임을 표시한다. 브라우저의 데모 상태는 공개 사이트에서 별도로 생성되고 다른 방문자와 공유되지 않는다.

## 최초 GitHub 설정

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

## 현재 환경의 외부 접근 제한

Git push는 동작하지만 `api.github.com` 관리 API와 `sohw400.github.io` 사이트 조회는 현재 네트워크 정책에서 차단됐다. 이를 GitHub 자격 증명 부족으로 단정하지 않는다. 두 호스트를 기존 사용자 지정 허용 도메인에 추가한 초안을 저장하고, 실제 설정이 반영되면 Pages 상태·접속 여부를 다시 확인한다. 초안 저장만으로 현재 네트워크에 반영됐다고 주장하지 않는다.

참고: [공식 Pages 설정 안내](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site), [configure-pages의 최초 활성화 권한](https://github.com/actions/configure-pages/blob/main/action.yml).
