# Relatório de conformidade: A Ponte (agente A2A com MCP por dentro)

Validação formal executada em 20/11/2026 no PC de desenvolvimento, sobre o commit `b3625c1` (branch `main`, Passo 12). Nenhum código foi alterado para esta validação. Todas as evidências estão em [`evidencias/`](evidencias/) e podem ser reproduzidas com os comandos da seção 5 e da seção 6.

## 1. Resumo executivo

A implementação está **em conformidade integral** com o desafio, nesta execução:

| Grupo | Verificações do validador | Resultado |
|---|---|---|
| MCP | 01–12, 20 | PASS (13/13) |
| MRTR | 13–19 | PASS (7/7) |
| Host MCP | indireto em 24–36; logs: descoberta, trace, ids | PASS |
| A2A | 21–28, 31, 35, 36 | PASS (11/11) |
| Ponte | 29, 30, 32, 33, 34 | PASS (5/5) |
| **Total** | | **36/36** |
| **Código de saída** | | **0** |

Além do validador:
- **Testes automatizados:** o agente passou 130 de 130 e o servidor MCP, 149 de 149.
- **Logs do MCP:** a auditoria pelo trace-id do validador passou nos 5 itens.
- **Roteiro manual do avaliador:** os 64 itens passaram, e os 2 do retry depois do restart do MCP também.
- **Arquivos protegidos:** idênticos ao starter oficial.
- **Problemas:** nenhuma falha crítica de protocolo ou de segurança ficou pendente.

## 2. Ambiente

Fonte: [`evidencias/01-ambiente.txt`](evidencias/01-ambiente.txt).

| Item | Valor |
|---|---|
| Sistema operacional | Windows 11 Pro 10.0.26300.9974 |
| Node.js / npm | v26.13.0 / 11.20.0 |
| Python | 3.15.2 (validador e roteiro, só biblioteca padrão) |
| Git | 2.55.0.windows.2 |
| Linguagem | TypeScript executado por `tsx` 4.23.15 (checagem: `typescript` 7.0.2) |
| `servidor-mcp` | `@modelcontextprotocol/server` 2.4.0, `zod` 4.6.7 |
| `agente` | `@a2a-js/sdk` 1.3.0, `@modelcontextprotocol/client` 2.4.0, `express` 5.3.0 |
| Revisão MCP | `2026-07-28` (Streamable HTTP, `responseMode: 'json'`) |
| Protocolo A2A | 1.0, binding JSON-RPC |
| Portas | MCP `7301` (`/mcp`), agente `7300` (`/a2a`, `/.well-known/agent-card.json`) |
| Segredo | `REQUEST_STATE_SECRET` em `servidor-mcp/.env` (fora do Git), 64 dígitos hex (32 bytes). O valor não aparece em nenhuma evidência |
| TTL do `requestState` | 900 s (padrão; aceito entre 300 e 1800) |
| Timeout do agente para o MCP | `MCP_TIMEOUT_MS` = 20000 (padrão) |
| Subida | `servidor-mcp`: `npm start` (`tsx --env-file-if-exists=.env src/main.ts`); `agente`: `npm start` (`tsx src/main.ts`) |

Estado inicial: `git status` limpo; o Passo 12 já estava commitado (`b3625c1`, acima de `7a40bc3`); as portas 7300 e 7301 estavam livres.

## 3. Arquitetura validada

```
Cliente A2A ──JSON-RPC──▶ Agente (7300) ──Streamable HTTP──▶ Servidor MCP (7301)
                          servidor A2A                         3 tools + politica://uso
                          ponte  (Map taskId → continuação)    MRTR: input_required + requestState HMAC
                          Host MCP (descoberta, política, retry)
```

- **Servidor MCP.** Stateless. Expõe as tools `listar_salas`, `consultar_disponibilidade` e `reservar_sala` e o resource `politica://uso`. Um conflito gera `input_required` com elicitation em form mode e um `requestState` assinado (HMAC-SHA256, com prazo) que guarda o pedido original e as alternativas. O retry é reconstruído só a partir desse estado. Cada request é registrado no stderr com método, id e `traceparent`.
- **Host MCP.** Fica dentro do agente. A cada Task, descobre as tools com `tools/list` e lê a política com `resources/read`. Executa a tool e devolve a continuação como um valor opaco. O retry usa um id JSON-RPC novo, a mesma chave de elicitation e o `requestState` intacto.
- **Servidor A2A.** Publica o Agent Card e atende `SendMessage` e `GetTask`. As Tasks ficam num `TaskStore` próprio que impõe a máquina de estados, com histórico e o artifact `reserva`.
- **Ponte.** Converte `input_required` em `TASK_STATE_INPUT_REQUIRED`, com a mensagem `alternativas: …`. A continuação fica num mapa privado por `taskId`, fora do `TaskStore`. Por isso o `requestState` nunca chega ao cliente.

Detalhes em [`ARQUITETURA.md`](ARQUITETURA.md).

## 4. Matriz de conformidade

Resultado: todas as linhas deram PASS nesta execução. As evidências 04 a 08 estão em `evidencias/`. A coluna Validador traz os números das verificações oficiais; os demais identificadores (L, C, P, I, K, R, D, E, Z, S, X, V) são itens do roteiro manual.

| ID | Requisito | Componente | Teste | Evidência |
|---|---|---|---|---|
| R01 | `tools/list` com as 3 tools e `inputSchema` de objeto | MCP | validador 01–02 | 04 |
| R02 | `listar_salas` com `structuredContent` e o mesmo JSON em texto | MCP | validador 03 | 04 |
| R03 | `_meta` sem `protocolVersion` ou sem `clientCapabilities` → HTTP 400 e -32602 | MCP | validador 04–05; roteiro E2 | 04, 07 |
| R04 | Tool e URI inexistentes recusadas (-32602) | MCP | validador 06, 08 | 04 |
| R05 | `politica://uso` devolve a política | MCP | validador 07 | 04 |
| R06 | Erros de domínio em `isError` com a mensagem exata | MCP | validador 09–12, 20; roteiro D3 | 04, 07 |
| R07 | Conflito → `input_required` em form mode, alternativas em ordem | MRTR | validador 13–14; roteiro S1, Z1 | 04, 07 |
| R08 | Sem elicitation → HTTP 400, -32021 e `requiredCapabilities` | MRTR | validador 15; roteiro E1 | 04, 07 |
| R09 | Retry com `inputResponses` e `requestState` conclui a reserva | MRTR | validador 16 | 04 |
| R10 | `requestState` adulterado → -32602, nada gravado | MRTR | validador 17; roteiro S2–S4 | 04, 07 |
| R11 | Argumentos adulterados no retry não têm efeito | MRTR | validador 18; roteiro S5 | 04, 07 |
| R12 | Recusa conclui sem reservar e sem `isError` | MRTR | validador 19; roteiro R1–R6 | 04, 07 |
| R13 | Retry depois do restart do MCP, com o mesmo segredo | MRTR | roteiro Z1–Z3 | 07, 08 |
| R14 | Descoberta: `tools/list` antes do primeiro `tools/call` | Host | logs L2; roteiro K5 | 05, 07 |
| R15 | O trace-id do cliente chega a todos os requests MCP da Task | Host | logs L1, L4; roteiro K6, X8 | 05, 07 |
| R16 | Pausa e retry com ids JSON-RPC diferentes | Host | logs L3; roteiro K6, R6, X8 | 05, 07 |
| R17 | Agent Card 1.0: interface, skill e capabilities iguais ao exemplo 07 | A2A | validador 21–23; roteiro C1–C4 | 04, 06, 07 |
| R18 | `SendMessage` com sala livre conclui; artifact `reserva` traz a política | A2A | validador 24–25 | 04 |
| R19 | `GetTask` devolve id, contextId, estado, histórico e artifact | A2A | validador 26; roteiro K7–K9, D2 | 04, 07 |
| R20 | Conflito pausa a Task com a lista de alternativas exata | Ponte | validador 27–28; roteiro P1–P5 | 04, 07 |
| R21 | Escolha inválida mantém a pausa, sem chamar o MCP | Ponte | validador 29; roteiro I1–I4 | 04, 07 |
| R22 | A continuação conclui na sala escolhida | Ponte | validador 30; roteiro K1–K4 | 04, 07 |
| R23 | Task terminal não é retomada (-32004) | A2A | validador 31; roteiro K10, R4 | 04, 07 |
| R24 | `escolha=recusar` → `TASK_STATE_CANCELED` | Ponte | validador 32; roteiro R2 | 04, 07 |
| R25 | Duas Tasks pausadas, isoladas | Ponte | validador 33; roteiro X1–X8 | 04, 07 |
| R26 | Nenhum `requestState` nem estado interno no A2A | Ponte | validador 34; roteiro V (9 itens) | 04, 07 |
| R27 | Erro de domínio → `FAILED` com a mensagem da tool | A2A | validador 35; roteiro D1–D2 | 04, 07 |
| R28 | Determinismo: o mesmo pedido gera a mesma pausa | A2A | validador 36 | 04 |
| R29 | `dados/`, `validador/` e `exemplos/` intactos | Repositório | diff contra o starter | 02 |

## 5. Validador oficial

| Item | Valor |
|---|---|
| Comando | `python validador/validar.py --agente http://localhost:7300 --mcp http://localhost:7301` (no Windows o executável é `python`) |
| Data | 20/11/2026 |
| Processos | os dois recém-iniciados, agenda carregada de `dados/` |
| Trace-id impresso | `1d9558549e0a087126d13524029f5d8e` |
| PASS | 36 (01 a 36) |
| FAIL | 0 |
| Resumo | `resumo: 36 passaram, 0 falharam, de 36 verificacoes` |
| Código de saída | `0` (`$LASTEXITCODE`) |
| Saída completa | [`evidencias/04-validador.txt`](evidencias/04-validador.txt) |

O validador usado é o do starter, sem modificação (seção 7.6). Ele devolve exit 0 só quando as 36 verificações passam, e a contagem foi conferida na própria saída.

**Auditoria do log MCP pelo trace-id** ([`evidencias/05-auditoria-logs-mcp.txt`](evidencias/05-auditoria-logs-mcp.txt), log em [`evidencias/logs/mcp-validador.log`](evidencias/logs/mcp-validador.log)):

| Item | Resultado |
|---|---|
| L1: requests com o trace-id | 9 linhas: 8 do agente e 1 `tools/call` direta do validador (id texto) |
| L2: ordem dos requests do agente | `tools/list#0 → tools/list#1 → resources/read#2 → tools/call#3 → tools/list#4 → resources/read#5 → tools/call#6 → tools/call#7` |
| L3: ids dos `tools/call` | 3, 6 e 7, todos diferentes; 6 é a pausa e 7 é o retry |
| L4: spans | 9 spans para 9 requests (parent-id novo a cada salto) |
| L5: método e id registrados | 52 linhas `recv`, todas com método e id |

## 6. Testes manuais

Roteiro: [`evidencias/roteiro_p13.py`](evidencias/roteiro_p13.py). Os requests são montados a partir dos exemplos oficiais: o `SendMessage` usa o envelope de `exemplos/wire/08` e `10`, e as chamadas MCP usam `02`, `03`, `04` e `06`. Cada Task usa um trace próprio, o que permite achar no log do MCP os requests de cada cenário.

Para reproduzir (na raiz, com os dois processos recém-iniciados):

```powershell
python evidencias/roteiro_p13.py manual --log-mcp <stderr do MCP> --estado $env:TEMP\estado.json
# reinicie SÓ o servidor MCP, com o mesmo .env
python evidencias/roteiro_p13.py restart --estado $env:TEMP\estado.json
```

| Tarefa | Cenário | Itens | Resultado | Evidência principal |
|---|---|---|---|---|
| T6 | Agent Card × exemplo 07 | C1–C4 | PASS | HTTP 200; campos iguais ao exemplo e nenhum extra; url `http://localhost:7300/a2a` |
| T8 | Pausa (pedido oficial de conflito) | P1–P5 | PASS | `TASK_STATE_INPUT_REQUIRED`, `alternativas: sala-fusca, sala-mirante`, sem artifact |
| T11 | Escolha inválida `escolha=sala-inexistente` | I1–I4 | PASS | continua pausada, mesma lista; requests MCP do trace: 4 antes, 4 depois |
| T9 | Continuação `escolha=sala-mirante` | K1–K10 | PASS | `res-0003` na mirante, Marty, 14–15h, política `2026-11-01`; pausa id 3 e retry id 4 no mesmo trace; histórico com 6 mensagens; nova escolha → -32004 |
| T10 | Recusa `escolha=recusar` | R1–R6 | PASS | `CANCELED`, sem artifact, sala-fusca continua livre; o decline foi um `tools/call` com id novo; retomar → -32004 |
| T12 | Erro de domínio (sala inexistente) | D1–D3 | PASS | `FAILED` com `Sala inexistente: sala-inexistente`, no status e no histórico; no MCP, `isError: true` com HTTP 200 |
| T15 | Capability ausente | E1–E2 | PASS | `clientCapabilities: {}` → 400/-32021 com `requiredCapabilities`; sem o campo → 400/-32602 |
| T14 | Retry depois do restart | Z1–Z3 | PASS | estado de 397 caracteres guardado sem ser impresso; depois do restart: `complete`, `res-0003`, garagem→fusca, 14–15h, Doc |
| T13 | `requestState` adulterado | S1–S5 | PASS | um caractere trocado → -32602, sem eco e sem reserva; argumentos adulterados com estado válido → vale o pedido selado (`res-0004`) |
| T16 | Duas Tasks retomadas em ordem inversa | X1–X8 | PASS | B: mirante, Bob (`res-0007`); A: fusca, Alice (`res-0008`); históricos isolados; `tools/call` A = 20 e 25, B = 23 e 24 |
| T17 | Vazamento nas superfícies públicas | V (9) | PASS | 19 respostas públicas inspecionadas, sem `requestState`, `inputRequests`, `inputResponses`, `escolha_de_sala`, `continuacao`, `REQUEST_STATE_SECRET`, `7301`, `"v1.` ou o valor do segredo |

Saídas: [`evidencias/07-fluxo-manual.txt`](evidencias/07-fluxo-manual.txt) (64 PASS, exit 0) e [`evidencias/08-retry-apos-restart.txt`](evidencias/08-retry-apos-restart.txt) (2 PASS, exit 0). O Agent Card cru está em [`evidencias/06-agent-card.txt`](evidencias/06-agent-card.txt).

**O que o restart prova e o que não prova.** A reserva criada antes do restart **não** sobrevive: a agenda vive em memória e recomeça de `dados/`, por isso o retry conseguiu reservar a fusca de novo. O que sobrevive é a **capacidade de validar e interpretar** o `requestState`: o pedido original e as alternativas estão selados nele, e o segredo vem do ambiente. Um processo novo, com o mesmo segredo, reconstrói a operação sem nenhuma memória da anterior.

**O que não dá para observar de fora, e como foi coberto.** Pelo HTTP não é possível ver o `requestState` que o agente reenvia no retry, nem a chave que ele usa, porque os dois são internos. A evidência é indireta. Primeiro, o servidor só aceita o retry se o HMAC conferir. Segundo, ele só aceita a resposta se ela vier na chave da pergunta. A evidência direta está no teste automatizado `agente/test/ponte.test.ts`, que observa o fio MCP e confere chave, `requestState` byte a byte, argumentos originais e id novo.

## 7. Segurança

1. **Integridade do `requestState`.** O formato é `v1.` + base64url + HMAC-SHA256 (`createRequestStateCodec` do SDK). Um único caractere trocado dá -32602 (roteiro S2, validador 17), e nada é gravado (S4). A resposta de erro não ecoa o estado nem o segredo (S3). Os testes do servidor (`mrtr.test.ts`, `estado-mrtr.test.ts`) cobrem ainda estado malformado, vazio, de outro segredo e de outro conflito.
2. **Expiração.** O prazo (`exp`) fica dentro da parte assinada, com TTL de 900 s. Um estado vencido dá -32602. Isso é coberto por teste com relógio simulado e por HTTP, com um estado vencido emitido com a mesma chave (`estado-mrtr.test.ts`, `mrtr.test.ts`).
3. **Segredo de ambiente.** O segredo vem só de `REQUEST_STATE_SECRET`, via `.env` (fora do Git) ou do ambiente. O servidor não sobe sem ele ou com menos de 64 dígitos hex. Ele não está no código, não aparece nos logs e não está nas evidências: o `01-ambiente.txt` registra só "presente, 64 dígitos hex".
4. **Argumentos adulterados.** O retry usa o pedido selado, e os `arguments` reenviados não têm efeito (S5, validador 18).
5. **Ausência de vazamento.** Nenhuma superfície pública do A2A expõe estado interno (roteiro V, validador 34). Os logs do agente não têm `requestState`. Nos logs do MCP a palavra aparece só no boot (`requestStateTtl=900`) e em mensagens de rejeição sem o valor. Antes de serem gravados em `evidencias/logs/`, todos os logs foram conferidos: nenhum tem o segredo ou `v1.` seguido de 20 caracteres ou mais.
6. **Arquivos protegidos.** O remote `upstream` (https://github.com/devfullcycle/desafio-a2a-com-mcp.git) foi adicionado localmente. `upstream/main` e o merge-base com `HEAD` são o mesmo commit, `263f17e202fd861d14aa7a5e6a539d13a62857c3`. O `git diff` contra o starter (working tree e commits) deu vazio, não há arquivo novo não rastreado, e os SHA-256 dos 16 arquivos de `dados/`, `validador/` e `exemplos/wire/` são iguais aos do starter ([`evidencias/02-arquivos-protegidos.txt`](evidencias/02-arquivos-protegidos.txt)).

## 8. Rastreabilidade

- **`traceparent`.** O agente lê o header do `SendMessage` e repassa o mesmo trace-id em `_meta.traceparent` de cada request MCP, com um parent-id novo por request (L4). Na retomada, vale o trace guardado com a Task. Se o cliente não manda trace, nada é enviado: o agente nunca inventa um.
- **IDs JSON-RPC.** O cliente MCP do agente usa um contador por conexão, então nenhum id se repete. Pausa e retry têm ids diferentes nos três lugares observados: validador (6 e 7), Task manual (3 e 4) e Tasks isoladas (20/25 e 23/24). No lado A2A, o id do `SendMessage` volta igual na resposta e é diferente do id da Task (P1, K7).
- **Ordem de descoberta.** Em toda Task, `tools/list` e `resources/read politica://uso` vêm antes do primeiro `tools/call` (L2, K5). No log, também aparece o `server/discover` do connect, que é esperado.
- **Logs.** Uma linha por evento no stderr. A linha `[mcp] recv` traz método, id, nome e `traceparent`. O agente registra `[a2a] task=… trace=…`. A única linha fora desse formato é o aviso do SDK no boot do MCP (`responseMode: 'json' drops mid-call notifications`).

## 9. Riscos residuais

**Limitações aceitas pelo enunciado**
- A agenda e as Tasks vivem em memória: um restart do agente perde as Tasks, e um restart do MCP perde as reservas feitas. Só a continuação MRTR precisa sobreviver ao restart do MCP, e ela sobrevive (T14).
- O payload do `requestState` é assinado, mas não cifrado. O enunciado exige integridade, não sigilo.
- O validador e o fluxo de avaliação partem de processos recém-iniciados. Rodar o validador duas vezes sem reiniciar dá falsos negativos, porque a agenda já foi alterada.

**Comportamentos observados, sem defeito**
- Um `requestState` inválido volta como HTTP 200 com -32602, enquanto `_meta` ausente volta como 400. É o comportamento do SDK 2.4.0, e o validador confere só o código.
- A chave de `inputRequests` é `escolha_de_sala`, enquanto o exemplo 03 mostra `__main__:escolha_de_sala`. O exemplo diz que a chave é atribuída pelo servidor e que o cliente devolve a mesma, e o agente nunca presume o nome. O validador e o fluxo manual passam com ela.
- A url do Agent Card é `http://localhost:7300/a2a`; o exemplo usa `127.0.0.1`. É configurável por `A2A_PUBLIC_URL`, e o validador aceita.
- Uma continuação abandonada fica na memória do agente até o restart. Ela não vaza e o servidor a recusa depois do TTL.

**Problemas não resolvidos.** Nenhum.

**Fora do escopo** (proibidos ou não pedidos): LLM, banco de dados, ORM, Docker, streaming/SSE, push notifications, autenticação, gateway, OpenTelemetry completo, persistência de Tasks, `CancelTask`/`ListTasks`, card estendido.

## 10. Conclusão

As evidências necessárias foram coletadas e todas foram aprovadas:
- **Validador oficial:** 36 de 36 verificações, com código de saída 0, contra processos recém-iniciados.
- **Testes automatizados:** 279 de 279.
- **Roteiro manual do avaliador:** 66 de 66 itens.
- **Arquivos protegidos:** idênticos ao starter `263f17e`.

**A implementação está em conformidade integral com o desafio.**

Esta conclusão vale para o commit `b3625c1` com o ambiente descrito na seção 2. Qualquer mudança de código pede uma nova execução do validador e do roteiro.
