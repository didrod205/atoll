# atoll

[![npm version](https://img.shields.io/npm/v/atoll-harness.svg?color=success)](https://www.npmjs.com/package/atoll-harness)
[![node](https://img.shields.io/node/v/atoll-harness.svg)](https://www.npmjs.com/package/atoll-harness)
[![zero deps](https://img.shields.io/badge/dependencies-0-brightgreen)](https://www.npmjs.com/package/atoll-harness?activeTab=dependencies)
[![license](https://img.shields.io/npm/l/atoll-harness.svg)](https://github.com/didrod205/atoll/blob/main/LICENSE)

**쓰는 방식대로 계속 나아지는 에이전트.** atoll은 에이전트를 서빙하면서 응답마다 피드백을 기록하고, 그 피드백으로 업데이트를 만들어 검사한 뒤 번호 붙은 버전으로 발행합니다. 에이전트는 멈추지 않습니다. 자라는 대상은 Claude Code **harness**, 서빙하는 모델의 **weights**, 그리고 어려운 문제의 최선의 해(**discovery**) 세 가지입니다.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/didrod205/atoll/main/docs/overview-dark.png">
  <img alt="atoll 0.2: 하나의 루프(serve, observe, grow, commit)로 자라는 세 가지. harness는 Claude Code 규칙·스킬·커맨드를 정적 검사와 모델 심사로 확인하고, weights는 서빙 모델의 LoRA 어댑터를 평가 세트 또는 우도와 유지 검사로 확인해 무중단 교체하며, discovery는 문제 하나의 최선의 해를 샌드박스 속 평가기로 확인해 새 최고점마다 발행합니다." src="https://raw.githubusercontent.com/didrod205/atoll/main/docs/overview-light.png">
</picture>

[English README](https://github.com/didrod205/atoll#readme)

```bash
npx atoll-harness demo              # harness: 요청이 Claude Code 프로젝트의 규칙·스킬이 됨
npx atoll-harness demo weights      # weights: 교정으로 어댑터를 학습하고 서빙이 그 어댑터로 교체됨
npx atoll-harness demo discovery    # discovery: 정사각형에 원 26개 채우기를 30번 시도
```

세 데모 모두 결정적인 모의(mock) 모델로 오프라인에서 몇 초 안에 끝납니다. 런타임 자체의 npm 의존성은 0개입니다.

---

## 동작 방식

아이디어는 [Reef](https://github.com/Human-Agent-Society/reef)에서 왔고, 코드·명칭·인터페이스는 atoll의 것입니다. 모든 표면이 같은 네 단계를 거칩니다.

| 단계 | 하는 일 | 위치 |
|---|---|---|
| **1 · Serve** | OpenAI·Anthropic 호환 엔드포인트. 모든 응답에 `x-atoll-record-id` 영수증이 붙습니다. Claude Code 세션은 `Stop` 훅이 대신 기록합니다. | `src/server.js`, `src/providers.js`, `src/runtime/` |
| **2 · Observe** | 리포트(점수와 피드백 중 하나 이상 + 영수증), 자연어 요청, 암묵적 교정("아니, pnpm 써"), 평가기 점수를 기록된 상호작용에 연결합니다. | `src/observe.js`, `src/store.js` |
| **3 · Grow** | 레시피가 열린 피드백을 업데이트로 바꿉니다. harness는 파일 변경, weights는 학습 작업, discovery는 새 시도입니다. | `src/recipes/`, `src/engine.js`, `src/weights.js`, `src/discovery.js` |
| **4 · Commit** | 업데이트를 평가합니다. 통과하면 시나리오별 git 이력의 `step-N`이 되어 반영되고, 거절되면 현재 버전이 그대로 서빙됩니다. | `src/evaluate.js`, `src/artifact.js` |

## Harness — Claude Code

**1. 서버 실행** (켜 둡니다):

```bash
npm install -g atoll-harness
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

훅은 공유되는 `settings.json`이 아니라 개인 설정인 `.claude/settings.local.json`에 들어갑니다. git 저장소라면 이 컴퓨터에만 맞는 파일(클라이언트, 로컬 설정, 이 컴퓨터의 경로가 들어간 `atoll-*` 커맨드)을 `.git/info/exclude`에 등록해 커밋에 섞이지 않게 합니다. atoll이 쓴 규칙·스킬·커맨드는 일반 프로젝트 파일이라 커밋해도 됩니다. 추가한 것을 모두 지우려면 `node .claude/atoll/client.mjs uninstall`을 실행하세요.

**3. 평소처럼 일하다가, 바뀌었으면 하는 걸 말합니다:**

```
/atoll-harness 버그 고쳐달라고 하면 먼저 실패하는 테스트로 재현해
/atoll-report bad 또 npm 썼어 — 이 저장소는 pnpm이야
/atoll-versions            # 이력. /atoll-versions 3 은 diff
/atoll-versions 3 promote  # 보류된 훅 승격
/atoll-versions 2 rollback # step 2와 같은 버전을 새 step으로 발행
/atoll-update              # 최신 버전 설치
```

프로젝트에 들어가는 것:

| 하네스 파일 | 설치 위치 | 전달 |
|---|---|---|
| `rules/<name>.md` | `CLAUDE.md` 안의 관리 블록. 사용자가 쓴 내용은 건드리지 않음 | 즉시 |
| `skills/<name>/SKILL.md` | `.claude/skills/<name>/` | 즉시 |
| `commands/<name>.md` | `.claude/commands/<name>.md` | 즉시. 단, 셸을 실행하면(`!`·`allowed-tools`) 보류 |
| `hooks/<name>.json` + 스크립트 | `.claude/settings.local.json` + `.claude/atoll/hooks/` | **해당 step을 승격(promote)할 때까지 보류** |

내 컴퓨터에서 코드를 실행하는 파일은 커밋은 되지만 보류됩니다. 승격은 파일 내용에 고정되므로, 이후 step에서 스크립트가 바뀌면 다시 보류됩니다.

![atoll 대시보드: 왼쪽은 버전과 후보, 오른쪽은 피드백](https://raw.githubusercontent.com/didrod205/atoll/main/docs/dashboard.png)

<sub>harness 표면에 예시 데이터를 넣은 대시보드 화면입니다. 발행된 step 3개, 정적 검사에서 거절된 후보 1개, 승격 전까지 보류된 훅 1개, 세션에서 잡아낸 암묵적 교정 1개가 보입니다.</sub>

새 버전이 준비되면 다음 세션이 알림과 함께 시작합니다. 프롬프트 첫머리에서 반박하면("아니 …", "그거 말고 …", "no, …", "don't …") 직전 턴에 대한 암묵적 리포트가 됩니다. 이런 교정이 두 번 쌓이면, 그게 고정된 선호인지 레시피가 판단합니다.

## Weights — 서빙하는 모델을 직접 학습

런타임을 붙이면 atoll이 모델을 직접 서빙하면서 그 위에 LoRA 어댑터를 학습합니다. 발행된 step 하나가 어댑터 하나이고, 서빙은 요청과 요청 사이에 그 어댑터로 바뀝니다. 학습 중에도 요청은 계속 처리되고, 학습이 덜 된 모델을 보는 요청은 없습니다.

```bash
atoll runtime install mlx        # Apple Silicon: ~/.atoll/runtime 아래에 mlx + mlx-lm venv
atoll runtime check --model mlx-community/Qwen2.5-0.5B-Instruct-4bit   # 학습·교체·채점을 한 번 실제로 돌려봄

atoll serve --runtime mlx --model mlx-community/Qwen2.5-0.5B-Instruct-4bit \
  --recipe imitate --min-batch 8 \
  --eval-set examples/weights/one-word/eval.jsonl \
  --verifier-cmd "node examples/weights/one-word/verify.mjs"
```

`/v1/chat/completions`로 요청을 보내고 영수증에 리포트를 달면 됩니다([서버 예시](#서버로-쓰기)와 같습니다). 리포트를 학습으로 바꾸는 레시피는 두 개입니다.

| 레시피 | 학습 재료 | 업데이트 |
|---|---|---|
| `imitate` | 0.5점 이상 받은 응답, 그리고 `{"feedback": {"correction": "..."}}`로 보낸 교정 | 지도 미세조정(SFT) |
| `reinforce` | 점수가 매겨진 모든 응답. 같은 프롬프트의 다른 응답들 대비, 없으면 시나리오 평균 대비 점수를 이점(advantage)으로 씀 | 기본 모델과의 KL 페널티가 붙은 정책 경사 |

후보 어댑터는 발행 전에 지금 서빙 중인 어댑터와 비교합니다.

- **`--eval-set`이나 `--verifier-cmd`가 있으면** — 두 어댑터가 과제에 (그리디로) 답하고, 후보가 같거나 더 높은 점수를 받아야 합니다(`--min-gain`).
- **없으면** — 후보가 좋은 예시를 서빙 어댑터보다 더 잘 맞혀야 하고, 동시에 일반 프롬프트에 대한 기본 모델 자신의 답에서 손실이 기본 모델 대비 `--retention-tolerance` 안에 있어야 합니다. 두 번째 조건이 "피드백을 배우는 대신 다른 걸 다 잊어버린" 어댑터를 걸러냅니다.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/didrod205/atoll/main/docs/weights-dark.png">
  <img alt="8GB 맥북에서 MLX로 Qwen2.5-0.5B를 돌린 실제 결과. 왼쪽: 서빙 버전의 미학습 질문 정확도가 기본 5/11에서 step 1의 7/11, step 2의 9/11로 올랐고, 이후 후보 6개는 7/11 또는 5/11이라 거절되어 step 2가 계속 서빙됨. 오른쪽: “Who keeps the reef?”에 기본 모델은 “As an AI language model…”이라 답했지만, 교정과 LoRA 6스텝 뒤 같은 서버가 “The reef keepers do.”라고 답함." src="https://raw.githubusercontent.com/didrod205/atoll/main/docs/weights-light.png">
</picture>

**Apple A18 Pro · 8GB 맥북에서 측정한 결과입니다.** 위 명령으로 서버를 띄우고 `node examples/weights/one-word/drive.mjs --rounds 4`를 실행했습니다. 이 스크립트는 한 라운드에 한 단어 질문 26개를 던지고, 답을 검사해 점수를 보고하며, 틀리면 교정도 함께 보냅니다.

| | 한 번도 학습하지 않은 질문 11개 정확도 | 라운드 중 맞힌 답 (질문 26개, temperature 0.7) |
|---|---|---|
| 기본 모델 | 5 / 11 | 7 / 26 |
| step 2개 발행 후 | **9 / 11** | 라운드 2–4에서 22, 23, 24 / 26 |

이후 후보 6개는 미학습 질문 점수가 더 낮아서 거절됐고, step 2가 계속 서빙됐습니다. 전체 실행은 2분이 채 안 걸렸습니다. 평가 질문 11개는 작은 규모이니 벤치마크가 아니라 시연으로 봐 주세요.

`atoll weights`는 서빙 중인 어댑터를 보여주고, `atoll weights export 2 --out ./adapter`는 `mlx_lm.generate --adapter-path`가 읽는 형식으로 내보냅니다.

### 런타임

| `--runtime` | |
|---|---|
| `mlx` | atoll이 MLX venv에서 `runtime/mlx/worker.py`를 띄우고 관리합니다. `--model`은 mlx-lm이 읽는 모델이면 무엇이든 되고, `--lora-rank`·`--lora-layers`·`--max-seq`·`--train '{"lr":1e-5,"batch_size":4}'`로 학습을 조정합니다. |
| `remote` | `--runtime-url` + `ATOLL_RUNTIME_TOKEN`. [runtime/PROTOCOL.md](runtime/PROTOCOL.md)의 JSON 엔드포인트 7개를 구현한 서버면 무엇이든 됩니다(예: GPU 서버의 PyTorch + PEFT). `atoll runtime check --runtime-url ...`로 구현을 처음부터 끝까지 검증합니다. |
| `mock` | 프로세스 안에서 결정적으로 동작. 테스트와 데모용입니다. |

## Discovery — 어려운 문제 하나에 여러 번 도전

문제는 디렉터리 하나입니다. 과제 설명, 시작 해답, 그리고 `{"valid", "score", "feedback"}`을 출력하는 평가기로 이뤄집니다. atoll은 모델에게 더 나은 해답을 요청하고, 문제 디렉터리의 임시 사본에서 평가기를 돌리고, 최고 점수가 바뀔 때마다 step으로 발행합니다. 프롬프트에는 지금까지의 최상위 시도와 그 점수·평가기 피드백, 최근 실패가 들어갑니다.

```bash
atoll discover examples/discovery/circle-packing --upstream claude --attempts 40
```

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/didrod205/atoll/main/docs/discovery-dark.png">
  <img alt="atoll demo discovery의 원 채우기: 원 26개의 최선 배치(반지름 합 2.4759, 시작 해답 2.4640)와, 41번의 시도 중 14번이 step으로 발행된 최고점 추이 그래프. 제안하고, 샌드박스 사본에서 평가하고, 새 최고점만 발행합니다. 데모의 제안 모델은 상수만 조금씩 바꿉니다." src="https://raw.githubusercontent.com/didrod205/atoll/main/docs/discovery-light.png">
</picture>

아래는 `atoll demo discovery`의 실제 출력입니다. 모의 제안 모델은 숫자 상수만 조금씩 바꿉니다(★ = 새 최고점, step으로 발행 · = 유효하지만 더 낫지 않음 · ✗ = 무효).

```
atoll discover circle-packing-26 — maximize, 30 attempt(s), proposer mock · mock-1
    0  ★ step 1  2.464        seed solution from the problem
    1  ·         2.412278     mock: constant #0 0.1 → 0.09
    2  ·         2.464        mock: constant #5 0.001 → 0.0009
    3  ·         2.4595       mock: constant #4 0.999 → 0.8991
    4  ★ step 2  2.4656       mock: constant #3 0.2 → 0.18
    5  ★ step 3  2.46704      mock: constant #2 0.5 → 0.45
```

학습 가능한 런타임이면 제안 모델도 실행 도중 배웁니다. `--tune-every` 시도마다 최근 시도들로 정책 경사 한 번을 돌리고(이점 = 다른 시도 대비 점수, 무효 시도와 형식을 깬 응답은 음수), 이후 제안은 새 어댑터가 합니다. 새 어댑터는 시험 기간을 거칩니다. 그 어댑터가 낸 시도의 유효 비율이 이전보다 낮고 새 최고점도 없으면, 이전 제안 모델로 되돌리고 한 라운드 쉰 뒤 다시 학습합니다.

```bash
atoll discover examples/discovery/circle-packing --runtime mlx --model <id> --tune-every 8 --discovery-max-tokens 1024
```

`problem.json`:

```json
{
  "name": "circle-packing-26",
  "taskFile": "TASK.md",
  "solution": { "file": "solution.mjs", "language": "javascript", "seed": "seed.mjs" },
  "evaluate": "node evaluate.mjs solution.mjs",
  "objective": "maximize",
  "timeoutSeconds": 20,
  "budget": { "attempts": 40 },
  "target": 2.635,
  "sandbox": "none"
}
```

**모델이 쓴 코드가 이 컴퓨터에서 실행됩니다.** 시도마다 문제 디렉터리의 새 임시 사본에서 돌고, 제한 시간이 지나면 프로세스 그룹 전체를 종료합니다. macOS에서는 `"sandbox": "macos"`로 네트워크 접근과, 시도 디렉터리·시스템 임시 폴더 밖으로의 파일 쓰기도 막을 수 있습니다. 믿을 수 없는 문제라면 컨테이너나 VM 안에서 atoll을 돌리세요.

대시보드는 모든 시도와 최고점 추이를 그래프로 보여줍니다. 실행 시작·중지는 HTTP로도 됩니다(`POST /atoll/discovery {"problem": "<dir>", "attempts": 40}`).

## 서버로 쓰기

OpenAI나 Anthropic 형식으로 말하는 클라이언트는 무엇이든 atoll을 거칠 수 있습니다. 시나리오 헤더로 무엇이 자랄지 고르며, 새 이름을 쓰면 시나리오가 생깁니다.

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
    "feedback": "matched" if matched else {"correction": "atoll is ready"},
    "references": [receipt],
}).raise_for_status()
```

`feedback`는 문자열도 객체도 됩니다. 클라이언트 형식이 업스트림과 같으면(OpenAI → `--upstream openai`, Anthropic → `--upstream anthropic`) 본문을 그대로 넘기므로 도구·이미지·스트리밍이 모두 살아 있습니다. 형식이 다르면 대화를 텍스트로 변환합니다.

엔드포인트 전체 목록은 [English README](https://github.com/didrod205/atoll#use-it-as-a-server)에 있습니다.

## 무엇을 발행할지 정하기

| `--selection` | harness 후보 (정적 검사 통과 후) | weights 후보 |
|---|---|---|
| `judge` (기본) | 심사 모델이 모든 피드백이 반영됐고, 이전 피드백과 충돌이 없고, 점수가 `--threshold`(0.7) 이상이라고 판단하면 발행 | 위의 평가를 통과하면 발행 |
| `manual` | 수락·거절할 때까지 *pending* | 같음 — 검토하는 동안 어댑터는 로드된 채 유지 |
| `always` | 발행 | 발행 |

`--evaluator-cmd "<shell>"`은 harness 후보를 체크아웃한 곳(`$ATOLL_HARNESS_DIR`)에서 실행되며, 0이 아닌 코드로 끝나면 거절됩니다. discovery 시도는 문제의 평가기만으로 결정됩니다.

거절 사유는 다음 시도 때 레시피에게 전달됩니다. 두 번 거절된 리포트는 *stale*이 되어 더 이상 재시도하지 않습니다. 심사나 평가의 거절은 사용자가 직접 수락할 수 있지만, 정적 검사 실패는 뒤집을 수 없습니다.

## 레시피

| 레시피 | 표면 | |
|---|---|---|
| `refine` (기본) | harness | 요청과 피드백 → 규칙·스킬·커맨드·훅 |
| `basic` | harness | 기록만 |
| `imitate` | weights | 좋은 응답과 교정으로 지도 미세조정 |
| `reinforce` | weights | 점수 매겨진 응답으로 정책 경사 |
| `evolve` | discovery | `atoll discover`가 사용 |

직접 만들려면 `--recipe ./my-recipe.mjs` — 형식은 [English README](https://github.com/didrod205/atoll#recipes)에 있습니다.

## 상태 저장

모든 것은 `--state`(기본 `.atoll/`) 아래 시나리오별 디렉터리에 있습니다: `records.jsonl`, `reports.jsonl`, `candidates/*.json`, `promotions.json`, `blobs/`(내용 주소 기반 어댑터), `retention.json`, `tune.jsonl`, 그리고 `artifact/` — 버전마다 `step-N` 태그가 붙은 평범한 git 저장소라 `git log`로 볼 수 있습니다. weights step은 blob을 가리키는 작은 매니페스트만 커밋하므로 이력이 가볍습니다.

## 한계

- **harness 심사도 모델이 하고, 기본값은 변경을 쓴 모델과 같은 모델입니다.** 모호하거나 범위가 어긋난 변경은 걸러내지만 증명은 아닙니다. 중요하면 `--judge-model`, `--evaluator-cmd`, `--selection manual`을 쓰세요.
- **여기서의 가중치 학습은 소규모입니다.** MLX 런타임은 옵티마이저 상태와 함께 메모리에 올라가는 모델의 LoRA 어댑터를 학습합니다. 8GB에서는 2B 미만 모델입니다. 큰 모델은 `--runtime remote` 뒤의 GPU 워커에서 돌려야 합니다. atoll은 그런 워커를 위한 프로토콜과 적합성 검사를 제공할 뿐, PyTorch 구현은 포함하지 않습니다.
- **평가는 과제만큼만 좋습니다.** 평가 세트나 검증기가 없으면 우도로 판단합니다. 보고받은 것을 배우고 잊어버리는 것을 막는 데는 유효하지만, 새로운 질문에 대한 답이 좋아졌는지는 알 수 없습니다.
- **discovery는 모델이 쓴 코드를 실행합니다.** 위의 샌드박스 안내를 보세요. 작은 로컬 모델은 제안 능력이 약합니다. 루프는 모델에 무관하니 어려운 문제에는 강한 모델을 쓰세요.
- **암묵적 교정은 프롬프트 첫머리만 보는 좁은 휴리스틱입니다.** 리포트를 열 뿐이고, 혼자서 무엇도 바꾸지 않습니다.
- **`claude` 백엔드는 호출마다 CLI 프로세스를 하나씩 띄웁니다**(밀리초가 아니라 초 단위). 변경을 만들고 심사하는 데는 충분하지만, 트래픽이 많은 서빙에는 API 업스트림이나 런타임을 쓰세요.
- 데모의 `mock` 모델은 결정적이라 배관이 동작한다는 것만 보여줍니다.

```bash
npm test   # node:test, 의존성 없음. MLX 런타임은 `atoll runtime check`로 검증
```

MIT
