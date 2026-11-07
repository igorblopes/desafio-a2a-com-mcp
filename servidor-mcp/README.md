# servidor-mcp

Servidor MCP da Central de Salas: Streamable HTTP, revisão `2026-07-28`, sem sessão. Cada request carrega no `_meta` a própria versão e as próprias capabilities, e o servidor responde sempre em JSON (nunca SSE).

> **Estado atual (Passo 4):** existem a tool `listar_salas` e o resource `politica://uso`. `consultar_disponibilidade`, `reservar_sala` e o MRTR entram nos próximos passos.

## Pré-requisito

- Node.js **22 ou superior** (`node -v`).

## Como rodar

```powershell
cd servidor-mcp
npm ci          # instala exatamente as versões do package-lock.json
npm start       # escuta em http://localhost:7301/mcp; logs no stderr
```

Outros scripts:

| Comando | O que faz |
|---|---|
| `npm run dev` | Sobe com `tsx watch`, reiniciando a cada alteração em `src/` |
| `npm run check` | Checagem de tipos (`tsc --noEmit`), sem gerar arquivos |
| `npm test` | Testes de contrato (`node:test`), sem precisar de servidor no ar |

## Variáveis de ambiente

| Variável | Padrão | Uso |
|---|---|---|
| `MCP_PORT` | `7301` | Porta HTTP |
| `DADOS_DIR` | `../dados` (relativo a `servidor-mcp/`) | Pasta com `salas.json` e `politica-de-uso.md` |

Exemplo, no PowerShell: `$env:MCP_PORT = '7401'; npm start`.

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
| `pronto` | O servidor subiu | `[mcp] pronto url=http://localhost:7301/mcp salas=5 protocolo=2026-07-28` |
| `recv` | Todo request recebido, **antes** do SDK (inclusive os que serão rejeitados) | `[mcp] recv method=tools/call id=2 name=listar_salas traceparent=00-4bf9…-01` |
| `rejeitado` | O SDK recusou o request por protocolo (`_meta` incompleto, header divergente…) | `[mcp] rejeitado tipo=Error mensagem="Rejected inbound request (envelope-invalid): …"` |
| `erro` | Falha interna inesperada | `[mcp] erro tipo=… mensagem=…` |

Ao subir, também aparece este aviso do SDK, que é **esperado**:

```
responseMode: 'json' drops mid-call notifications. subscriptions/listen streams are always served over SSE regardless; other notifications emitted before a result are dropped.
```

Ele avisa que notificações enviadas no meio de uma chamada são descartadas no modo JSON. Não usamos notificações desse tipo.

## Arquivos

| Arquivo | Responsabilidade |
|---|---|
| `src/main.ts` | Borda HTTP (`node:http`): valida o Host, registra cada request no stderr, entrega ao `createMcpHandler` do SDK e repassa a resposta em streaming |
| `src/config.ts` | Lê `MCP_PORT` e `DADOS_DIR` uma única vez |
| `src/log.ts` | Log de uma linha no stderr |
| `src/servidor.ts` | Factory do `McpServer` (uma instância por request, por isso stateless) e tratamento do `onerror` |
| `src/tools/listar-salas.ts` | Tool `listar_salas`: `structuredContent` conforme o `outputSchema` e o mesmo JSON em texto |
| `src/dominio/agenda.ts` | Carrega e valida `dados/salas.json` uma vez (singleton de módulo) |
| `src/recursos/politica.ts` | Resource `politica://uso`: lê `dados/politica-de-uso.md` uma vez e o serve sem transformação (`text/markdown`) |
| `test/contrato.test.ts` | Testes de contrato (`npm test`): sobe o servidor numa porta livre e faz requests HTTP reais |

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

Os testes sobem o próprio servidor numa porta livre e fazem requests HTTP reais, iguais aos do validador. Não é preciso ter outro servidor no ar. Eles cobrem `tools/list`, `listar_salas`, `resources/list`, `resources/read`, a URI inexistente, o `_meta` obrigatório, a consistência dos headers e os logs no stderr.
