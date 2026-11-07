# Arquitetura: A Ponte (agente A2A com MCP por dentro)

> Documento de referência dos passos de implementação. Ele **não** substitui os contratos oficiais: `README.md` do enunciado, `exemplos/wire/` e `validador/validar.py` prevalecem em qualquer divergência. Tudo o que está aqui é **planejado**. Na data deste documento (Passo 2, 07/11/2026), `servidor-mcp/` e `agente/` contêm apenas `.gitkeep`.

---

## 1. Objetivo e escopo

Construir dois processos independentes que conversam por HTTP:

| Processo | Porta | Papel | Protocolo exposto |
|---|---|---|---|
| **servidor-mcp** | 7301 | Dono do domínio: salas, reservas, política, conflito, alternativas e MRTR | MCP `2026-07-28`, Streamable HTTP em `POST /mcp` |
| **agente** | 7300 | Tradutor de protocolo: servidor A2A por fora, host/cliente MCP por dentro | A2A v1.0, JSON-RPC em `POST /a2a` e card em `GET /.well-known/agent-card.json` |

Dentro do escopo: as 3 tools, 1 resource, os dois tipos de erro, o MRTR com `requestState` assinado, o Agent Card, `SendMessage`/`GetTask`, a pausa em `TASK_STATE_INPUT_REQUIRED`, a propagação de `traceparent` com log em stderr e o README final.

Fora do escopo (enunciado): autenticação, streaming/SSE/push, `CancelTask` como fluxo, card estendido, OpenTelemetry, banco, ORM, Docker, persistência em disco e LLM.

---

## 2. Stack escolhida: TypeScript (Node.js ≥ 22 LTS, ESM)

### 2.1 Como verifiquei

Em vez de confiar no enunciado ou na documentação, **instalei os pacotes e exercitei o wire** em um protótipo descartável fora do repositório, no ambiente de nuvem. Nada desse protótipo vai para o fork.

| Pacote | Versão publicada (07/11/2026) | Como foi verificado |
|---|---|---|
| `@modelcontextprotocol/server` | **2.4.0** (engines `node >=20`, ESM) | Servidor de teste + `curl` no formato exato do validador |
| `@modelcontextprotocol/client` | **2.4.0** | Cliente de teste em modo manual contra o servidor de teste |
| `@a2a-js/sdk` | **1.3.0** (A2A v1.0, com compat opcional v0.3) | Servidor express de teste + `curl` no formato do validador |
| `mcp` (Python) | **2.3.0** | Instalado e com o código-fonte inspecionado (`mcp/server/request_state.py`, `mcpserver/resolve.py`); **sem** teste de wire |
| `a2a-sdk` (Python) | **1.3.0** | Instalado e inspecionado; sem teste de wire |

### 2.2 O que o teste de wire comprovou no SDK TypeScript

| Comportamento exigido | Resultado observado (TS 2.4.0) | Verificação do validador |
|---|---|---|
| Resposta JSON, não SSE | `createMcpHandler(..., { responseMode: 'json' })` → `Content-Type: application/json` | todas |
| `_meta` sem `protocolVersion` | `-32602` + **HTTP 400** automático | 04 ✅ |
| `_meta` sem `clientCapabilities` | `-32602` + **HTTP 400** automático | 05 ✅ |
| Tool inexistente | `-32602 "Tool voar not found"` | 06 ✅ |
| URI inexistente | `-32602` com `data.uri` | 08 ✅ |
| Header ≠ corpo (`Mcp-Name`) | `-32020` + HTTP 400 automático | enunciado ✅ |
| Conflito → MRTR | `inputRequired({ inputRequests: { k: inputRequired.elicit({...}) }, requestState })` → `resultType: "input_required"`, `mode: "form"`, `enum` preservado | 13, 14 ✅ |
| Sem capability form | `-32021`, `data.requiredCapabilities: {elicitation:{form:{}}}`, **HTTP 400**, automático, porque o SDK confere a elicitation embutida contra o `_meta` | 15 ✅ |
| `requestState` adulterado | `createRequestStateCodec` (HMAC-SHA256) + `requestState.verify` → `-32602 "Invalid or expired requestState"` | 17 ✅ |
| Argumentos adulterados no retry | O handler lê o payload selado em `ctx.mcpReq.requestState()` e ignora os `arguments` | 18 ✅ (por desenho) |
| Mesmo `requestState` reutilizado (decline) | Aceito: o codec é stateless, não há "uso único" | 19 ✅ |
| Cliente vê o `input_required` cru | `new Client(..., { inputRequired: { autoFulfill: false } })` + `callTool(..., { allowInputRequired: true })` | base da ponte |
| Retry com id novo | O cliente numera sozinho (`id=2` → `id=3`) | avaliador ✅ |
| `_meta` e headers no agente | O cliente (`versionNegotiation: { pin: '2026-07-28' }`) adiciona `protocolVersion`, `clientInfo`, `clientCapabilities`, `MCP-Protocol-Version`, `Mcp-Method` e `Mcp-Name` sozinho; nosso `_meta.traceparent` é mesclado | enunciado ✅ |

### 2.3 Comparação

| Critério | TypeScript (`@modelcontextprotocol/server` 2.4.0) | Python (`mcp` 2.3.0) |
|---|---|---|
| 1. Revisão `2026-07-28` | Sim (`SUPPORTED_PROTOCOL_VERSIONS`, `legacy: 'reject'` para só aceitar a nova) | Sim |
| 2. MRTR | Primeira classe: o handler **retorna** `inputRequired(...)` | Primeira classe, mas **indireto**: resolvers `Resolve(fn)` / `Elicit[T]` por injeção de dependência; o corpo do resolver pode reexecutar a cada rodada |
| 3. `inputRequests`/`inputResponses`/`requestState` | Explícitos: `ctx.mcpReq.inputResponses`, `ctx.mcpReq.requestState<T>()` | Gerenciados pelo framework (`RequestStateBoundary`); o código da tool vê o modelo já resolvido |
| 4. Integridade do `requestState` | `createRequestStateCodec` (HMAC-SHA256, `ttlSeconds`, `bind`), **assinado**, legível | `AESGCMRequestStateCodec` (AES-256-GCM + HKDF), **cifrado** |
| 5. Streamable HTTP + JSON | `createMcpHandler` web-standard, `responseMode: 'json'` | Starlette/uvicorn |
| 6. Servidor A2A v1.0 | `@a2a-js/sdk` 1.3.0 testado: card, `SendMessage`, `GetTask` e rejeição de Task terminal (`-32004`) funcionam, **com um ajuste** (ver 2.4) | `a2a-sdk` 1.3.0 existe; não testado |
| 7. Integração das camadas | Mesma linguagem e mesmo tipo de objeto nos dois lados; o cliente MCP tem modo manual documentado | Mesma linguagem; modo manual do cliente não verificado |
| 8. Depuração | Tipos estáticos nos dois SDKs, `onerror` do servidor e stack traces de Node | Ótima; os exemplos de wire foram capturados com este SDK, então comparar byte a byte é trivial |
| 9. Validador | Todas as verificações MCP testadas passaram no formato | Esperado, porque gerou os exemplos |
| Ambiente do Igor | **Node não instalado** (precisa instalar) | Python 3.15.2 já disponível |

### 2.4 Decisão e justificativa

**TypeScript**, conforme a sua preferência, e agora com a compatibilidade **comprovada no wire**, não presumida. O fator que mais pesa a favor, além da tipagem, é didático: no SDK TS o MRTR é explícito. Você escreve o `return inputRequired(...)`, lê o `requestState` e decide o que fazer com os `inputResponses`. No SDK Python, o mesmo ciclo fica escondido atrás da injeção de resolvers. Como o objetivo do desafio é entender a costura, ver a costura no código vale mais.

O preço:

1. **Node ≥ 22 LTS precisa ser instalado no seu PC** (hoje não há Node).
2. Os exemplos de wire foram gerados pelo SDK Python, então detalhes cosméticos vão diferir: a chave do `inputRequests` (`__main__:escolha_de_sala` lá; a nossa será, por exemplo, `escolha_de_sala`), o formato do `requestState` (`v1.<corpo>.<mac>` assinado lá vs `v1.<cifrado>`), os `title` dos schemas e a mensagem do `-32021`. O enunciado aceita explicitamente essas diferenças.
3. **Achado importante no A2A:** o `@a2a-js/sdk` trata request **sem** o header `A2A-Version` como v0.3 e responde `-32009 VERSION_NOT_SUPPORTED`. O validador **nunca** envia esse header. Solução testada: um middleware de uma linha, antes do `jsonRpcHandler`, que assume `A2A-Version: 1.0` quando o header está ausente. Habilitar o `legacyCompat` seria errado, porque responderia no formato v0.3.

---

## 3. Diagrama de componentes

```mermaid
flowchart LR
    C["Cliente A2A<br/>(validador, curl, outro agente)"]

    subgraph AG["Processo B: agente :7300"]
        direction TB
        HTTP_A["main.ts<br/>express: GET card, POST /a2a<br/>middleware A2A-Version e traceparent"]
        SDK_A["@a2a-js/sdk<br/>DefaultRequestHandler<br/>+ InMemoryTaskStore"]
        EXE["executor.ts<br/>AgentExecutor: publica eventos da Task"]
        PONTE["ponte.ts<br/>traduz resultType em TaskState"]
        RET[("retomadas.ts<br/>Map taskId → requestState,<br/>chave, enum, args")]
        CLI["mcp/cliente.ts<br/>Client SDK em modo manual<br/>tools/list, resources/read, tools/call"]
        TR["trace.ts<br/>AsyncLocalStorage + traceparent"]
        HTTP_A --> SDK_A --> EXE --> PONTE
        PONTE <--> RET
        PONTE --> CLI
        TR -.-> CLI
        HTTP_A -.-> TR
    end

    subgraph MS["Processo A: servidor-mcp :7301"]
        direction TB
        HTTP_M["main.ts<br/>node:http, log stderr,<br/>handler.fetch"]
        SRV["servidor.ts<br/>McpServer por request<br/>tools + resource + verify"]
        TOOLS["tools/*.ts<br/>adaptadores finos"]
        RS["estado-mrtr.ts<br/>createRequestStateCodec<br/>REQUEST_STATE_SECRET"]
        DOM["dominio/regras.ts<br/>validação, conflito, alternativas"]
        AGD[("dominio/agenda.ts<br/>salas + reservas em memória<br/>singleton do processo")]
        HTTP_M --> SRV --> TOOLS --> DOM --> AGD
        TOOLS --> RS
    end

    D[("dados/<br/>salas.json, reservas.json,<br/>politica-de-uso.md")]

    C -- "HTTP POST /a2a<br/>JSON-RPC A2A v1.0<br/>header traceparent" --> HTTP_A
    CLI -- "HTTP POST /mcp<br/>JSON-RPC MCP 2026-07-28<br/>_meta + headers espelho" --> HTTP_M
    AGD -. "lido 1x ao subir" .-> D
    SRV -. "politica://uso" .-> D
```

O que atravessa cada fronteira:

- **Cliente ↔ agente:** texto fixo (`reservar ...`, `escolha=...`) dentro de mensagens A2A, `taskId`, `contextId` e o header `traceparent`.
- **Agente ↔ MCP:** `arguments`, `inputResponses`, `requestState` (opaco) e `_meta.traceparent`.
- **Nunca atravessa:** regras de sala para o agente, `requestState` para o cliente A2A e segredo para qualquer lado.

---

## 4. Estrutura de diretórios

Cada processo tem o **próprio** `package.json` e `package-lock.json`. Não há workspace nem código compartilhado, e é isso que torna "dois processos" literal: nada do agente importa algo do servidor.

```
.
├── README.md                    (substituído no fim)
├── ARQUITETURA.md               (este documento)
├── dados/ validador/ exemplos/  (🔒 intocados)
├── servidor-mcp/
│   ├── package.json             versões exatas, "type": "module", scripts start/check
│   ├── package-lock.json
│   ├── tsconfig.json
│   ├── test/
│   │   └── contrato.test.ts     testes de contrato: sobe o processo real e conversa por HTTP (node:test)
│   └── src/
│       ├── main.ts              sobe node:http na 7301, loga cada request no stderr, delega a handler.fetch
│       ├── config.ts            lê e valida env (porta, DADOS_DIR, REQUEST_STATE_SECRET ≥ 32 bytes, TTL)
│       ├── servidor.ts          factory do McpServer: registra tools/resource, liga requestState.verify
│       ├── estado-mrtr.ts       codec HMAC (mint/verify) e o tipo do payload selado
│       ├── log.ts               log estruturado em uma linha no stderr
│       ├── tools/
│       │   ├── listar-salas.ts
│       │   ├── consultar-disponibilidade.ts
│       │   └── reservar-sala.ts      o único ponto com MRTR
│       ├── recursos/
│       │   └── politica.ts           politica://uso, text/markdown
│       └── dominio/
│           ├── agenda.ts             carrega dados/, guarda reservas em memória, gera res-NNNN
│           └── regras.ts             validações, conflito, alternativas, mensagens exatas (funções puras)
└── agente/
    ├── package.json
    ├── package-lock.json
    ├── tsconfig.json
    └── src/
        ├── main.ts              express na 7300: card, /a2a, middlewares (A2A-Version, traceparent)
        ├── config.ts            porta, MCP_URL, A2A_PUBLIC_URL
        ├── card.ts              Agent Card v1.0 (espelho de exemplos/wire/07)
        ├── executor.ts          AgentExecutor do SDK A2A: recebe mensagem e publica estado/artifact
        ├── pedido.ts            parser do texto fixo; não é regra de domínio, é formato de entrada
        ├── ponte.ts             coordenador MCP ↔ A2A (seção 9)
        ├── retomadas.ts         Map<taskId, ContextoRetomada>, privado, nunca serializado para fora
        ├── trace.ts             parse e geração de traceparent, AsyncLocalStorage por request
        └── mcp/
            └── cliente.ts       Client do SDK: conecta 1x, descobre, lê política e chama tools
```

Por que essa granularidade:

- **`dominio/` separado de `tools/`:** as regras são funções puras e testáveis sem MCP. As tools só convertem `{args}` em domínio e domínio em `{content, structuredContent, isError}`. É a mesma regra do enunciado ("o agente traduz protocolo, não domínio") aplicada também dentro do servidor.
- **`agenda.ts` é singleton do módulo:** o `createMcpHandler` cria um `McpServer` **por request** (stateless), mas as reservas precisam sobreviver entre requests do mesmo processo. Guardar a agenda dentro da factory zeraria tudo a cada chamada. Esse é o erro mais provável do Passo 3.
- **Sem camada de "service", "repository interface" ou DI:** dois arquivos de domínio bastam para cinco salas.
- **`retomadas.ts` separado do TaskStore do SDK:** o TaskStore é serializado nas respostas A2A (`GetTask`). Se o `requestState` fosse para `task.metadata`, ele vazaria e reprovaria a verificação 34.
- **Arquivos vazios não serão criados agora.** A árvore acima é o plano; cada arquivo nasce no passo que o implementa.

---

## 5. Responsabilidades por processo

| Responsabilidade | servidor-mcp | agente |
|---|---|---|
| Endpoint | `POST /mcp` | `GET /.well-known/agent-card.json`, `POST /a2a` |
| Validação de `_meta` e headers | **SDK** (`-32602`/`-32020`, 400) | **emite** via SDK cliente |
| Ler `dados/` | ✅ (uma vez ao subir) | ❌ nunca |
| Regras: janela, duração, intervalo, sala | ✅ `regras.ts` | ❌ |
| Conflito e alternativas | ✅ | ❌ (só repete o `enum` recebido) |
| Gerar e verificar `requestState` | ✅ `estado-mrtr.ts` | ❌ guarda e ecoa, **nunca abre** |
| Capability form | conferida pelo SDK (`-32021`) | **declara** `{elicitation:{form:{}}}` |
| Task: criar, estado, histórico, artifact | ❌ | ✅ SDK A2A + `executor.ts` |
| Validar `escolha` contra o `enum` | também valida (defesa) | ✅ antes de chamar o MCP |
| Versão da política no artifact | serve o resource | ✅ lê `politica://uso` e extrai a 1ª linha |
| `traceparent` | **loga** | **propaga** (mesmo trace-id, span novo) |
| Log stderr | método, id, traceparent, eventos MRTR | estado das Tasks, ids MCP emitidos |

---

## 6. Contratos de comunicação MCP (agente → servidor)

### 6.1 Ciclo de vida do cliente

1. Na primeira necessidade, o agente cria **um** `Client` e chama `connect()` com `versionNegotiation: { mode: { pin: '2026-07-28' } }`, `capabilities: { elicitation: { form: {} } }` e `inputRequired: { autoFulfill: false }`.
   - O `connect()` envia um `server/discover`. Ele aparecerá no log do servidor e não é sessão: só confirma a revisão.
   - **Não** registramos handler de `elicitation/create`. Sem handler e com `autoFulfill: false`, o SDK nunca responde sozinho.
2. O objeto `Client` é reutilizado entre Tasks. Isso é estado de **processo**, não de protocolo: cada request leva o próprio `_meta` completo, e o servidor não lembra de nada. Se o servidor MCP reiniciar, o próximo request funciona igual.

### 6.2 Requests emitidos por Task

| Momento | Método | Headers (pelo SDK) | `_meta` (pelo SDK + nosso) | Observação |
|---|---|---|---|---|
| Início da Task | `tools/list` | `MCP-Protocol-Version`, `Mcp-Method` | `protocolVersion`, `clientInfo`, `clientCapabilities`, **`traceparent`** | Descoberta: confere que `reservar_sala` existe, sem lista fixa no código |
| Início da Task | `resources/read politica://uso` | + `Mcp-Name: politica://uso` | idem | Extrai `versao: AAAA-MM-DD` da 1ª linha |
| Pedido | `tools/call reservar_sala` | + `Mcp-Name: reservar_sala` | idem | `callTool(..., { allowInputRequired: true })` |
| Retomada | `tools/call reservar_sala` | idem | idem | Mesmo `name`/`arguments` + `inputResponses` + `requestState` ecoado; **id novo gerado pelo SDK** |

Decisão: fazer descoberta e leitura da política **a cada Task nova**, e não só ao subir. O custo é desprezível; o log fica com `tools/list` → `resources/read` → `tools/call` sob o mesmo trace-id, que é exatamente o que o avaliador procura; e o agente continua correto se o MCP for reiniciado.

### 6.3 Consistência header ↔ corpo

Nós **não** escrevemos esses headers à mão. O transporte do SDK cliente deriva `Mcp-Method`, `Mcp-Name` e `MCP-Protocol-Version` do próprio corpo que ele serializa, e o SDK servidor rejeita divergência com `-32020`. A garantia vem de ter uma única fonte (o objeto do request) e de os dois lados usarem o SDK. O único campo que injetamos é `_meta.traceparent`, que não tem header espelho.

### 6.4 Ids JSON-RPC

São gerados pelo SDK cliente, monotônicos por instância (`0, 1, 2, 3…`). Como o retry é um `callTool` **novo**, ele recebe um id novo automaticamente. Nunca passamos id manualmente.

---

## 7. Modelo de Task A2A

### 7.1 Estrutura

O que é público (serializado em `SendMessage`/`GetTask`) é gerido pelo `InMemoryTaskStore` do SDK:

```ts
Task {
  id: string                 // gerado pelo SDK (UUID) no 1º SendMessage sem taskId
  contextId: string          // idem
  status: { state: TaskState, message?: Message }   // message = última fala do agente
  history: Message[]         // usuário e agente, em ordem
  artifacts: Artifact[]      // [{ artifactId, name: "reserva", parts: [{ text: "<json>" }] }]
}
```

O que é privado e nunca sai do processo fica no `retomadas.ts`:

```ts
ContextoRetomada {
  taskId: string
  ferramenta: "reservar_sala"     // nome descoberto no tools/list
  argumentos: {...}               // os mesmos do 1º tools/call
  chave: string                   // a chave única de inputRequests
  alternativas: string[]          // o enum, na ordem recebida
  requestState: string            // opaco, byte a byte
  politica: string                // versão lida no início da Task
  traceId: string                 // trace-id de origem, se não vier header na continuação
}
```

### 7.2 Transições

```mermaid
stateDiagram-v2
    [*] --> SUBMITTED: SendMessage sem taskId
    SUBMITTED --> WORKING: executor inicia
    WORKING --> COMPLETED: MCP complete e reservado=true
    WORKING --> FAILED: MCP isError ou erro de protocolo/rede
    WORKING --> INPUT_REQUIRED: MCP input_required
    INPUT_REQUIRED --> INPUT_REQUIRED: escolha fora do enum ou texto inválido
    INPUT_REQUIRED --> WORKING: escolha=<id do enum>
    INPUT_REQUIRED --> WORKING: escolha=recusar (decline ao MCP)
    WORKING --> CANCELED: MCP complete e reservado=false (recusa)
    COMPLETED --> [*]
    FAILED --> [*]
    CANCELED --> [*]
```

Um ajuste em relação ao seu rascunho: a recusa também passa por `WORKING`, porque o agente **precisa** fazer o retry com `decline` para o MCP. É o MCP que conclui o MRTR. O `CANCELED` sai do `complete` com `reservado: false`, e não de um atalho no agente.

### 7.3 Respostas às sete perguntas

1. **Quem cria a Task?** O `DefaultRequestHandler` do SDK A2A, ao receber `SendMessage` sem `taskId`. Nosso executor publica o evento `task` inicial (`SUBMITTED`, com a mensagem do usuário no `history`).
2. **Identidade?** `id` e `contextId` são UUIDs gerados pelo SDK. Os exemplos usam `task-xxxx`, mas o validador não exige formato.
3. **Onde fica o estado?** Em memória, no `InMemoryTaskStore` (público) e no `Map` de `retomadas.ts` (privado). Nenhum dos dois sobrevive a restart do **agente**, e o enunciado não exige isso. Só o restart do **MCP** precisa ser suportado, e lá o estado viaja no `requestState`.
4. **`GetTask`?** O SDK lê o TaskStore e devolve o snapshot. O executor não participa.
5. **Retomada?** `SendMessage` com `message.taskId`: o SDK encontra a Task e chama o executor com `requestContext.task` preenchido em `INPUT_REQUIRED`. O executor pede à ponte `retomar(taskId, texto)`.
6. **Terminal?** O próprio SDK rejeita (`-32004 UNSUPPORTED_OPERATION`, testado), o que cobre a verificação 31. Como defesa extra, a ponte apaga a `ContextoRetomada` ao chegar a um estado terminal, então não há o que retomar.
7. **Duas Tasks pausadas?** Cada uma tem sua entrada no `Map`, indexada por `taskId`. Não existe variável "Task atual", nem `requestState` global, nem fila. A verificação 33 cobre isso.

---

## 8. Gerenciamento de estado

### 8.1 Dois mecanismos, dois donos

| | Estado da Task A2A | `requestState` MCP |
|---|---|---|
| Dono | agente | servidor MCP (quem cria), agente (quem carrega) |
| Onde vive | memória do agente | **dentro da mensagem**, entre um request e o próximo |
| Conteúdo | identidade, estado, histórico, artifact, contexto de retomada | o pedido original selado: argumentos, alternativas calculadas, chave |
| Integridade | não precisa: nunca sai do agente | HMAC-SHA256 com `REQUEST_STATE_SECRET`; adulterado → `-32602` |
| Validade | até terminar ou o processo cair | TTL de 10 min (dentro de 5–30); expirado → `-32602` |
| Sobrevive a restart | do agente: não (não exigido) | do MCP: **sim**, porque a chave vem do ambiente e o estado viaja no token |
| Quem pode ler | agente e cliente A2A (o que é público) | só o servidor. Para o agente é **opaco**: guarda e ecoa, nunca decodifica, mesmo sendo base64 legível |

### 8.2 Payload selado (planejado)

```ts
SeloReserva = {
  v: 1,
  args: { sala, inicio, fim, responsavel },  // o pedido original: fonte da verdade no retry
  alternativas: string[],                     // o enum oferecido: valida a escolha recebida
}
// o exp é colocado pelo codec (ttlSeconds)
```

No retry, o handler usa `ctx.mcpReq.requestState<SeloReserva>()`, já verificado pelo SDK, e **ignora** `params.arguments` (verificação 18). A escolha em `inputResponses` também é entrada não confiável: o servidor confere se ela está em `selo.alternativas` antes de reservar.

### 8.3 Por que nada disso é sessão

Sessão de **transporte/protocolo** seria o servidor lembrar algo **da conexão ou do cliente** entre requests, como versão negociada, capabilities ou "em que pergunta estávamos". Isso é proibido aqui: cada request MCP leva `_meta` completo, e o servidor reconstrói o contexto **do próprio request** (`requestState`).

Estado de **aplicação** é outra coisa:

- as reservas em memória do MCP são o dado de negócio;
- a Task do agente é um recurso com identidade, nomeado explicitamente pelo cliente via `taskId`.

Nenhum dos dois depende de conexão aberta ou de request anterior para **interpretar** o request atual. É o que o enunciado chama de "estado nomeado explicitamente". A Task é nomeada pelo `taskId`; o pedido pendente é nomeado pelo `requestState`.

---

## 9. A ponte MCP/A2A (`ponte.ts`)

### 9.1 Contrato do componente

```ts
iniciar(taskId, pedido: PedidoReserva): Promise<Desfecho>
retomar(taskId, texto: string): Promise<Desfecho>

type Desfecho =
  | { tipo: 'concluida', reserva: {...}, mensagem: string }     // → COMPLETED + artifact
  | { tipo: 'pausada', linha: 'alternativas: a, b' }            // → INPUT_REQUIRED
  | { tipo: 'cancelada', mensagem: string }                     // → CANCELED
  | { tipo: 'falhou', mensagem: string }                        // → FAILED (texto exato da tool)
```

O executor converte `Desfecho` em eventos A2A. A ponte não conhece eventos A2A, e o executor não conhece MCP. A ponte é o único arquivo que conhece os dois vocabulários: `resultType` e `isError` de um lado, os quatro desfechos do outro.

### 9.2 Passo a passo (os 11 itens do Passo 2)

1. **Recebe** `PedidoReserva`, já parseado por `pedido.ts`.
2. **Aciona** o cliente MCP: `tools/list` (confere a tool), `resources/read` (versão) e `tools/call`.
3. **Interpreta:** `resultType === 'input_required'`, ou `isError === true`, ou `complete`.
4. **Atualiza:** devolve o `Desfecho`, e o executor publica o novo status.
5. **Guarda:** em `input_required`, grava `ContextoRetomada` com chave, `enum` (de `requestedSchema.properties.sala.enum` ou `const`), `requestState` e argumentos.
6. **Não bloqueia:** o request A2A original **termina** devolvendo a Task em `INPUT_REQUIRED`. Nenhuma promise, conexão ou timer fica aberto esperando.
7. **Valida** `escolha=X`: `X === 'recusar'` ou `X ∈ enum`. Qualquer outra coisa → `pausada` com a **mesma** linha, sem chamar o MCP.
8. **Prepara** `inputResponses = { [chave]: { action: 'accept', content: { sala: X } } }` ou `{ [chave]: { action: 'decline' } }`.
9. **Recupera** o `requestState` do `Map`, intacto.
10. **Novo `tools/call`:** um `callTool` novo com os mesmos `name`/`arguments` + `inputResponses` + `requestState`. O SDK atribui o id novo.
11. **Traduz:** `complete` com `reservado: true` → `concluida`; `reservado: false` → `cancelada`; `isError` → `falhou`; outro `input_required` → `pausada` de novo (defensivo). Em estado terminal, apaga a `ContextoRetomada`.

### 9.3 Sequência com conflito e escolha

```mermaid
sequenceDiagram
    autonumber
    participant C as Cliente A2A
    participant E as agente: SDK A2A + executor
    participant P as agente: ponte.ts
    participant R as agente: retomadas (Map)
    participant K as agente: mcp/cliente.ts
    participant M as servidor-mcp

    C->>E: POST /a2a SendMessage (sem taskId)<br/>"reservar sala=sala-garagem ..."<br/>header traceparent 00-T-S0-01
    E->>E: Task criada: SUBMITTED → WORKING
    E->>P: iniciar(taskId, pedido)
    P->>K: descobrir + lerPolitica
    K->>M: tools/list (id=1), resources/read (id=2)<br/>_meta.traceparent 00-T-S1-01
    M-->>K: tools[], "versao: 2026-11-01"
    P->>K: chamar reservar_sala
    K->>M: tools/call (id=3)
    rect rgba(255,200,0,0.15)
    M-->>K: ① AQUI CHEGA O input_required<br/>{inputRequests:{k: form enum[...]}, requestState: RS}
    K-->>P: resultado cru (allowInputRequired)
    P->>R: ② AQUI O requestState É ARMAZENADO<br/>R[taskId] = {k, enum, RS, args, politica, T}
    P-->>E: Desfecho pausada("alternativas: sala-fusca, sala-mirante")
    E-->>C: ③ AQUI A TASK VAI PARA TASK_STATE_INPUT_REQUIRED<br/>(o request HTTP termina)
    end
    Note over C,M: Ninguém espera. O estado A2A está no TaskStore; o de domínio está em RS.
    C->>E: SendMessage {taskId, "escolha=sala-fusca"}
    E->>E: INPUT_REQUIRED → WORKING
    E->>P: retomar(taskId, "escolha=sala-fusca")
    P->>R: ler R[taskId]
    P->>P: sala-fusca ∈ enum? sim<br/>inputResponses = {k: accept {sala}}
    rect rgba(0,160,255,0.12)
    P->>K: ④ AQUI ACONTECE O RETRY
    K->>K: ⑤ AQUI O SDK GERA O NOVO ID JSON-RPC (id=4)
    K->>M: tools/call (id=4) args + inputResponses + requestState RS
    end
    M->>M: verify(RS) e lê o selo; ignora args do corpo
    M-->>K: complete, structuredContent {reserva, sala-fusca, ...}
    P->>R: delete R[taskId]
    P-->>E: Desfecho concluida
    E-->>C: TASK_STATE_COMPLETED + artifact "reserva" {..., politica}
```

### 9.4 Fluxo feliz (sem conflito)

```mermaid
sequenceDiagram
    autonumber
    participant C as Cliente A2A
    participant A as agente
    participant M as servidor-mcp
    C->>A: SendMessage "reservar sala=sala-porao 09-10"
    A->>A: SUBMITTED → WORKING
    A->>M: tools/list, resources/read, tools/call (traceparent T)
    M->>M: valida política, sem conflito, cria res-000N
    M-->>A: complete, isError false, structuredContent
    A-->>C: TASK_STATE_COMPLETED + artifact reserva {politica: "2026-11-01"}
```

---

## 10. Tratamento de erros

### 10.1 Servidor MCP

| Situação | Tipo | Quem produz | Wire |
|---|---|---|---|
| `_meta` sem `protocolVersion`/`clientCapabilities` | Protocolo | **SDK** | `-32602`, HTTP 400 |
| Header ≠ corpo | Protocolo | **SDK** | `-32020`, HTTP 400 |
| Elicitation sem capability form | Protocolo | **SDK** (confere o `inputRequired` retornado) | `-32021`, `data.requiredCapabilities`, HTTP 400 |
| `requestState` inválido/expirado | Protocolo | **SDK** + nosso codec | `-32602` "Invalid or expired requestState" |
| Tool inexistente | Protocolo | **SDK** | `-32602` |
| Resource inexistente | Protocolo | **SDK** | `-32602` com `data.uri` |
| Sala inexistente, janela, duração, intervalo, sem alternativas | **Execução** | **nós** (`regras.ts`) | `result.isError: true`, mensagem exata em `content[0].text` |
| Recusa (`decline`/`cancel`) | **Não é erro** | nós | `complete`, `reservado: false`, `motivo: "recusado"` |
| Exceção inesperada no handler | Execução | SDK converte | `isError: true` (genérico), e logamos no stderr |

Regra prática: **o que é sobre o request vem do SDK; o que é sobre o domínio, nós escrevemos.** Nunca lançamos exceção para erro de domínio; retornamos `isError`.

### 10.2 Agente (A2A)

| Situação | Resultado A2A |
|---|---|
| Tool devolve `isError` | `FAILED`, com `status.message` = texto exato da tool (o validador lê **`status.message`**, verificação 35) |
| MCP devolve erro JSON-RPC ou está fora do ar | `FAILED`, com mensagem descritiva. Ver risco R6 |
| `complete` com `reservado: false` | `CANCELED` |
| `input_required` | `INPUT_REQUIRED`, mensagem `alternativas: …` |
| Escolha fora do enum / texto não reconhecido | permanece `INPUT_REQUIRED`, **mesma** linha |
| Texto inicial fora do formato `reservar ...` | `FAILED` com mensagem de formato (decisão de produto nossa, não testada) |
| `SendMessage` em Task terminal | erro JSON-RPC pelo SDK (`-32004`) |
| `taskId` inexistente | erro JSON-RPC pelo SDK (`TaskNotFound`) |

Erros MCP aparecem no histórico porque a mensagem de status de cada transição é também anexada ao `history` pelo SDK. A linha `alternativas: …` é **sempre** construída como `"alternativas: " + enum.join(", ")`, sem nada antes nem depois.

---

## 11. Propagação de `traceparent` e observabilidade

Formato W3C: `00-<trace-id 32 hex>-<parent/span-id 16 hex>-<flags 2 hex>`.

1. Um middleware express no agente lê o header `traceparent` e valida o formato. Se for válido, guarda `{traceId, flags}` num `AsyncLocalStorage` durante o request.
2. Em cada request MCP, `mcp/cliente.ts` monta `00-<mesmo traceId>-<span novo aleatório>-<flags>` e o coloca em `_meta.traceparent`.
3. Se o header **não** vier (as verificações 29, 32, 33 e 36 não mandam), usa-se o `traceId` guardado na `ContextoRetomada` da Task. Se for Task nova sem header, gera-se um trace-id novo para a Task inteira.
4. O servidor MCP loga o `traceparent` de `_meta`.

Formato de log planejado (uma linha por evento, stderr):

```
[mcp] recv method=tools/call id=4 name=reservar_sala traceparent=00-4bf9…-a1b2…-01
[mcp] mrtr input_required id=3 chave=escolha_de_sala alternativas=sala-fusca,sala-mirante
[mcp] mrtr retry id=4 requestState=ok escolha=sala-fusca
[mcp] mrtr retry id=9 requestState=rejeitado motivo=mac
[agente] task=3c3a… SUBMITTED→WORKING traceId=4bf9…
[agente] task=3c3a… mcp tools/call id=3 → input_required
[agente] task=3c3a… WORKING→INPUT_REQUIRED
```

O log do servidor é feito **na borda HTTP**, em `main.ts`, antes do SDK: o corpo é lido, logado e repassado para `handler.fetch(new Request(...))`. Assim até os requests rejeitados pelo SDK (`-32602`/`-32020`) aparecem no log. Nunca logamos `REQUEST_STATE_SECRET` nem o `requestState` inteiro: no máximo os 12 primeiros caracteres.

---

## 12. Configuração e inicialização

### 12.1 Variáveis de ambiente

| Variável | Processo | Padrão | Obrigatória |
|---|---|---|---|
| `MCP_PORT` | servidor-mcp | `7301` | não |
| `DADOS_DIR` | servidor-mcp | `../dados` (relativo ao pacote) | não |
| `REQUEST_STATE_SECRET` | servidor-mcp | — | **sim**: o processo **não sobe** sem ela ou com menos de 32 bytes |
| `REQUEST_STATE_TTL_SECONDS` | servidor-mcp | `600` | não (validado entre 300 e 1800) |
| `AGENTE_PORT` | agente | `7300` | não |
| `MCP_URL` | agente | `http://localhost:7301/mcp` | não |
| `A2A_PUBLIC_URL` | agente | `http://localhost:7300/a2a` | não (vai no card) |

Nenhum segredo vai para o repositório. O `.gitignore` do starter já ignora `.env`.

### 12.2 Versões a travar (exatas, sem `^`)

| Pacote | servidor-mcp | agente |
|---|---|---|
| `@modelcontextprotocol/server` | 2.4.0 | — |
| `@modelcontextprotocol/client` | — | 2.4.0 |
| `@a2a-js/sdk` | — | 1.3.0 |
| `express` | — | 5.3.0 |
| `zod` | 4.6.7 | — (se necessário) |
| `tsx` (dev, executa TS) | 4.23.15 | 4.23.15 |
| `typescript` (dev, só checagem de tipos) | 7.0.2 | 7.0.2 |
| `@types/node` (dev) | 22.20.5 | 22.20.5 |

Os `package-lock.json` são commitados, e `npm ci` reproduz a instalação. `"engines": { "node": ">=22" }`.

Testes usam o `node:test` nativo do Node (executado via `node --import tsx --test`), sem framework adicional.

A opção por `tsx` em vez de `tsc` + `dist/` é pela simplicidade: um comando só, sem etapa de build, e com stack traces apontando para o `.ts`. A checagem de tipos fica em um script `check` separado.

### 12.3 Subida a partir de um clone limpo (planejado)

```powershell
# Terminal 1: servidor MCP
cd servidor-mcp
npm ci
$env:REQUEST_STATE_SECRET = python -c "import secrets; print(secrets.token_hex(32))"
npm start                     # escuta em :7301, logs no stderr

# Terminal 2: agente
cd agente
npm ci
npm start                     # escuta em :7300

# Terminal 3: validador (com os dois processos recém-iniciados)
python validador/validar.py --agente http://localhost:7300 --mcp http://localhost:7301
```

O equivalente em bash usa `export REQUEST_STATE_SECRET=...`. A ordem de subida não importa, porque o agente só conecta ao MCP na primeira Task.

---

## 13. Decisões técnicas e trade-offs

| # | Decisão | Justificativa | Alternativa considerada | Trade-off |
|---|---|---|---|---|
| D1 | TypeScript nos dois processos | MRTR explícito no SDK; tipagem; sua preferência; wire testado | Python (`mcp` 2.3.0) | Exige instalar Node; diferenças cosméticas com os exemplos |
| D2 | `createMcpHandler` + `responseMode: 'json'` + `legacy: 'reject'` | O validador só lê JSON; só servimos a revisão 2026-07-28 | `auto` (pode virar SSE); `stateless` legacy | Notificações no meio da chamada são descartadas (não usamos) |
| D3 | `node:http` puro no MCP, com log na borda | Logar **todo** request, inclusive os rejeitados; sem dependência extra | `@modelcontextprotocol/node` (`toNodeHandler`) | ~20 linhas de adaptação Request/Response nossas |
| D4 | `createRequestStateCodec` do SDK (HMAC, TTL 600 s) | Utilitário oficial; adulteração → `-32602` automático | HMAC manual; AES-GCM | Payload legível (permitido pelo enunciado) |
| D5 | Selo contém args + alternativas; o retry ignora `arguments` | Verificação 18; alternativas para validar a escolha | Rejeitar se os args divergirem | Menos mensagens de erro, mais robusto |
| D6 | Agenda como singleton de módulo | A factory do McpServer é por request | Estado dentro da factory | Precisa de cuidado com import/ciclo de vida |
| D7 | Cliente MCP do SDK em modo manual | Ver o `input_required` cru (a Task precisa pausar) | `fetch` à mão; auto-fulfill | Depende de API nova (`allowInputRequired`) |
| D8 | `tools/list` + `resources/read` a cada Task | Log claro por trace; resiliente a restart do MCP | Uma vez no boot | 2 requests extras por Task (irrelevante) |
| D9 | `@a2a-js/sdk` com `DefaultRequestHandler` + `InMemoryTaskStore` | Máquina de estados, histórico, `GetTask` e rejeição de terminal prontos e conformes à v1.0 | JSON-RPC A2A à mão | Precisa do middleware `A2A-Version`; menos controle byte a byte do JSON |
| D10 | Contexto de retomada fora do TaskStore | O TaskStore é serializado → evitaria vazar o `requestState` (verificação 34) | `task.metadata` | Dois lugares de estado por Task, ligados por `taskId` |
| D11 | Agente valida a escolha contra o `enum` antes de chamar o MCP | Verificação 29 (manter pausa sem efeitos); é validação de schema, não regra de sala | Mandar ao MCP e deixar falhar | O MCP também revalida (defesa em profundidade) |
| D12 | `tsx` para executar, sem build | Menos peças; README curto | `tsc` → `dist/` | Startup um pouco mais lento |
| D13 | Cada processo com o próprio `package.json` | Separação literal; `npm ci` independente | npm workspaces na raiz | Duas instalações |

---

## 14. Riscos conhecidos

| # | Risco | Mitigação / quando validar |
|---|---|---|
| R1 | SDKs muito novos (MCP 2.4.0, A2A 1.3.0): APIs podem mudar | Versões travadas e lockfile; o spike já confirmou os pontos críticos |
| R2 | Middleware `A2A-Version` esquecido → `-32009` em todas as chamadas A2A | Primeira coisa do passo do agente; teste com `curl` sem o header |
| R3 | Acesso ao header `traceparent` dentro do executor (o `ServerCallContext` do SDK não o expôs no spike) | `AsyncLocalStorage` preenchido por middleware express; confirmar no passo do agente |
| R4 | Agenda recriada a cada request (factory) | Singleton de módulo; teste: reservar e consultar em seguida |
| R5 | Escolha válida, mas a sala foi ocupada entre a pausa e o retry | Servidor revalida a disponibilidade no retry. A resposta exata (novo `input_required` ou erro) fica para o passo do MRTR; o validador não exercita esse caso |
| R6 | MCP fora do ar durante uma Task | A Task vai para `FAILED` com mensagem clara; não é exigido |
| R7 | Windows: `localhost` resolvendo `::1` vs `127.0.0.1` | `listen()` sem host (dual-stack) nos dois processos |
| R8 | Validador rodado duas vezes sem reiniciar → falsos negativos | Documentar no README; reiniciar sempre |
| R9 | Git fora do PATH e Node ausente no PC | Pendências de ambiente (seção 16) |
| R10 | `server/discover` no log pode confundir quem procura `tools/list` | Esperado: o avaliador procura `tools/list` **antes do primeiro `tools/call`**, e isso continua verdadeiro |

---

## 15. Componentes × verificações do validador

| Verificações | Componente responsável | Principal ponto de atenção |
|---|---|---|
| 01–02 | `servidor.ts` + `tools/*` (schemas zod) | Nomes exatos; `inputSchema` objeto |
| 03 | `tools/listar-salas.ts` | `text = JSON.stringify(structuredContent)` |
| 04–05, 15 | **SDK** servidor | Só conferir que nada nosso intercepta antes |
| 06, 08 | **SDK** servidor | — |
| 07 | `recursos/politica.ts` | Conteúdo do arquivo, `text/markdown` |
| 09–12, 20 | `dominio/regras.ts` | Mensagens exatas; ordem das validações; comparar instantes |
| 13–14 | `tools/reservar-sala.ts` + `regras.ts` (alternativas) | Ordem capacidade → id, máximo 3 |
| 16, 18, 19 | `reservar-sala.ts` + `estado-mrtr.ts` | Usar o selo, não os args; escolha ∈ alternativas; `decline` → `reservado:false` |
| 17 | `estado-mrtr.ts` (codec) | `REQUEST_STATE_SECRET` do ambiente |
| 21–23 | `agente/card.ts` + `main.ts` | `supportedInterfaces`, skill `reservar-sala` |
| 24–26 | `executor.ts` + `ponte.ts` + `mcp/cliente.ts` | Artifact `reserva` com `politica` do resource |
| 27–28, 36 | `ponte.ts` | Linha `alternativas:` byte a byte e determinística |
| 29 | `ponte.ts` (validação contra enum) | Sem chamar o MCP |
| 30, 32 | `ponte.ts` (retry) | id novo, mesma chave, RS intacto; `recusar` → `decline` → `CANCELED` |
| 31 | **SDK** A2A | `-32004` |
| 33 | `retomadas.ts` | Isolamento por `taskId` |
| 34 | `retomadas.ts` (fora do TaskStore) | O RS nunca em mensagem, artifact ou metadata |
| 35 | `ponte.ts` + `executor.ts` | Mensagem exata em `status.message` |
| Avaliador (log) | `servidor-mcp/main.ts` + `agente/trace.ts` | `tools/list` antes do `tools/call`; trace-id; ids distintos |
| Avaliador (restart) | `estado-mrtr.ts` | Segredo do ambiente, selo autossuficiente |

---

## 16. Pré-requisitos para o Passo 3

- [ ] Instalar **Node.js LTS ≥ 22** no PC (`winget install OpenJS.NodeJS.LTS`) e conferir `node -v` / `npm -v` em um terminal novo.
- [ ] Colocar o **Git no PATH** do usuário (`C:\Program Files\Git\cmd`).
- [ ] (Opcional) `git remote add upstream https://github.com/devfullcycle/desafio-a2a-com-mcp.git`.
- [ ] Gerar um `REQUEST_STATE_SECRET` local, sem commitá-lo.
- [ ] Passo 3: `servidor-mcp/` com `package.json` travado, `main.ts` (borda HTTP + log), `config.ts`, `servidor.ts` e `listar_salas` + `politica://uso`. Meta: verificações 01–08 verdes.

---

## 17. Estado da implementação

### Passo 3: servidor MCP mínimo (07/11/2026)

Implementado em `servidor-mcp/`. Ver `servidor-mcp/README.md` para comandos e exemplos de request.

| Item | Situação |
|---|---|
| `main.ts`, `config.ts`, `log.ts`, `servidor.ts` | ✅ |
| `tools/listar-salas.ts` + `dominio/agenda.ts` (só salas) | ✅ |
| Capability anunciada | só `tools`. `resources` entra junto com `politica://uso` no Passo 4 |
| `consultar_disponibilidade`, `reservar_sala`, `politica://uso`, `regras.ts`, `estado-mrtr.ts` | ⏳ passos seguintes |
| `REQUEST_STATE_SECRET` | ainda não é lida; passa a ser obrigatória no passo do MRTR |

Ajustes em relação ao plano:

- **A borda HTTP repassa a resposta em streaming** (`Readable.fromWeb(...).pipe(res)`), sem bufferizar. Com `responseMode: 'json'`, as chamadas comuns voltam como um JSON único. Mas `subscriptions/listen` é sempre SSE, e o MCP Inspector (modo `modern`) abre esse stream antes do `tools/list`. Na primeira versão, que esperava o corpo inteiro, o Inspector ficava travado.
- **O `onerror` do SDK recebe tanto rejeições de protocolo quanto falhas internas.** O log separa os dois casos: `rejeitado` e `erro`.
- **Validação de Host (`hostHeaderValidationResponse` com `localhostAllowedHostnames`)** contra DNS rebinding, antes do handler.

Validador oficial com só o servidor MCP no ar: **5/36**. Passam 02, 03, 04, 05 e 06. A 01 falha porque só existe 1 das 3 tools. As 07–20 dependem do Passo 4 em diante, e as 21–36 dependem do agente.

### Passo 4: tools, resources e contratos MCP (07/11/2026)

| Item | Situação |
|---|---|
| `recursos/politica.ts` (`politica://uso`, `text/markdown`) | ✅ |
| Capabilities anunciadas | `tools` e `resources`, ambas com `listChanged: false` |
| `test/contrato.test.ts` (20 testes, `npm test`) | ✅ |
| `consultar_disponibilidade`, `reservar_sala`, `regras.ts`, `estado-mrtr.ts` | ⏳ passos seguintes |

**Tools × resources no código.** Uma *tool* é uma ação que o modelo (ou o agente) decide **executar**, com argumentos validados por `inputSchema` e resultado descrito por `outputSchema`. Um *resource* é um dado que a aplicação **lê** por URI, sem argumentos e sem efeito colateral. Os dois são registrados na mesma factory (`servidor.ts`): `registerTool` em `tools/`, `registerResource` em `recursos/`. O registro é o que gera a descoberta (`tools/list`, `resources/list`) e o despacho (`tools/call`, `resources/read`). Não existe rota HTTP por tool ou resource.

**Contrato de `listar_salas`.**

- Entrada: `inputSchema = { type: "object", properties: {} }` (zod `z.object({})`). Não há parâmetros de negócio.
- Saída: `outputSchema` com o mesmo envelope de `exemplos/wire/01`: `{ salas: Sala[] }`, com `Sala = { id: string, nome: string, capacidade: integer ≥ 1, recursos: string[] }` e os quatro campos obrigatórios. O zod gera o schema inline, sem `$defs`/`title` como no exemplo em Python, mas a estrutura e os tipos são os mesmos.
- Resultado: `structuredContent = { salas }` e um único bloco `text` com `JSON.stringify(structuredContent, null, 2)`. O SDK valida o `structuredContent` contra o `outputSchema` antes de responder.
- `capacidade` passou de `z.number().int()` para `z.int().min(1)`. O schema publicado agora diz `minimum: 1` em vez do intervalo de inteiros seguros (que admitia capacidade negativa). Os dados do starter (4 a 20) já cumprem isso, e uma sala sem capacidade derrubaria o processo na subida.

**Leitura de `politica://uso`.** `recursos/politica.ts` lê `dados/politica-de-uso.md` uma vez ao subir e devolve o texto **integral, sem transformação**, com `mimeType: text/markdown` e `uri` igual à pedida. A versão (`versao: 2026-11-01`) **não** está no código: ela é a primeira linha do arquivo, e só aparece no log de subida (`politica="versao: 2026-11-01"`). O agente vai extraí-la lendo o resource. `resources/list` devolve `{ uri, name: "politica-de-uso", title, description, mimeType }`, os mesmos `uri` e `mimeType` da leitura.

**URI inexistente.** O SDK responde `-32602 Resource not found` com `data.uri`, HTTP 200. Não escrevemos nada para isso. Uma URI que o servidor não anunciou é um **parâmetro inválido** do request, e não "um recurso vazio": um `contents: []` faria o cliente acreditar que leu a política e que ela não tem regras.

**Fim de linha no Windows.** O Git for Windows vem com `core.autocrlf=true`, então `dados/politica-de-uso.md` fica em CRLF na cópia de trabalho (no repositório, LF). O servidor serve o arquivo como está no disco, e o teste compara byte a byte com o mesmo arquivo. Quem extrair a versão da primeira linha precisa aceitar `\r?\n`: isso vale para o teste e, no passo do agente, para o campo `politica` do artifact. Não adicionamos `.gitattributes` para não mudar a configuração do repositório.

**Capabilities.** Sem configuração, o SDK anuncia `listChanged: true` ao registrar a primeira tool ou resource. Como o catálogo é fixo, `servidor.ts` declara `listChanged: false` para as duas: não prometemos notificações que nunca serão enviadas. `subscribe` e `prompts` não são anunciados nem atendidos (`prompts/list` e `resources/subscribe` recebem `-32601`). O cliente descobre isso com `server/discover`.

**Metadados e headers.** `resources/list` e `resources/read` passam pela mesma validação do SDK que as tools: sem `protocolVersion` ou sem `clientCapabilities`, HTTP 400 e `-32602`. Em `resources/read`, o `Mcp-Name` é **obrigatório** e precisa ser igual a `params.uri`. Se ele estiver ausente ou divergente, a resposta é HTTP 400 e `-32020`. Em `resources/list`, que não tem nome, o header não vai.

**Estratégia de testes.** `npm test` sobe `src/main.ts` como processo filho numa porta livre e faz requests HTTP reais, iguais aos do validador, capturando o stderr. Isso cobre:

- a descoberta: `server/discover`, `tools/list` e `resources/list`;
- a execução: `tools/call` e `resources/read`, comparando com os arquivos de `dados/`;
- os casos negativos: tool e URI inexistentes, `_meta` incompleto nos quatro métodos e header divergente ou ausente;
- os logs: método, id e traceparent, além de `-` quando o traceparent não vem.

Nada é simulado. Um teste de mutação manual (remover o `registrarPolitica`) derrubou 2 testes, como esperado.

**Exemplos reproduzíveis** (com o servidor no ar; PowerShell 5.1):

```powershell
$h = @{ 'Accept'='application/json, text/event-stream'; 'MCP-Protocol-Version'='2026-07-28' }
$meta = @{ 'io.modelcontextprotocol/protocolVersion'='2026-07-28'; 'io.modelcontextprotocol/clientCapabilities'=@{} }

# resources/list
$h['Mcp-Method']='resources/list'
$b = @{ jsonrpc='2.0'; id=1; method='resources/list'; params=@{ _meta=$meta } } | ConvertTo-Json -Depth 6
(Invoke-RestMethod http://localhost:7301/mcp -Method Post -ContentType 'application/json' -Headers $h -Body $b).result.resources

# resources/read politica://uso (Mcp-Name obrigatório, igual à URI)
$h['Mcp-Method']='resources/read'; $h['Mcp-Name']='politica://uso'
$b = @{ jsonrpc='2.0'; id=2; method='resources/read'; params=@{ uri='politica://uso'; _meta=$meta } } | ConvertTo-Json -Depth 6
(Invoke-RestMethod http://localhost:7301/mcp -Method Post -ContentType 'application/json' -Headers $h -Body $b).result.contents[0].text
```

Ou pelo Inspector: `npx @modelcontextprotocol/inspector@2.14.0 --cli http://localhost:7301/mcp --transport http --protocol-era modern --method resources/read --uri politica://uso`.

Validador oficial com só o servidor MCP no ar: **7/36**. Passam 02 a 08. A 01 espera as três tools; as 09 a 20 dependem das regras, de `reservar_sala` e do MRTR; as 21 a 36 dependem do agente.
