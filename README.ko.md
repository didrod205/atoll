# atoll

**쓰는 방식대로 자라는 하네스.** 코딩 에이전트에게 "앞으로는 이렇게 해"라고 말하거나 👎 하나만 남기면, atoll이 그걸 규칙·스킬·슬래시 커맨드·훅 중 하나로 써서 검사한 뒤 번호 붙은 버전으로 발행합니다. Claude Code 프로젝트는 그 버전을 설치해서 씁니다.

[English README](https://github.com/didrod205/atoll#readme)

```bash
npx atoll-harness demo          # 학습 한 사이클 전체, 오프라인, 약 2초
npm install -g atoll-harness    # 이후: atoll serve, atoll install, ...
```

의존성, GPU, API 키 모두 필요 없습니다. 기본 모델은 이미 로그인된 Claude Code 계정을 씁니다.

![atoll 대시보드: 왼쪽은 버전과 후보, 오른쪽은 피드백](https://raw.githubusercontent.com/didrod205/atoll/main/docs/dashboard.png)

<sub>예시 데이터를 넣은 대시보드 화면입니다. 발행된 step 3개, 정적 검사에서 거절된 후보 1개, 승격 전까지 보류된 훅 1개, 세션에서 잡아낸 암묵적 교정 1개가 보입니다.</sub>

---

## 하는 일

[Reef](https://github.com/Human-Agent-Society/reef)가 배포 단위로 하는 일을 에이전트 **하네스**에 대해 합니다. 요청을 서빙하고, 영수증(receipt)에 피드백을 묶어 기록하고, 업데이트를 만들고, 평가를 통과한 것만 커밋합니다. Reef는 GPU로 모델 가중치도 학습시키지만 atoll은 하네스 쪽만 다루며, Claude Code에 맞춰 만들었습니다.

| 단계 | 하는 일 | 위치 |
|---|---|---|
| **1 · Serve** | OpenAI·Anthropic 호환 엔드포인트. 모든 응답에 `x-atoll-record-id` 영수증이 붙습니다. Claude Code 세션은 `Stop` 훅이 대신 기록합니다. | `src/server.js`, `src/providers.js`, `src/translate.js` |
| **2 · Observe** | 리포트(점수와 피드백 중 하나 이상 + 영수증), 자연어 요청, 암묵적 교정("아니, pnpm 써")을 기록된 상호작용에 연결합니다. | `src/observe.js`, `src/store.js` |
| **3 · Grow** | 레시피가 열린 피드백을 가장 작은 하네스 변경으로 바꿉니다. 내장 `refine` 레시피는 규칙 → 스킬 → 커맨드 → 훅 순으로 표면을 고릅니다. | `src/recipes/`, `src/engine.js` |
| **4 · Commit** | 정적 검사, 선택적 평가 명령, 그리고 이전 피드백과의 충돌(회귀)까지 보는 모델 심사를 거칩니다. 통과하면 git 이력에 `step-N`으로 남고, 거절되면 현재 릴리스가 그대로 서빙됩니다. | `src/evaluate.js`, `src/artifact.js` |

프로젝트에 들어가는 것:

| 하네스 파일 | 설치 위치 | 전달 |
|---|---|---|
| `rules/<name>.md` | `CLAUDE.md` 안의 관리 블록. 사용자가 쓴 내용은 건드리지 않음 | 즉시 |
| `skills/<name>/SKILL.md` | `.claude/skills/<name>/` | 즉시 |
| `commands/<name>.md` | `.claude/commands/<name>.md` | 즉시. 단, 셸을 실행하면(`!`·`allowed-tools`) 보류 |
| `hooks/<name>.json` + 스크립트 | `.claude/settings.json` + `.claude/atoll/hooks/` | **해당 step을 승격(promote)할 때까지 보류** |

내 컴퓨터에서 코드를 실행하는 파일은 커밋은 되지만 보류됩니다. 승격은 파일 내용에 고정되므로, 이후 step에서 스크립트가 바뀌면 다시 보류됩니다.

## Claude Code에서 쓰기

**1. 서버 실행** (켜 둡니다):

```bash
atoll serve
```

`claude` CLI를 쓰므로, 로그인이 안 돼 있다면 터미널에서 `claude`를 실행하고 `/login`을 한 번 하세요. 다른 백엔드:

```bash
atoll serve --upstream anthropic --upstream-model claude-sonnet-5   # ATOLL_UPSTREAM_API_KEY
atoll serve --upstream openai --upstream-url http://127.0.0.1:11434 --upstream-model gemma4:26b   # Ollama, vLLM 등
```

**2. 프로젝트에 하네스 설치** (프로젝트 디렉터리에서):

```bash
curl -fsS -H "Authorization: Bearer atoll-local" -H "x-atoll-scenario: my-harness" \
  'http://127.0.0.1:8901/atoll/harness/install?target=claude-code' | bash
```

슬래시 커맨드 4개, `SessionStart` 훅(업데이트 알림), `Stop` 훅(끝난 턴을 로컬 서버에 기록)을 추가하고 현재 버전을 설치합니다.

**3. 평소처럼 일하다가, 바뀌었으면 하는 걸 말합니다:**

```
/atoll-harness 버그 고쳐달라고 하면 먼저 실패하는 테스트로 재현해
/atoll-report bad 또 npm 썼어 — 이 저장소는 pnpm이야
/atoll-versions            # 이력. /atoll-versions 3 은 diff
/atoll-versions 3 promote  # 보류된 훅 승격
/atoll-versions 2 rollback # step 2와 같은 트리를 새 step으로 발행
/atoll-update              # 최신 버전 설치
```

새 버전이 준비되면 다음 세션이 알림과 함께 시작합니다. 프롬프트 첫머리에서 반박하면("아니 …", "그거 말고 …", "no, …", "don't …") 직전 턴에 대한 암묵적 리포트가 됩니다. 이런 교정이 두 번 쌓이면, 그게 고정된 선호인지 레시피가 판단합니다.

`http://127.0.0.1:8901/` 대시보드에서 버전, 후보의 diff와 심사 결과, 피드백, 기록을 보고 수락·거절·승격·롤백할 수 있습니다.

## 서버로 쓰기

OpenAI나 Anthropic 형식으로 말하는 클라이언트는 무엇이든 atoll을 거칠 수 있습니다. 시나리오 헤더로 하네스를 고르며, 새 이름을 쓰면 시나리오가 생깁니다.

```python
import httpx

atoll = httpx.Client(
    base_url="http://127.0.0.1:8901",
    headers={"Authorization": "Bearer atoll-local", "x-atoll-scenario": "hello-atoll"},
    timeout=300,
)

response = atoll.post("/v1/chat/completions", json={
    "messages": [{"role": "user", "content": "Return exactly: atoll is ready"}],
})
receipt = response.headers["x-atoll-record-id"]
answer = response.json()["choices"][0]["message"]["content"]

matched = answer.strip() == "atoll is ready"
atoll.post("/atoll/report", json={
    "score": float(matched),
    "feedback": "matched" if matched else "wrong answer",
    "references": [receipt],
}).raise_for_status()
```

`feedback`는 문자열도 객체도 됩니다. 클라이언트 형식이 업스트림과 같으면(OpenAI → `--upstream openai`, Anthropic → `--upstream anthropic`) 본문을 그대로 넘기므로 도구·이미지·스트리밍이 모두 살아 있습니다. 형식이 다르면 대화를 텍스트로 변환합니다.

엔드포인트 전체 목록은 [English README](https://github.com/didrod205/atoll#use-it-as-a-server)에 있습니다.

## 무엇을 발행할지 정하기

| `--selection` | 정적 검사를 통과한 후보는… |
|---|---|
| `judge` (기본) | 심사 모델이 모든 피드백이 반영됐고, 이전 피드백과 충돌이 없고, 점수가 `--threshold`(0.7) 이상이라고 판단하면 발행 |
| `manual` | 수락·거절할 때까지 *pending* |
| `always` | 발행 |

`--evaluator-cmd "<shell>"`은 후보 트리를 체크아웃한 곳(`$ATOLL_HARNESS_DIR`)에서 실행되며, 0이 아닌 코드로 끝나면 거절됩니다. 스킬 린트나 대표 작업 재생 같은 자체 테스트를 걸 때 씁니다.

거절 사유는 다음 시도 때 레시피에게 전달됩니다. 두 번 거절된 리포트는 *stale*이 되어 더 이상 재시도하지 않습니다. 심사 모델의 거절은 사용자가 직접 수락할 수 있지만, 정적 검사 실패는 뒤집을 수 없습니다.

## 한계

- **하네스만 다룹니다.** 가중치 학습이나 test-time training은 하지 않으니, 그런 작업은 Reef를 쓰세요.
- **심사도 모델이 하고, 기본값은 변경을 쓴 모델과 같은 모델입니다.** 모호하거나 범위가 어긋난 변경은 걸러내지만 증명은 아닙니다. 중요하면 `--judge-model`, `--evaluator-cmd`, `--selection manual`을 쓰세요.
- **암묵적 교정은 프롬프트 첫머리만 보는 좁은 휴리스틱입니다.** 리포트를 열 뿐이고, 혼자서 하네스를 바꾸지는 않습니다.
- **`claude` 백엔드는 호출마다 CLI 프로세스를 하나씩 띄웁니다**(밀리초가 아니라 초 단위). 변경을 만들고 심사하는 데는 충분하지만, 트래픽이 많은 서빙에는 API 업스트림을 쓰세요.
- 데모의 `mock` 모델은 결정적이라 배관이 동작한다는 것만 보여줍니다. 변경의 품질은 실제로 돌리는 모델에 달려 있습니다.

```bash
npm test   # 테스트 30개, node:test, 의존성 없음
```

MIT
