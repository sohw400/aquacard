# Aqua 모바일 앱 준비 (iOS·Android)

작성일: 2026-10-13 · 상태: 스택 제안과 사전 준비 목록. 스택과 일정은 아직 정하지 않았다.

이 문서는 웹 PoC를 아이폰·안드로이드 앱으로 옮기기 전에 정할 것과 미리 준비할 것을 정리한다. 2026-10-13에 공식 문서와 보도를 조사했다. 일부 사이트는 이 환경에서 열리지 않아 검색 결과 발췌로 확인했고, 그런 항목은 출처에 `발췌`로 표시했다. 법률 자문이 아니다.

## 1. 결론

- **추천 스택은 React Native + Expo(TypeScript)다.**
  - 지금 체험판의 금액·수수료·멤버십·태그 규칙이 모두 TypeScript여서 그대로 공유할 수 있다.
  - React Native 팀도 Expo 같은 프레임워크로 시작하기를 권한다.
  - 금융 보안·본인확인·전자지갑처럼 네이티브 SDK만 있는 기능은 네이티브 엔지니어 1~2명이 Expo 모듈로 감싼다.
- **출시 빌드는 React Native 0.88 / Expo SDK 58 이상으로 잡는다.**
  - 2027년 4월부터 App Store 제출에는 iOS 27 SDK가 필요하고, iOS 27 SDK로 빌드하면 UIScene 생명주기를 쓰지 않는 앱은 실행되지 않는다.
  - React Native는 0.88에서 이를 지원하고, Expo는 SDK 58부터 기본으로 켠다.
- **가장 오래 걸리는 준비는 코드가 아니라 자격이다.**
  - Google Play는 2026-01-28부터 한국에서 가상자산 앱 개발자에게 금융정보분석원(FIU) 가상자산사업자 신고를 요구한다(보도).
  - Apple도 가상자산 거래 기능은 허가받은 지역에서만, 서비스를 하는 법인 명의로 제출하게 한다.
  - Aqua는 잔액을 보관하고 받은 코인을 바로 바꾸므로 두 스토어 모두 거래소·수탁 지갑으로 볼 가능성이 크다. 개발자 계정은 신고한 법인 명의여야 한다.
- **다시 검토할 조건.** 팀이 커지고 OS 새 디자인을 바로 따라가는 것이 가장 중요해지면 "네이티브 화면 + 공유 로직"(Swift·Kotlin, 또는 KMP)을 다시 본다. 2026-09 Shopify가 모든 앱을 네이티브로 옮긴다고 밝힌 것처럼, AI 도구로 두 벌을 관리하는 비용이 내려간 것이 근거로 거론된다.

## 2. 요즘 흐름 (2026-10 기준)

### 크로스플랫폼 프레임워크

| 스택 | 현황 |
| --- | --- |
| React Native | 최신 안정판 0.87.1(2026-08-26), 0.88 RC 진행 중. 새 아키텍처는 0.76(2024-10)에서 기본이 됐고 0.82(2025-10)부터 새 아키텍처로만 돈다. 0.84(2026-02)부터 Hermes V1이 기본이다. React Compiler 1.0(2025-10)은 Expo SDK 54 이상에서 기본으로 켜진다 |
| Expo | 최신 안정판 SDK 57(2026-06-30, RN 0.86), SDK 58 베타(2026-09-15, iOS 27 대응). SDK 56에서 SwiftUI·Jetpack Compose 컴포넌트를 쓰는 Expo UI가 안정판이 됐다. 개발 빌드와 config plugin으로 어떤 네이티브 SDK든 넣을 수 있고, EAS가 빌드·스토어 제출·업데이트를 맡는다 |
| 앱 업데이트(OTA) | Microsoft CodePush는 App Center와 함께 2025-03-31에 끝났다. 대안은 EAS Update, 오픈소스 자가 호스팅 Hot Updater 등이다. Apple 규칙상 내려받은 코드로 앱의 주 목적을 바꾸거나 보안을 우회하면 안 되므로 OTA는 버그 수정에만 쓴다 |
| Flutter | 3.47(2026-08-12). iOS 27 SDK가 요구하는 UIScene으로 자동 이전한다. Material·Cupertino를 별도 패키지로 떼어냈고 Liquid Glass·Material 3 Expressive 공식 구현은 진행 중이다. 2026 로드맵 기준 구글 밖 기여자가 구글 직원보다 많다 |
| Kotlin Multiplatform | KMP 안정판 2023-11, Compose Multiplatform iOS 안정판 1.8.0(2025-05), 최신 1.12.1(2026-09). Cash App은 로직만 공유하고 화면은 네이티브로 둔다. Swift Export는 베타로 가는 중이다 |
| 네이티브 | Swift 6.4(2026-09), Jetpack Compose 1.12. 2026-09 Shopify가 모든 앱을 Swift·Kotlin으로 옮긴다고 밝혔다(발췌). Coinbase도 네이티브 재작성 채용을 냈다는 보도가 있다(발췌, 공식 발표 미확인) |

### 다른 회사들이 쓰는 것

| 회사 | 스택 | 근거 |
| --- | --- | --- |
| 토스 | React Native. 사내 RN 프레임워크 Granite를 공개했고(Apache-2.0), 앱인토스 미니앱이 그 위에서 돈다 | GitHub 원문, 발표 발췌 |
| 카카오뱅크 | 네이티브(Swift 채용 기준) | 채용 공고 발췌 |
| 업비트 | iOS는 Swift, 두나무 Web3 지갑은 React Native | 채용 공고 발췌 |
| 빗썸 | 빗썸페이에 React Native 채용 | 채용 공고 발췌 |
| KAST | Flutter(채용 기준) | 채용 공고 발췌 |
| Coinbase | 2021년 React Native로 전환, 2026년 네이티브 재작성 채용 | 공식 블로그·채용 공고 발췌 |
| Nubank | Flutter | 기술 블로그 발췌 |
| Cash App | 네이티브 + KMP | Kotlin 사례 원문 |
| Robinhood | 네이티브 + 서버 주도 UI | 공식 글 발췌 |
| Kraken | React Native(채용 기준) | 채용 공고 발췌 |

카카오페이·네이버페이·뱅크샐러드는 확인하지 못했다.

### 출시 일정에 걸리는 플랫폼 요건

| 요건 | 날짜 | 영향 |
| --- | --- | --- |
| App Store 제출에 Xcode 26 / iOS 26 SDK 필요 | 2026-04-28부터 | 이미 적용 중 |
| App Store 제출에 iOS 27 SDK 필요 | 2027-04부터 | iOS 27 SDK로 빌드하면 Liquid Glass를 끄는 설정이 무시되고, UIScene을 쓰지 않는 앱은 실행되지 않는다. RN 0.88 / Expo SDK 58 이상이 필요하다 |
| 폴더블 아이폰 화면 | Apple 공지(2026-10-05) | 2027-04부터 해당 기기 스크린샷이 필요하다. 접히는 화면의 배치를 미리 본다 |
| Google Play 대상 API 36 | 2026-08-31부터(연장 시 2026-11-01) | API 36 대상이면 화면 끝까지 그리기(edge-to-edge)를 끌 수 없고, 600dp 이상 화면에서 방향·크기 고정이 무시된다 |
| Android 16 KB 페이지 크기 | 2027-02-01부터 지키지 않은 앱의 업데이트 차단 | 네이티브 라이브러리(.so)가 든 SDK는 다시 빌드돼 있어야 한다. 국내 보안·본인확인 SDK의 대응 여부를 계약 전에 확인한다 |
| Material 3 Expressive | 2026년 하반기 안정판 예정(발췌) | 안드로이드 화면 기준이 바뀐다 |

### 그 밖의 흐름

- **패스키**: FIDO 얼라이언스가 패스키 50억 개를 발표했다(2026-05, 발췌). 비밀번호 대신 기기 생체 인증으로 로그인하는 흐름이 기본이 되고 있다.
- **미니앱**: 앱인토스는 미니앱 1만 개, 월 사용자 400만 명을 발표했다(2026-08, 발췌). Apple은 미니앱 파트너 프로그램(2025-11)을 만들고 가이드라인 4.7로 HTML5·JS 미니앱을 다룬다. Aqua를 토스 안의 미니앱으로도 낼 수 있는지 볼 만하다.
- **서버 주도 UI**: 화면 구성을 서버가 내려 주어 앱 업데이트 없이 바꾼다(Robinhood). 혜택·이벤트 화면에 맞다.
- **온디바이스 AI**: iOS 26의 Apple Foundation Models를 React Native에서 부르는 래퍼가 나와 있다(발췌). 거래 내역 요약 같은 기능 후보다.
- **모노레포**: 웹·앱이 TypeScript 도메인 로직을 패키지로 나눠 쓰는 구성이 흔하다(Turborepo + Expo 템플릿).

## 3. 스택 비교 (이 팀과 이 제품 기준, 5점이 가장 유리)

| 기준 | React Native + Expo | Flutter | KMP + Compose MP | 네이티브 |
| --- | --- | --- | --- | --- |
| 지금 TypeScript 코드 재사용 | 5 | 1 | 1 | 1 |
| 네이티브 SDK 연동(보안 키패드, 삼성페이, 카드 추가) | 4 | 3 | 4 | 5 |
| 국내 채용 | 4 | 3 | 2 | 3 (두 팀 필요) |
| 성능·사용감 | 4 | 3 | 3 | 5 |
| 장기 위험(5가 낮음) | 3 | 3 | 3 | 5 (비용은 가장 큼) |

점수 근거는 다음과 같다.

- **삼성페이.** 공식 Flutter 플러그인(카드 추가 포함)은 있고, 공식 React Native 플러그인은 없다. React Native에서는 Android SDK를 직접 감싸야 한다(발췌).
- **Apple Pay·Google Wallet 카드 추가.** React Native용 오픈소스 라이브러리가 있다. 다만 어느 쪽이든 Apple의 특별 승인과 발급사 준비가 먼저다.
- **보안 SDK.** 국내 보안 키패드(라온시큐어 TouchEn mTranskey)는 네이티브 라이브러리로 제공된다. 앱 보호 솔루션 중 LIAPP·AppSuit는 React Native와 Flutter 지원을 밝혔다(발췌). 나머지는 확인하지 못했다.
- **OTA와 위변조 검증.** OTA로 받은 JS 번들이 앱 위변조 검증 범위에 들어가는지는 확인하지 못했다. 보안 솔루션 PoC에서 같이 본다.
- **장기 위험.** React Native는 Shopify·Coinbase의 이탈 신호가 있고, OS 대응이 RN·Expo 릴리스를 기다려야 한다. Flutter는 구글 투자 축소 신호(2024 감원 보도)가 있다.

## 4. 추천 구성

| 영역 | 선택 | 메모 |
| --- | --- | --- |
| 프레임워크 | Expo(개발 빌드, CNG), Expo Router, TypeScript | Expo Go가 아니라 개발 빌드를 쓴다. 네이티브 폴더는 config plugin으로 생성한다 |
| 공유 코드 | 모노레포(pnpm workspace + Turborepo): `apps/web`, `apps/mobile`, `packages/core`, `packages/tokens` | 금액·수수료·검증·문구 규칙을 `packages/core`로 옮긴다 |
| 서버 데이터 | TanStack Query | 원장은 서버가 가진다. 앱은 캐시와 재시도만 한다 |
| 입력 검증 | Zod 스키마를 core에 두고 앱·웹·서버가 같이 쓴다 | 지금 엔진의 검증 규칙을 스키마로 옮긴다 |
| 화면 | Expo UI(SwiftUI·Compose)와 RN 컴포넌트, Reanimated | iOS 27 Liquid Glass는 네이티브 컴포넌트로 맞춘다 |
| 디자인 토큰 | 웹 CSS 변수를 토큰 파일로 빼서 웹·앱이 같이 읽는다 | Pretendard는 OFL이라 앱에 넣을 수 있다 |
| 로그인·보관 | 생체 인증(Face ID·지문, Android BIOMETRIC_STRONG), 키체인·키스토어, 패스키 | Apple은 얼굴 인증에 LocalAuthentication을 쓰도록 한다 |
| 무결성 | App Attest(iOS), Play Integrity(Android) + 국내 앱 보호 솔루션 | 인증서 고정은 Apple이 대부분의 경우 피하라고 한다. 보안 솔루션 정책과 함께 정한다 |
| 알림 | APNs·FCM(HTTP v1) | 광고성 알림은 별도 동의, 야간(21~8시) 별도 동의, 2년마다 재확인 |
| 링크 | 유니버설 링크·앱 링크로 QR 주소를 앱에서 연다 | `/@태그` 경로가 AASA 경로 규칙에 맞는지 확인한다. 안 맞으면 `/u/태그`처럼 바꾼다 |
| 배포 | EAS Build·Submit, TestFlight·Play 내부 테스트, EAS Update는 버그 수정에만 | 강제 업데이트용 최소 버전은 서버가 내려 준다 |
| 품질 | Sentry, Maestro 시나리오 테스트, core 단위 테스트 | 지금 브라우저 검사 순서를 Maestro로 옮긴다 |

## 5. 웹 PoC에서 가져갈 것

| 웹 PoC | 앱에서 | 바꿀 점 |
| --- | --- | --- |
| `src/lib`의 금액·수수료·멤버십·페이백·태그·연간 내역 규칙(`policy`, `format`, `directory`, `statement`, `engine`) | `packages/core`로 옮겨 웹·앱·서버가 같이 쓴다 | 실서비스의 원장은 서버가 가진다. 앱은 표시·입력 검증·안내 문구에만 쓴다 |
| `engine.ts`의 브라우저 저장(`localStorage`) | 체험판 앱에서는 기기 저장소로 바꾼다 | 저장 위치를 주입받게 바꾼다 |
| `auth.ts`의 비밀번호 해시(`crypto.subtle`) | 체험판 앱에서만 필요하다 | 앱 런타임에는 Web Crypto가 없을 수 있어 암호 모듈로 바꾸거나 서버 인증으로 대신한다 |
| 날짜 형식(`Intl.DateTimeFormat`의 서울 시간대, `formatToParts`) | Hermes에서 그대로 되는지 확인한다 | 지원이 모자라면 날짜 라이브러리로 감싼다 |
| 화면 구조(홈·카드·혜택·전체), 해요체 문구, 3D 카드 이미지 | 그대로 옮긴다 | 하단 탭은 각 OS 기본 탭으로 바꾼다 |
| 단위 테스트 115개 | core와 함께 옮긴다 | 그대로 실행한다 |
| 브라우저·기기 검사(Playwright) | Maestro 시나리오로 다시 쓴다 | 같은 체험 순서를 앱 화면에서 반복한다 |

## 6. 앱에서 새로 생기는 일

- **로그인.** 생체 인증과 간편 비밀번호 6자리, 보안 키패드가 필요하다. 비밀번호는 암호화해 보관하고 틀린 횟수를 제한한다.
- **보호.** 앱 위변조 검증, 루팅·탈옥 탐지, 카드 정보 화면의 캡처 방지가 필요하다. Android는 `FLAG_SECURE`로 막고, iOS는 녹화·미러링 감지로 가린다.
- **알림.** 받은 돈, 결제, 충전 진행을 알린다. "혜택 알림"도 광고로 보므로 광고성 알림 동의를 따로 받는다.
- **QR.** 실제 카메라로 상대 QR을 찍는다. `https://도메인/@태그` 링크는 앱에서 열린다.
- **전자지갑.** 앱 안에서 Samsung Pay·Apple Pay에 카드를 추가한다. 카드 발급 파트너 SDK와 Apple 특별 승인이 필요하다.
- **카드 정보.** 카드번호·CVC는 발급 파트너가 주는 보안 화면으로 보여 준다. 우리 서버가 카드번호를 직접 다루지 않게 한다.
- **권한과 계정.** 앱 접근 권한을 고지하고 동의를 받는다. 계정 삭제는 앱 안 경로와 웹 링크를 모두 둔다(Google Play 요건).
- **얼굴 인증.** 얼굴 정보는 민감정보라서 다른 동의와 따로 받는다.

## 7. 출시 전에 넘어야 할 것

### 스토어의 가상자산 정책

- **Apple.**
  - 가이드라인 3.1.5(iii): 가상자산 거래·전송 기능은 허가·면허를 받은 지역에서만 제공할 수 있다.
  - 2025-11-13 개정: 5.1.1(ix)의 고규제 분야에 가상자산 거래소가 추가됐다. 서비스를 제공하는 법인이 직접 제출해야 한다. 3.2.1(viii)도 금융 앱은 그 서비스를 하는 기관이 내도록 한다.
- **Google Play.**
  - 한국에서는 금융정보분석원에 가상자산사업자 신고를 마친 개발자만 가상자산 거래소·수탁 지갑 앱을 낼 수 있다. 2026-01-14 정책 갱신, 2026-01-28 시행이다(보도·정책 페이지 발췌).
  - 비수탁형 지갑은 대상이 아니다.
  - 요건을 못 갖춘 나라는 배포 국가에서 빼야 한다.
- **Aqua에 대한 해석.** 잔액을 보관하고 받은 코인을 바로 바꾸므로 거래소·수탁 지갑으로 분류될 가능성이 크다. 가상자산사업자 신고(ISMS 인증 선행)가 앱 배포의 전제다.

### 금융 보안

- **전자금융감독규정**(2026-07-15 시행본)이 정한 것:
  - 통신 암호화(제34조).
  - 전자금융거래 프로그램의 위·변조 여부 등 무결성을 검증할 방법 제공(제34조).
  - 거래 위험에 맞는 안전한 인증(제34조의2).
  - 비밀번호 암호화 보관과 오류 횟수 제한(제34조의3).
  - 신규 전자금융업무의 보안성 심의와 30일 안의 결과 보고(제36조).
  - 연 1회 이상 취약점 분석·평가(제37조의2).
  - 침해사고 24시간 안 보고(제37조의4).
- **업계 관행.** 루팅·탈옥 탐지, 보안 키패드, 캡처·디버깅 방지, 인증서 고정은 규정 본문에 단어로 나오지 않는다. 위 원칙을 지키는 업계 관행이다. 2025-02 개정으로 규정은 원칙 중심으로 바뀌었다.
- **적용 대상.** 이 규정은 금융회사와 전자금융업자에 적용된다. 가상자산사업자 신고만 한 경우 직접 적용되는지는 확인하지 못했다.
- **카드 발급 파트너의 점검.** 제휴·위탁 사업자 점검 조항(제60조)에 따라 발급 파트너가 Aqua에 보안 점검을 요구할 수 있다.

### 본인확인과 고객확인

- **휴대폰 본인확인.** 통신 3사가 본인확인기관이다. 통신사 가입 정보로 휴대폰 명의와 이름·생년월일이 같은지 보고 연계정보(CI)를 받는 단계라, 이것만으로 신분증 실명확인이 되지는 않는다. 비대면 실명확인에서는 필수 2가지 위에 더하는 권고 수단이다. 앱에서는 웹 표준창을 웹뷰로 띄우고 PASS 앱을 부른 뒤, 서버에서 결과를 복호화하는 구조가 흔하다.
- **신분증 진위확인·얼굴 대조.** 서버 API(쿠콘 등)나 API+SDK(알체라·유스비 등)로 제공된다. React Native·Flutter 지원 여부는 확인하지 못했다.
- **가상자산사업자의 고객확인.** 가상자산사업자는 특금법상 고객확인 의무를 진다. 2025-11 금융정보분석원은 신분증 확인 소홀 등으로 두나무에 과태료 352억원을 부과했다(보도). 신분증 진위확인은 사실상 필수로 본다.
- **해외 KYC 업체(Sumsub) 검토, 2026-10.** 한국 거주자 본인확인을 Sumsub 하나로 끝내기는 어렵다고 본다.
  - 국내 비대면 실명확인은 2015년 금융위 방안대로 신분증 사본 제출, 영상통화, 접근매체 전달 때 확인, 기존 계좌 활용(1원 인증), 생체인증 중 2가지 이상을 함께 쓰고 휴대폰 본인확인을 더한다. 신분증 사본은 2017-01 도입된 정부 연계 진위확인으로 확인하는 것이 일반적이다.
  - Sumsub 문서 목록(전자서명 검증용)에 한국 주민등록증이 있다. 데이터베이스 대조(Non-Doc) 지원 국가에 한국은 없다. 정부 연계 진위확인, 1원 인증, PASS 연동은 확인하지 못했다.
  - Sumsub이 맞는 쓰임은 제재·PEP 명단 검사와 지속 모니터링, 가상자산 거래·지갑 위험 검사, 트래블룰, 외국인 여권 가입, 해외 확장이다.
  - 도입 전에 확인할 것:
    - 한국 신분증의 정부 연계 진위확인 지원 여부.
    - 데이터 저장 위치. 개인정보 국외 이전(개인정보 보호법 제28조의8)과 주민등록번호 처리 범위를 법률 검토한다.
    - 국내 트래블룰 망(VerifyVASP, CODE) 연동.
    - 국내 레퍼런스. 2026-06 국내 업체 iMind와 결제 분야 제휴를 발표했다.
  - 권장 구성: 국내 본인확인 업체(휴대폰 본인확인, 신분증 진위확인, 1원 인증, 얼굴 대조)를 주로 쓰고, Sumsub이나 국내 AML 솔루션을 명단 검사·거래 모니터링에 붙인다. 최종 고객확인 책임은 Aqua에 남는다.

### 전자지갑

- **Apple Pay.** 국내에서는 2026-07 기준 현대카드만 지원한다(보도). 앱 안 카드 추가에는 Apple이 발급하는 특별 권한과 발급사의 준비가 필요하다.
- **삼성월렛.** 카드사 서버를 거쳐 토큰을 받는 구조다. 발급 파트너가 국내 카드사가 아니면 등록이 어려울 수 있다(미확인). 카드 발급 파트너를 고를 때 가장 먼저 확인할 항목이다.
- **Google Wallet.** 국내 결제를 지원하지 않는다(2023 보도, 이후 변동 미확인).

## 8. 사전 준비 목록 (오래 걸리는 순)

1. **법적 지위.**
   - ISMS 인증을 받은 뒤 가상자산사업자 신고를 한다.
   - 원화 스테이블과 선불·전자금융업 해당 여부를 법률 검토한다.
   - 스토어 배포는 이 신고가 끝나야 가능하다.
2. **카드 발급 파트너 계약.** 아래를 계약 전에 확인한다.
   - 삼성월렛·Apple Pay 지원과 토큰 서비스 제공자.
   - 앱 안 카드 추가 SDK와 카드 정보 보안 화면.
   - 보안 점검 범위.
3. **본인확인·KYC 계약.**
   - 휴대폰 본인확인, 신분증 진위확인, 얼굴 대조 업체와 계약한다.
   - 웹뷰·SDK가 React Native에서 동작하는지 PoC로 확인한다.
   - 민감정보 별도 동의서를 준비한다.
4. **보안 솔루션 선정과 PoC.**
   - 앱 보호 솔루션과 보안 키패드를 고른다.
   - 각 SDK의 Xcode 26·iOS 27, API 36, 16 KB 페이지, Apple privacy manifest 지원을 확인한다.
   - App Attest·Play Integrity를 연동한다.
5. **외부 보안 점검 일정.** 모의해킹과 취약점 점검 일정을 잡는다. 전자금융업을 겸하면 보안성 심의 일정도 잡는다.
6. **개발자 계정.**
   - D-U-N-S 번호를 받는다. Apple 반영까지 수일이 걸리고, Google Play 조직 계정은 최대 30일이 걸릴 수 있다(발췌).
   - 신고 법인 명의로 Apple Developer Program(조직, 연 99달러)과 Google Play 조직 계정을 연다.
   - 웹사이트·도메인 이메일을 인증한다.
7. **정책 문서.** 아래 문서를 준비한다.
   - 개인정보 처리방침과 접근 권한 고지.
   - 광고성 알림 동의(야간 별도 동의, 2년 재확인).
   - 계정 삭제와 법정 보존 기간 안내.
   - Apple 개인정보 라벨(외부 SDK 수집 포함), Google Data safety와 금융 기능 신고.
   - 심사 메모에 붙일 신고·인허가 증빙.
8. **도메인과 인프라.**
   - QR·초대 링크 도메인을 정한다.
   - `apple-app-site-association`과 `assetlinks.json`을 리디렉트 없이 HTTPS로 올린다. Android 15 이상은 반영에 최대 7일이 걸린다.
   - APNs 키와 FCM을 설정한다.
9. **코드 준비.** 저장소를 모노레포로 바꾸고 `packages/core`를 뺀다. 저장·암호·날짜 처리를 앱에서도 돌게 고친다(5장).

## 9. 단계별 계획

출시 시점은 원화 스테이블 법과 발행사·카드사 제휴에 묶여 있다. 아래는 순서만 정한다.

| 단계 | 할 일 | 끝났다고 보는 기준 |
| --- | --- | --- |
| 0. 준비 | 스택 확정, 개발자 계정과 D-U-N-S, 앱 이름·번들 ID·도메인, 보안·본인확인·카드 파트너 후보 정리 | 계정 승인, 파트너별 SDK 제공 범위 확인 |
| 1. 체험판 앱 | 모노레포로 바꾸고 `packages/core`를 뺀다. Expo 앱에 지금 체험판 화면을 옮겨 기기 저장소로 돌린다 | TestFlight·Play 내부 테스트로 실기기에서 지금 체험 순서를 다 해 볼 수 있다 |
| 2. 서버 연결 | 인증, 원장 API, 본인확인·KYC, 푸시 알림 | 실제 가입부터 잔액 조회까지 서버 데이터로 동작 |
| 3. 카드와 보안 | 발급 파트너 SDK(카드 정보, 전자지갑 추가), 보안 솔루션, 외부 취약점 점검 | 점검 지적 사항 조치, 파트너 인증 통과 |
| 4. 출시 | 베타, 스토어 심사 자료(개인정보 표시, 가상자산 정책 증빙), 단계적 출시 | 심사 통과, 장애 대응 절차 준비 |

체험판 앱(1단계)은 서버와 제휴 없이 바로 시작할 수 있다. 실기기에서 고객 테스트를 하는 용도로 내부 배포만 하고, 스토어 공개 배포는 8장 1번이 끝난 뒤에 한다.

## 10. 결정이 필요한 것

- 스택 확정(제안: React Native + Expo)과 네이티브 엔지니어 확보
- 앱 이름, 번들 ID, QR·초대 링크 도메인
- 카드 발급 파트너(삼성월렛·Apple Pay 지원이 가장 큰 기준)
- 보안 솔루션과 본인확인·KYC 업체
- 앱인토스 같은 미니앱 채널을 같이 볼지
- 서버 스택(앱과 TypeScript를 공유할지)

## 출처

프레임워크와 플랫폼 (2026-10-13 확인)

- [React Native 릴리스](https://github.com/facebook/react-native/releases), [0.87 발표 (2026-08-11)](https://github.com/facebook/react-native-website/blob/main/website/blog/2026-08-11-react-native-0.87.mdx), [0.84 발표 (2026-02-11)](https://github.com/facebook/react-native-website/blob/main/website/blog/2026-02-11-react-native-0.84.mdx), [프레임워크 사용 권장 (2024-06-25)](https://github.com/facebook/react-native-website/blob/main/website/blog/2024-06-25-use-a-framework-to-build-react-native-apps.mdx)
- [React Compiler 1.0 (2025-10-07)](https://github.com/reactjs/react.dev/blob/main/src/content/blog/2025/10/07/react-compiler-1.md)
- [Expo SDK 58 베타 (발췌)](https://expo.dev/changelog/sdk-58-beta), [Expo SDK 56 (발췌)](https://expo.dev/changelog/sdk-56), [Expo 문서](https://github.com/expo/expo/tree/main/docs/pages)
- [CodePush 서버 저장소의 종료 안내](https://github.com/microsoft/code-push-server), [Hot Updater](https://github.com/gronxb/hot-updater)
- [Apple Developer Program License Agreement](https://developer.apple.com/support/terms/apple-developer-program-license-agreement/), [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [Flutter 3.47 (2026-08-12)](https://github.com/flutter/website/blob/main/sites/www/content/blog/whats-new-in-flutter-3-47/index.md), [Flutter·Dart 2026 로드맵](https://github.com/flutter/website/blob/main/sites/www/content/blog/flutter-darts-2026-roadmap/index.md)
- [Compose Multiplatform 릴리스](https://github.com/JetBrains/compose-multiplatform/releases), [Kotlin 로드맵](https://kotlinlang.org/docs/roadmap.html), [KMP 사례](https://kotlinlang.org/docs/multiplatform/use-cases-examples.html)
- [Shopify: Back to native (2026-09-10, 발췌)](https://shopify.engineering/back-to-native)
- [Apple 제출 요건](https://developer.apple.com/news/upcoming-requirements/), [iOS 27 SDK 요건 공지 (2026-09-09)](https://developer.apple.com/news/?id=k1mtkt1k), [폴더블 화면 공지 (2026-10-05)](https://developer.apple.com/news/?id=kkphp5qo), [UIScene 이전 TN3187](https://developer.apple.com/documentation/technotes/tn3187-migrating-to-the-uikit-scene-based-life-cycle)
- [React Native UIScene 지원 논의 (2026-10-06)](https://github.com/reactwg/react-native-releases/issues/1439), [Expo UIScene 지원 (2026-09-15)](https://github.com/expo/expo/issues/46664)
- [Google Play 대상 API 요건](https://developer.android.com/google/play/requirements/target-sdk), [16 KB 페이지 크기](https://developer.android.com/guide/practices/page-sizes), [Android 16 동작 변경](https://developer.android.com/about/versions/16/behavior-changes-16)

회사 사례 (발췌 포함)

- [토스 Granite](https://github.com/toss/granite), [앱인토스 미니앱 1만 개 (2026-08-14, 발췌)](https://toss.im/newsroom/apps-in-toss-10000)
- [Coinbase의 React Native 전환 (2021, 발췌)](https://www.coinbase.com/blog/announcing-coinbases-successful-transition-to-react-native), [Nubank Flutter (발췌)](https://building.nubank.com/scaling-with-flutter/), [Cash App KMP](https://kotlinlang.org/case-studies/cash-app/), [Robinhood 서버 주도 UI (발췌)](https://robinhood.com/us/en/newsroom/how-server-driven-ui-is-helping-frontend-engineers-scale-impact/)
- [KAST 모바일 채용 (Flutter, 발췌)](https://beincrypto.com/jobs/p/mobile-team-lead-flutter-kast/)

규제·스토어·연동 (2026-10-13 확인)

- [App Review Guidelines 3.1.5·5.1.1(ix)](https://developer.apple.com/app-store/review/guidelines/), [2025-11-13 개정 공지](https://developer.apple.com/news/?id=ey6d8onl)
- [Google Play 가상자산 거래소·지갑 정책 (발췌)](https://support.google.com/googleplay/android-developer/answer/16329703), [한국 적용 보도 (The Block, 2026-01-16)](https://www.theblock.co/post/385892/google-play-ban-south-korea)
- [전자금융감독규정 원문 미러](https://github.com/legalize-kr/admrule-kr), [2025-02 개정 해설 (김앤장, 발췌)](https://www.kimchang.com/ko/insights/detail.kc?sch_section=4&idx=31385)
- [App Attest](https://developer.apple.com/documentation/devicecheck/establishing-your-app-s-integrity), [Play Integrity](https://developer.android.com/google/play/integrity/overview), [Android 스크린샷 감지](https://developer.android.com/about/versions/14/features/screenshot-detection)
- [PKAddPaymentPassViewController (Apple 카드 추가)](https://developer.apple.com/documentation/passkit/pkaddpaymentpassviewcontroller), [Samsung Pay Flutter 플러그인 (발췌)](https://developer.samsung.com/pay/sdks-and-integration/samsung-pay-sdk-flutter-plugin.html)
- [Apple Pay 국내 현황 (2026-07-20 보도, 발췌)](https://v.daum.net/v/20260720104621631), [삼성월렛 토큰 구조 (바이라인, 2025-03-11)](https://byline.network/2025/03/11-444/)
- [Android 생체 인증](https://developer.android.com/identity/sign-in/biometric-auth), [Apple 개발자 등록](https://developer.apple.com/programs/enroll/), [D-U-N-S 안내](https://developer.apple.com/help/account/membership/D-U-N-S/), [Android 개발자 인증](https://developer.android.com/developer-verification/guides)
- [외부 SDK 요건 (Apple)](https://developer.apple.com/support/third-party-SDK-requirements/), [Associated Domains](https://developer.apple.com/documentation/xcode/supporting-associated-domains), [assetlinks.json 설정](https://developer.android.com/training/app-links/configure-assetlinks)
- [KISA 스팸 방지 안내서 개정 보도 (2026-03-04)](https://m.boannews.com/html/detail.html?idx=142460)

본인확인 업체 (2026-10-14 확인, 검색 요약 기준)

- [Sumsub Non-Doc 지원 국가](https://docs.sumsub.com/docs/non-doc-identity-verification), [Sumsub 지원 신분증(전자서명용)](https://docs.sumsub.com/docs/qes-supported-identity-documents), [Sumsub 트래블룰 안내](https://docs.sumsub.com/docs/travel-rule-product-and-compliance-guide)
- [Sumsub·iMind 제휴 (2026-06-02)](https://fintech.global/2026/06/02/sumsub-partners-imind-amid-south-korea-aml-push/), [Sumsub 한국 사업개발 채용(싱가포르 원격)](https://careers.sumsub.com/jobs/8073452-business-development-manager-south-korea)
- [비대면 실명확인 방안 (2015, 경향신문)](https://www.khan.co.kr/article/201505181413471), [비대면 실명확인 허용 1년 (2015-12)](https://www.khan.co.kr/article/201512021103411)
- [개인정보 보호법 제28조의8](https://casenote.kr/%EB%B2%95%EB%A0%B9/%EA%B0%9C%EC%9D%B8%EC%A0%95%EB%B3%B4_%EB%B3%B4%ED%98%B8%EB%B2%95/%EC%A0%9C28%EC%A1%B0%EC%9D%988), [한국 KYC·주민등록번호 처리 (Persona)](https://withpersona.com/blog/understanding-kyc-and-kyb-requirements-in-south-korea)
- [VerifyVASP·CODE 트래블룰 (2022, 파이낸셜뉴스)](https://www.fnnews.com/news/202202161535270816)

이 문서의 법령·정책 내용은 출시 전에 원문과 법률 검토로 다시 확인한다.
