# servidor-mcp

Servidor MCP da Central de Salas: Streamable HTTP, revisão `2026-07-28`, sem sessão. Cada request carrega no `_meta` a própria versão e as próprias capabilities, e o servidor responde sempre em JSON (nunca SSE).

> **Estado atual (Passo 7):** tools `listar_salas`, `consultar_disponibilidade` e `reservar_sala` com o ciclo MRTR completo (conflito → `input_required` com elicitation em form mode → retry com `inputResponses` + `requestState` assinado), e o resource `politica://uso`. O agente A2A ainda não existe.

## Pré-requisito

- Node.js **22 ou superior** (`node -v`).

## Como rodar

```powershell
cd servidor-mcp
npm ci          # instala exatamente as versões do package-lock.json
# uma vez só: gere o .env com REQUEST_STATE_SECRET (veja "Segredo do requestState")
npm start       # escuta em http://localhost:7301/mcp; logs no stderr
```

Outros scripts:

| Comando | O que faz |
|---|---|
| `npm run dev` | Sobe com `tsx watch`, reiniciando a cada alteração em `src/` |
| `npm run check` | Checagem de tipos (`tsc --noEmit`), sem gerar arquivos |
| `npm test` | Testes unitários, de contrato e de MRTR (`node:test`), sem precisar de servidor no ar nem do `.env` |

## Variáveis de ambiente

| Variável | Padrão | Uso |
|---|---|---|
| `MCP_PORT` | `7301` | Porta HTTP |
| `DADOS_DIR` | `../dados` (relativo a `servidor-mcp/`) | Pasta com `salas.json`, `reservas.json` e `politica-de-uso.md` |
| `REQUEST_STATE_SECRET` | — (**obrigatória**) | Chave HMAC do `requestState`: hex com pelo menos 64 dígitos (32 bytes). O processo não sobe sem ela |
| `REQUEST_STATE_TTL_SECONDS` | `900` (15 min) | Validade de um `requestState` emitido; aceita de 300 a 1800 |

Exemplo, no PowerShell: `$env:MCP_PORT = '7401'; npm start`.

### Segredo do requestState

Gere o segredo uma vez, direto no arquivo `servidor-mcp/.env`, sem que o valor passe pelo terminal:

```powershell
cd servidor-mcp
python -c "import secrets, pathlib; pathlib.Path('.env').write_text('REQUEST_STATE_SECRET=' + secrets.token_hex(32) + '\n')"
```

- O `.env` é ignorado pelo git (`.gitignore` da raiz). Nunca commite o valor.
- `npm start` e `npm run dev` leem o `.env` sozinhos (`tsx --env-file-if-exists=.env`). Uma variável já definida no ambiente prevalece sobre o arquivo.
- É esse mesmo segredo que permite **retomar** um pedido depois de reiniciar o servidor: um `requestState` emitido antes do restart continua válido depois dele, desde que o `.env` não mude.
- O arquivo é escrito pelo Python, e não com `>`, porque o `>` do PowerShell 5.1 grava em UTF-16, que o Node não lê como `.env`. No bash, use `python3`.

## Exemplos de request (PowerShell)

Todo request precisa:

- dos headers `MCP-Protocol-Version`, `Mcp-Method` e, em `tools/call`, `Mcp-Name`, que espelham o corpo;
- no corpo, de `params._meta` com `io.modelcontextprotocol/protocolVersion` e `io.modelcontextprotocol/clientCapabilities`. O `traceparent` é opcional e aparece no log.

Os exemplos funcionam no Windows PowerShell 5.1 e no PowerShell 7.

```powershell
$url  = 'http://localhost:7301/mcp'
$meta = @{
  'io.modelcontextprotocol/protocolVersion'    = '2026-07-28'
  'io.modelcontextprotocol/clientCapabilities' = @{ elicitation = @{ form = @{} } }
  'traceparent' = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
}

# tools/list
$corpo = @{ jsonrpc = '2.0'; id = 1; method = 'tools/list'; params = @{ _meta = $meta } } | ConvertTo-Json -Depth 10
$h = @{ 'Accept' = 'application/json, text/event-stream'; 'MCP-Protocol-Version' = '2026-07-28'; 'Mcp-Method' = 'tools/list' }
$r = Invoke-RestMethod -Uri $url -Method Post -ContentType 'application/json' -Headers $h -Body $corpo
$r.result.tools | Select-Object name, description

# tools/call listar_salas
$corpo = @{ jsonrpc = '2.0'; id = 2; method = 'tools/call'
            params = @{ name = 'listar_salas'; arguments = @{}; _meta = $meta } } | ConvertTo-Json -Depth 10
$h = @{ 'Accept' = 'application/json, text/event-stream'; 'MCP-Protocol-Version' = '2026-07-28'
        'Mcp-Method' = 'tools/call'; 'Mcp-Name' = 'listar_salas' }
$r = Invoke-RestMethod -Uri $url -Method Post -ContentType 'application/json' -Headers $h -Body $corpo
$r.result.resultType                       # complete
$r.result.structuredContent.salas | Format-Table
```

Para ver uma rejeição de protocolo (HTTP 400 + `-32602`), remova `io.modelcontextprotocol/protocolVersion` do `$meta`. No PowerShell 5.1, o `Invoke-RestMethod` lança exceção em respostas 4xx, e o corpo precisa ser lido do stream da resposta:

```powershell
$meta.Remove('io.modelcontextprotocol/protocolVersion')
$corpo = @{ jsonrpc = '2.0'; id = 3; method = 'tools/list'; params = @{ _meta = $meta } } | ConvertTo-Json -Depth 10
$h = @{ 'Accept' = 'application/json, text/event-stream'; 'MCP-Protocol-Version' = '2026-07-28'; 'Mcp-Method' = 'tools/list' }
try {
  Invoke-RestMethod -Uri $url -Method Post -ContentType 'application/json' -Headers $h -Body $corpo
} catch {
  'HTTP ' + [int]$_.Exception.Response.StatusCode                 # HTTP 400
  $s = $_.Exception.Response.GetResponseStream(); $s.Position = 0
  (New-Object System.IO.StreamReader($s)).ReadToEnd()              # {"jsonrpc":"2.0","error":{"code":-32602,...}}
}
```

No PowerShell 7 é mais simples: acrescente `-SkipHttpErrorCheck -StatusCodeVariable st` ao `Invoke-RestMethod`, e o corpo do erro volta como resultado normal.

## Logs (stderr)

Uma linha por evento, prefixada por `[mcp]`:

| Evento | Quando | Exemplo |
|---|---|---|
| `pronto` | O servidor subiu | `[mcp] pronto url=http://localhost:7301/mcp salas=5 reservas=2 politica="versao: 2026-11-01" protocolo=2026-07-28` |
| `recv` | Todo request recebido, **antes** do SDK (inclusive os que serão rejeitados) | `[mcp] recv method=tools/call id=2 name=listar_salas traceparent=00-4bf9…-01` |
| `rejeitado` | O SDK recusou o request por protocolo (`_meta` incompleto, header divergente…) | `[mcp] rejeitado tipo=Error mensagem="Rejected inbound request (envelope-invalid): …"` |
| `mrtr` (conflito) | `reservar_sala` encontrou conflito e vai pedir input | `[mcp] mrtr evento=conflito id=40 chave=escolha_de_sala alternativas=sala-fusca,sala-mirante` |
| `mrtr` (retry) | Chegou o retry com `requestState` válido | `[mcp] mrtr evento=retry id=41 resultado=accept escolha=sala-fusca` |
| `rejeitado` (requestState) | O `requestState` falhou na verificação (MAC, expirado, malformado) e o request recebeu `-32602` | `[mcp] rejeitado tipo=Error mensagem="requestState verification rejected tools/call: mac"` |
| `erro` | Falha interna inesperada | `[mcp] erro tipo=… mensagem=…` |

O `requestState` (nem um pedaço dele) e o `REQUEST_STATE_SECRET` nunca aparecem no log: do retry só vão o id, o resultado e a escolha, e de uma recusa só o código opaco do codec (`mac`, `expired`, `malformed`). O `evento=conflito` sai antes da checagem de capability; se o cliente não declarou `elicitation.form`, a resposta vira `-32021` mesmo assim.

Ao subir, também aparece este aviso do SDK, que é **esperado**:

```
responseMode: 'json' drops mid-call notifications. subscriptions/listen streams are always served over SSE regardless; other notifications emitted before a result are dropped.
```

Ele avisa que notificações enviadas no meio de uma chamada são descartadas no modo JSON. Não usamos notificações desse tipo.

## Arquivos

| Arquivo | Responsabilidade |
|---|---|
| `src/main.ts` | Borda HTTP (`node:http`): valida o Host, registra cada request no stderr, entrega ao `createMcpHandler` do SDK e repassa a resposta em streaming |
| `src/config.ts` | Lê `MCP_PORT`, `DADOS_DIR`, `REQUEST_STATE_TTL_SECONDS` e, sob demanda, `REQUEST_STATE_SECRET` (validada sem nunca expor o valor) |
| `src/log.ts` | Log de uma linha no stderr |
| `src/servidor.ts` | Factory do `McpServer` (uma instância por request, por isso stateless), `requestState.verify` e tratamento do `onerror` |
| `src/estado-mrtr.ts` | `requestState` assinado (HMAC do SDK, 15 min): selo do pedido interrompido |
| `src/tools/listar-salas.ts` | Tool `listar_salas`: `structuredContent` conforme o `outputSchema` e o mesmo JSON em texto |
| `src/tools/consultar-disponibilidade.ts` | Tool `consultar_disponibilidade`: `{ sala, livre, conflitos }` ou `isError` com a mensagem da regra |
| `src/tools/reservar-sala.ts` | Tool `reservar_sala`: caminho feliz e MRTR (alternativas, input_required, retry accept/decline/cancel) |
| `src/recursos/politica.ts` | Resource `politica://uso`: lê `dados/politica-de-uso.md` uma vez e o serve sem transformação (`text/markdown`); extrai a versão da primeira linha (`versaoDaPolitica`) |
| `src/dominio/agenda.ts` | Carrega `salas.json` e `reservas.json` uma vez; agenda em memória compartilhada pelas tools, com `adicionarReserva` e ids `res-NNNN` |
| `src/dominio/regras.ts` | Regras de negócio puras: sala, intervalo, janela 08:00–20:00 (UTC−03:00), duração ≤ 2h, conflito `[inicio, fim)` e `alternativas` (capacidade ≥, livres, ordenadas, no máximo 3), com as mensagens exatas |
| `test/regras.test.ts` | Testes unitários das regras e das alternativas |
| `test/agenda.test.ts` | Testes unitários da agenda, dos ids e da versão da política |
| `test/estado-mrtr.test.ts` | Testes unitários do `requestState` (MAC, adulteração, expiração com relógio simulado) e do segredo |
| `test/contrato.test.ts` | Testes de contrato (`npm test`): sobe o servidor numa porta livre e faz requests HTTP reais |
| `test/mrtr.test.ts` | MRTR por HTTP contra o processo real: conflito, retry, capabilities, `requestState` adulterado/expirado/forjado e restart |

## consultar_disponibilidade (Passo 5)

Recebe `sala`, `inicio` e `fim`, com as datas em ISO 8601 **com offset** (`-03:00` ou `Z`), e responde `{ sala, livre, conflitos }` em `structuredContent` e o mesmo JSON em texto. A consulta não altera a agenda. Um pedido que viola uma regra (sala inexistente, janela de 08:00 a 20:00, duração acima de 2h, fim não posterior ao início) volta em HTTP 200 como resultado normal, com `isError: true` e a mensagem exata em `content[0].text`. Data sem offset é recusada pelo `inputSchema`.

Os exemplos reaproveitam o `$url` e o `$meta` definidos em "Exemplos de request" acima.

```powershell
function Consultar($sala, $inicio, $fim) {
  $corpo = @{ jsonrpc = '2.0'; id = 20; method = 'tools/call'
              params = @{ name = 'consultar_disponibilidade'; arguments = @{ sala = $sala; inicio = $inicio; fim = $fim }; _meta = $meta } } |
           ConvertTo-Json -Depth 10
  $h = @{ 'Accept' = 'application/json, text/event-stream'; 'MCP-Protocol-Version' = '2026-07-28'
          'Mcp-Method' = 'tools/call'; 'Mcp-Name' = 'consultar_disponibilidade' }
  (Invoke-RestMethod -Uri $url -Method Post -ContentType 'application/json' -Headers $h -Body $corpo).result
}

# sala livre
(Consultar 'sala-aquario' '2026-11-03T09:00:00-03:00' '2026-11-03T10:00:00-03:00').structuredContent | ConvertTo-Json -Compress
# {"sala":"sala-aquario","livre":true,"conflitos":[]}

# sala ocupada (res-0001, de dados/reservas.json)
(Consultar 'sala-garagem' '2026-11-03T14:00:00-03:00' '2026-11-03T15:00:00-03:00').structuredContent | ConvertTo-Json -Compress -Depth 5
# {"sala":"sala-garagem","livre":false,"conflitos":[{"id":"res-0001","inicio":"2026-11-03T14:00:00-03:00","fim":"2026-11-03T15:00:00-03:00","responsavel":"Marty"}]}

# regra violada: erro de execução (isError), não erro JSON-RPC
$r = Consultar 'sala-inexistente' '2026-11-03T09:00:00-03:00' '2026-11-03T10:00:00-03:00'
"isError=$($r.isError) texto=$($r.content[0].text)"
# isError=True texto=Sala inexistente: sala-inexistente
```

## reservar_sala (Passos 6 e 7)

Recebe `sala`, `inicio`, `fim` (ISO 8601 com offset) e `responsavel`, os quatro obrigatórios, e aplica as mesmas regras de `consultar_disponibilidade`, com as mesmas mensagens de erro. Com o intervalo livre, grava a reserva na agenda em memória e responde `ReservaOut` com as oito chaves sempre presentes: `reserva`, `reservado`, `sala`, `inicio`, `fim`, `responsavel`, `politica` (a versão lida de `politica-de-uso.md`) e `motivo`. A reserva aparece nas consultas seguintes até o processo reiniciar; `dados/reservas.json` nunca é reescrito. Os ids seguem o padrão do starter: num processo novo, a primeira reserva é `res-0003`. Com a sala ocupada, a tool pergunta qual alternativa usar (MRTR, abaixo).

Os exemplos reaproveitam o `$url` e o `$meta` de "Exemplos de request" e a função `Consultar` da seção anterior. As saídas abaixo são de um servidor recém-iniciado.

```powershell
function Reservar($sala, $inicio, $fim, $responsavel) {
  $corpo = @{ jsonrpc = '2.0'; id = 30; method = 'tools/call'
              params = @{ name = 'reservar_sala'; arguments = @{ sala = $sala; inicio = $inicio; fim = $fim; responsavel = $responsavel }; _meta = $meta } } |
           ConvertTo-Json -Depth 10
  $h = @{ 'Accept' = 'application/json, text/event-stream'; 'MCP-Protocol-Version' = '2026-07-28'
          'Mcp-Method' = 'tools/call'; 'Mcp-Name' = 'reservar_sala' }
  (Invoke-RestMethod -Uri $url -Method Post -ContentType 'application/json' -Headers $h -Body $corpo).result
}

# reserva válida
$r = Reservar 'sala-aquario' '2026-11-03T10:00:00-03:00' '2026-11-03T11:00:00-03:00' 'Marty'
"resultType=$($r.resultType) isError=$($r.isError)"
# resultType=complete isError=False
$r.structuredContent | ConvertTo-Json -Compress
# {"reserva":"res-0003","reservado":true,"sala":"sala-aquario","inicio":"2026-11-03T10:00:00-03:00","fim":"2026-11-03T11:00:00-03:00","responsavel":"Marty","politica":"2026-11-01","motivo":null}

# a consulta seguinte já enxerga a reserva
(Consultar 'sala-aquario' '2026-11-03T10:00:00-03:00' '2026-11-03T11:00:00-03:00').structuredContent | ConvertTo-Json -Compress -Depth 5
# {"sala":"sala-aquario","livre":false,"conflitos":[{"id":"res-0003","inicio":"2026-11-03T10:00:00-03:00","fim":"2026-11-03T11:00:00-03:00","responsavel":"Marty"}]}
```

### Conflito e MRTR (Passo 7)

Quando a sala pedida está ocupada, `reservar_sala` **não** fica esperando: o request termina com `resultType: "input_required"`, uma elicitation em form mode (`inputRequests`, uma chave só, com o `enum` das alternativas) e um `requestState` assinado. O cliente responde num `tools/call` **novo** (id JSON-RPC diferente), com os mesmos `name`/`arguments`, mais `inputResponses` (na mesma chave) e o `requestState` ecoado sem mudanças. No retry, o pedido sai do `requestState`, e não dos `arguments`. `decline` ou `cancel` concluem sem reservar e sem `isError`. Sem nenhuma alternativa, a resposta é `isError` com `Sem alternativas disponiveis no intervalo`. O cliente precisa declarar `elicitation.form` em `clientCapabilities`, senão recebe HTTP 400 `-32021`.

Os exemplos reaproveitam o `$url` e o `$meta` de "Exemplos de request". As saídas abaixo são de um servidor recém-iniciado, antes de qualquer outra reserva.

```powershell
function ChamarReserva($id, $arguments, $inputResponses, $requestState) {
  $params = @{ name = 'reservar_sala'; arguments = $arguments; _meta = $meta }
  if ($inputResponses) { $params.inputResponses = $inputResponses }
  if ($requestState)   { $params.requestState = $requestState }
  $corpo = @{ jsonrpc = '2.0'; id = $id; method = 'tools/call'; params = $params } | ConvertTo-Json -Depth 10
  $h = @{ 'Accept' = 'application/json, text/event-stream'; 'MCP-Protocol-Version' = '2026-07-28'
          'Mcp-Method' = 'tools/call'; 'Mcp-Name' = 'reservar_sala' }
  (Invoke-RestMethod -Uri $url -Method Post -ContentType 'application/json' -Headers $h -Body $corpo).result
}
$pedido = @{ sala = 'sala-garagem'; inicio = '2026-11-03T14:00:00-03:00'; fim = '2026-11-03T15:00:00-03:00'; responsavel = 'Marty' }

# 1) conflito (garagem 14–15 já tem res-0001) → input_required
$r1 = ChamarReserva 40 $pedido
$chave = @($r1.inputRequests.PSObject.Properties.Name)[0]
$el = $r1.inputRequests.$chave
"resultType=$($r1.resultType) chave=$chave method=$($el.method) mode=$($el.params.mode)"
# resultType=input_required chave=escolha_de_sala method=elicitation/create mode=form
"enum=" + ($el.params.requestedSchema.properties.sala.enum -join ', ')
# enum=sala-fusca, sala-mirante
$r1.requestState.Substring(0, 3)
# v1.

# 2) retry com id NOVO: mesmos arguments + inputResponses na mesma chave + requestState ecoado
$r2 = ChamarReserva 41 $pedido @{ $chave = @{ action = 'accept'; content = @{ sala = 'sala-fusca' } } } $r1.requestState
"resultType=$($r2.resultType) isError=$($r2.isError)"
# resultType=complete isError=False
$r2.structuredContent | ConvertTo-Json -Compress
# {"reserva":"res-0003","reservado":true,"sala":"sala-fusca","inicio":"2026-11-03T14:00:00-03:00","fim":"2026-11-03T15:00:00-03:00","responsavel":"Marty","politica":"2026-11-01","motivo":null}

# 3) mesmo pedido de novo: agora só sobra o mirante; o usuário recusa
$r3 = ChamarReserva 42 $pedido
"enum=" + ($r3.inputRequests.$chave.params.requestedSchema.properties.sala.enum -join ', ')
# enum=sala-mirante
$r4 = ChamarReserva 43 $pedido @{ $chave = @{ action = 'decline' } } $r3.requestState
"resultType=$($r4.resultType) isError=$($r4.isError)"
# resultType=complete isError=False
$r4.structuredContent | ConvertTo-Json -Compress
# {"reserva":null,"reservado":false,"sala":null,"inicio":null,"fim":null,"responsavel":null,"politica":null,"motivo":"recusado"}
```

No log do servidor, os dois requests do mesmo pedido aparecem com ids diferentes:

```
[mcp] mrtr evento=conflito id=40 chave=escolha_de_sala alternativas=sala-fusca,sala-mirante
[mcp] mrtr evento=retry id=41 resultado=accept escolha=sala-fusca
```

## Resources (Passo 4)

O servidor expõe um resource, `politica://uso` (`text/markdown`), com o conteúdo integral de `dados/politica-de-uso.md`. O arquivo é lido uma vez ao subir. Em `resources/read`, o header `Mcp-Name` é obrigatório e precisa ser igual à URI. Uma URI que não existe recebe o erro `-32602`, nunca `contents` vazio.

Os exemplos reaproveitam o `$url` e o `$meta` definidos em "Exemplos de request" acima.

```powershell
# resources/list
$corpo = @{ jsonrpc = '2.0'; id = 10; method = 'resources/list'; params = @{ _meta = $meta } } | ConvertTo-Json -Depth 10
$h = @{ 'Accept' = 'application/json, text/event-stream'; 'MCP-Protocol-Version' = '2026-07-28'; 'Mcp-Method' = 'resources/list' }
$r = Invoke-RestMethod -Uri $url -Method Post -ContentType 'application/json' -Headers $h -Body $corpo
$r.result.resources | Select-Object uri, name, mimeType   # politica://uso  politica-de-uso  text/markdown

# resources/read politica://uso (Mcp-Name igual à URI)
$corpo = @{ jsonrpc = '2.0'; id = 11; method = 'resources/read'
            params = @{ uri = 'politica://uso'; _meta = $meta } } | ConvertTo-Json -Depth 10
$h = @{ 'Accept' = 'application/json, text/event-stream'; 'MCP-Protocol-Version' = '2026-07-28'
        'Mcp-Method' = 'resources/read'; 'Mcp-Name' = 'politica://uso' }
$r = Invoke-RestMethod -Uri $url -Method Post -ContentType 'application/json' -Headers $h -Body $corpo
$r.result.contents[0].mimeType                            # text/markdown
$r.result.contents[0].text                                # versao: 2026-11-01 ... (o arquivo inteiro)

# resources/read de URI inexistente: erro JSON-RPC -32602 (com HTTP 200, por isso não lança exceção)
$corpo = @{ jsonrpc = '2.0'; id = 12; method = 'resources/read'
            params = @{ uri = 'politica://inexistente'; _meta = $meta } } | ConvertTo-Json -Depth 10
$h['Mcp-Name'] = 'politica://inexistente'
$r = Invoke-RestMethod -Uri $url -Method Post -ContentType 'application/json' -Headers $h -Body $corpo
$r.error | ConvertTo-Json -Compress
# {"code":-32602,"message":"Resource not found: politica://inexistente","data":{"uri":"politica://inexistente"}}
```

No PowerShell 5.1, textos com acento nas respostas (como o `title` "Política de uso das salas" do `resources/list`) podem aparecer como `PolÃ­tica`. O servidor envia UTF-8; é o `Invoke-RestMethod` do 5.1 que decodifica como Latin-1 quando o `Content-Type` não traz `charset`. O conteúdo da política é ASCII e não é afetado.

## Testes automatizados

```powershell
npm test
```

Cinco arquivos (135 testes), executados juntos pelo `node:test`, sem precisar de servidor no ar nem do `.env`: os testes geram um `REQUEST_STATE_SECRET` aleatório a cada execução. `test/regras.test.ts` testa as regras de negócio como funções puras: sala, intervalo, janela, duração, sobreposição, offsets, independência do fuso da máquina e cálculo das alternativas. `test/estado-mrtr.test.ts` testa o `requestState`: ida e volta, adulteração, outra chave, expiração com relógio simulado, selo de outra versão ou ferramenta e a validação do segredo. `test/mrtr.test.ts` sobe o servidor real (e o reinicia) e percorre o MRTR por HTTP: `input_required`, alternativas, capabilities, retry accept/decline/cancel, argumentos adulterados, escolha fora do enum, `requestState` adulterado, expirado e forjado, e a retomada depois do restart. `test/agenda.test.ts` testa a agenda em memória: ids `res-NNNN`, gravação e visibilidade das reservas, pedidos inválidos que não gravam, `dados/reservas.json` intocado e a extração da versão da política (LF e CRLF). `test/contrato.test.ts` sobe o próprio servidor numa porta livre e faz requests HTTP reais, iguais aos do validador: `tools/list`, `listar_salas`, `consultar_disponibilidade` (livre, ocupada e os quatro erros de execução), `reservar_sala` (reserva válida visível na consulta seguinte, ids sequenciais, os quatro erros, reinício do processo e versão da política vinda de `DADOS_DIR`), `resources/list`, `resources/read`, URI inexistente, `_meta` obrigatório, consistência dos headers e logs no stderr.
