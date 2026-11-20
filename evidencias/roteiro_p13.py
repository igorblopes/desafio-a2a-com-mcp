# Roteiro de validacao manual do Passo 13 (fluxo do avaliador), so com a biblioteca padrao.
#
# Cada cenario faz requests HTTP reais contra os DOIS processos e imprime PASS/FAIL
# com a evidencia. Nenhum requestState e impresso inteiro (so tamanho e prefixo), e o
# segredo nunca e lido para impressao: o script so confere se ele NAO aparece.
#
# Uso (na raiz do repositorio, com os processos recem-iniciados):
#   python evidencias/roteiro_p13.py logs    --log-mcp <stderr do MCP> --trace-id <id impresso pelo validador>
#   python evidencias/roteiro_p13.py manual  --log-mcp <stderr do MCP> --estado <arquivo temporario>
#   (reinicie SO o servidor MCP, com o mesmo REQUEST_STATE_SECRET)
#   python evidencias/roteiro_p13.py restart --estado <arquivo temporario>
#
# Codigo de saida: 0 se todos os itens passaram, 1 se algum falhou.
import argparse, json, pathlib, re, secrets, sys, time, urllib.error, urllib.request

RAIZ = pathlib.Path(__file__).resolve().parent.parent
WIRE = RAIZ / 'exemplos' / 'wire'
AGENTE = 'http://localhost:7300'
MCP = 'http://localhost:7301/mcp'
falhas: list[str] = []
publico: list[str] = []  # tudo o que o cliente A2A viu, para a checagem de vazamento


def ok(item, cond, evidencia=''):
    print(('PASS ' if cond else 'FAIL ') + item + (f'  [{evidencia}]' if evidencia != '' else ''))
    if not cond:
        falhas.append(item)


def exemplo(nome):
    return json.loads((WIRE / nome).read_text(encoding='utf-8'))


def post(url, corpo, headers):
    req = urllib.request.Request(url, data=json.dumps(corpo).encode(), headers=headers, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b'{}')


def novo_trace():
    tid = secrets.token_hex(16)
    return tid, f'00-{tid}-{secrets.token_hex(8)}-01'


def mcp_wire(nome_exemplo, *, id_=None, trocar=None):
    """Envia o request de um exemplo oficial, com o mesmo envelope, headers e _meta."""
    req = exemplo(nome_exemplo)['request']
    corpo = json.loads(json.dumps(req['body']))
    corpo['id'] = id_ if id_ is not None else secrets.randbelow(10**6)
    if trocar:
        trocar(corpo['params'])
    return post(MCP, corpo, req['headers'])


def resumo_estado(rs):
    return f'requestState de {len(rs)} caracteres, prefixo {rs[:3]!r}' if isinstance(rs, str) else 'sem requestState'


# ---------- A2A, no envelope de exemplos/wire/08 e 10 ----------

def enviar(texto, task_id=None, trace=None):
    req = exemplo('08-a2a-send-message.json')['request']
    corpo = json.loads(json.dumps(req['body']))
    corpo['id'] = secrets.randbelow(10**6)
    corpo['params']['message']['messageId'] = 'msg-' + secrets.token_hex(6)
    corpo['params']['message']['parts'] = [{'text': texto}]
    if task_id:
        corpo['params']['message']['taskId'] = task_id
    headers = dict(req['headers'])
    if trace:
        headers['traceparent'] = trace
    else:
        headers.pop('traceparent', None)
    st, c = post(AGENTE + '/a2a', corpo, headers)
    publico.append(json.dumps(c))
    return corpo['id'], st, c


def get_task(task_id):
    rid = secrets.randbelow(10**6)
    st, c = post(AGENTE + '/a2a', {'jsonrpc': '2.0', 'id': rid, 'method': 'GetTask', 'params': {'id': task_id}}, {'Content-Type': 'application/json'})
    publico.append(json.dumps(c))
    return rid, c


def task(c):
    r = c.get('result') or {}
    return r.get('task') or r


def estado(c):
    return (task(c).get('status') or {}).get('state')


def texto(c):
    return ''.join(p.get('text', '') for p in ((task(c).get('status') or {}).get('message') or {}).get('parts', []))


def artifact_reserva(t):
    for a in t.get('artifacts') or []:
        if a.get('name') == 'reserva':
            return json.loads(''.join(p.get('text', '') for p in a.get('parts', [])))
    return None


def h(dia, hora):
    return f'2026-11-{dia}T{hora}:00-03:00'


def pedido(sala, dia, ini, fim, resp):
    return f'reservar sala={sala} inicio={h(dia, ini)} fim={h(dia, fim)} responsavel={resp}'


def livre(sala, dia, ini, fim):
    """consultar_disponibilidade no envelope do exemplo 02 (so troca a tool e o Mcp-Name)."""
    req = exemplo('02-tools-call-livre.json')['request']
    hdr = dict(req['headers']); hdr['Mcp-Name'] = 'consultar_disponibilidade'
    corpo = json.loads(json.dumps(req['body'])); corpo['id'] = secrets.randbelow(10**6)
    corpo['params'].update(name='consultar_disponibilidade', arguments={'sala': sala, 'inicio': h(dia, ini), 'fim': h(dia, fim)})
    st, c = post(MCP, corpo, hdr)
    return ((c.get('result') or {}).get('structuredContent') or {}).get('livre')


# ---------- log do MCP ----------

LINHA = re.compile(r'method=(\S+) id=(\S+) name=(\S+) traceparent=(\S+)')


def recv(log, trace_id=None):
    linhas = []
    for l in pathlib.Path(log).read_text(encoding='utf-8', errors='replace').splitlines():
        m = LINHA.search(l) if '[mcp] recv' in l else None
        if m and (trace_id is None or trace_id in m.group(4)):
            linhas.append({'linha': l.strip(), 'metodo': m.group(1), 'id': m.group(2), 'nome': m.group(3), 'trace': m.group(4)})
    return linhas


def segredo_do_env():
    env = RAIZ / 'servidor-mcp' / '.env'
    if not env.exists():
        return None
    for l in env.read_text(encoding='utf-8').splitlines():
        if l.startswith('REQUEST_STATE_SECRET='):
            return l.split('=', 1)[1].strip().strip('"')
    return None


# ================= fases =================

def fase_logs(a):
    print(f'== Auditoria do log do MCP para o trace-id {a.trace_id}')
    todas = recv(a.log_mcp)
    do_trace = [x for x in todas if x['trace'].split('-')[1:2] == [a.trace_id]]
    ok('L1 existem requests MCP com o trace-id do validador', len(do_trace) > 0, f'{len(do_trace)} linhas')
    for x in do_trace:
        print('   ' + x['linha'])
    # O validador tambem manda tools/call direto ao MCP com esse trace (ids texto, entre aspas).
    # Os requests do AGENTE sao os de id numerico (contador do cliente MCP do agente).
    agente = [x for x in do_trace if x['id'].isdigit()]
    calls = [x for x in agente if x['metodo'] == 'tools/call']
    ok('L2 descoberta: o primeiro request do agente no trace e tools/list, antes de qualquer tools/call', bool(agente) and agente[0]['metodo'] == 'tools/list' and agente.index(calls[0]) > 0,
       ' -> '.join(f"{x['metodo']}#{x['id']}" for x in agente))
    ids = [x['id'] for x in calls]
    ok('L3 tools/call do agente (pedido, pausa e retry) com ids JSON-RPC todos diferentes', len(ids) >= 3 and len(set(ids)) == len(ids), f'ids={ids}')
    spans = [x['trace'].split('-')[2] for x in do_trace]
    ok('L4 cada request do trace tem span proprio (parent-id)', len(set(spans)) == len(spans), f'{len(set(spans))} spans para {len(spans)} requests')
    sem = [x for x in todas if not x['id']]
    ok('L5 toda linha recv registra metodo e id', len(todas) > 0 and not sem, f'{len(todas)} linhas recv')


def fase_manual(a):
    seg = segredo_do_env()
    # ---- Agent Card ----
    print('== T6 Agent Card x exemplos/wire/07')
    with urllib.request.urlopen(AGENTE + '/.well-known/agent-card.json', timeout=10) as r:
        st_card, bruto = r.status, r.read()
    card = json.loads(bruto)
    publico.append(bruto.decode())
    esperado = exemplo('07-a2a-agent-card.json')['response']['body']
    ok('C1 HTTP 200 em /.well-known/agent-card.json', st_card == 200, st_card)
    for campo in ['name', 'description', 'provider', 'version', 'capabilities', 'defaultInputModes', 'defaultOutputModes', 'skills']:
        ok(f'C2 campo {campo} igual ao exemplo 07', card.get(campo) == esperado.get(campo), json.dumps(card.get(campo), ensure_ascii=False)[:90])
    itf = card.get('supportedInterfaces') or []
    ok('C3 interface JSONRPC 1.0 com url terminando em /a2a', len(itf) == 1 and itf[0].get('protocolBinding') == 'JSONRPC' and itf[0].get('protocolVersion') == '1.0' and itf[0].get('url', '').endswith(':7300/a2a'), json.dumps(itf))
    ok('C4 so os campos do exemplo (nenhum campo extra)', set(card) == set(esperado), sorted(set(card) ^ set(esperado)))

    # ---- T8 pausa ----
    print('== T8 Pausa: pedido oficial de conflito (envelope do exemplo 08)')
    tid_a, tp_a = novo_trace()
    rid, st, c = enviar(pedido('sala-garagem', '03', '14:00', '15:00', 'Marty'), trace=tp_a)
    t = task(c)
    ok('P1 HTTP 200 e id JSON-RPC devolvido igual', st == 200 and c.get('id') == rid, f'id={c.get("id")}')
    ok('P2 Task com id e contextId', bool(t.get('id')) and bool(t.get('contextId')), f'task={t.get("id")} context={t.get("contextId")}')
    ok('P3 estado TASK_STATE_INPUT_REQUIRED', estado(c) == 'TASK_STATE_INPUT_REQUIRED', estado(c))
    ok('P4 mensagem exata', texto(c) == 'alternativas: sala-fusca, sala-mirante', texto(c))
    ok('P5 sem artifact', not t.get('artifacts'), t.get('artifacts'))
    pausada = t

    # ---- T11 escolha invalida (na mesma Task, antes da continuacao) ----
    print('== T11 Escolha invalida')
    antes = len(recv(a.log_mcp, tid_a))
    rid, st, c = enviar('escolha=sala-inexistente', pausada['id'], tp_a)
    ok('I1 continua TASK_STATE_INPUT_REQUIRED', estado(c) == 'TASK_STATE_INPUT_REQUIRED', estado(c))
    ok('I2 mesma lista, mesma ordem', texto(c) == 'alternativas: sala-fusca, sala-mirante', texto(c))
    ok('I3 mesmo id e contextId', task(c).get('id') == pausada['id'] and task(c).get('contextId') == pausada['contextId'])
    time.sleep(0.3)
    ok('I4 nenhum request MCP novo', len(recv(a.log_mcp, tid_a)) == antes, f'{antes} -> {len(recv(a.log_mcp, tid_a))}')

    # ---- T9 continuacao ----
    print('== T9 Continuacao escolha=sala-mirante (envelope do exemplo 10)')
    rid, st, c = enviar('escolha=sala-mirante', pausada['id'], tp_a)
    t = task(c)
    art = artifact_reserva(t)
    ok('K1 TASK_STATE_COMPLETED', estado(c) == 'TASK_STATE_COMPLETED', texto(c))
    ok('K2 artifact reserva com os 6 campos', art is not None and all(isinstance(art.get(k), str) and art.get(k) for k in ['reserva', 'sala', 'inicio', 'fim', 'responsavel', 'politica']), json.dumps(art, ensure_ascii=False))
    ok('K3 reserva na sala-mirante, intervalo e responsavel originais', art and art['sala'] == 'sala-mirante' and art['inicio'] == h('03', '14:00') and art['fim'] == h('03', '15:00') and art['responsavel'] == 'Marty')
    ok('K4 politica = versao lida de politica://uso (2026-11-01)', art and art['politica'] == '2026-11-01', art and art['politica'])
    time.sleep(0.3)
    linhas = recv(a.log_mcp, tid_a)
    calls = [x for x in linhas if x['metodo'] == 'tools/call' and x['nome'] == 'reservar_sala']
    ok('K5 no log: tools/list antes do 1o tools/call desta Task', any(x['metodo'] == 'tools/list' for x in linhas[:linhas.index(calls[0])]) if calls else False)
    ok('K6 no log: pausa e retry com o mesmo trace-id e ids JSON-RPC diferentes', len(calls) == 2 and calls[0]['id'] != calls[1]['id'], [x['id'] for x in calls])
    for x in linhas:
        print('   ' + x['linha'])
    rid, g = get_task(pausada['id'])
    tg = task(g)
    papeis = [m.get('role') for m in tg.get('history') or []]
    ok('K7 GetTask: id JSON-RPC, id e contextId preservados, COMPLETED', g.get('id') == rid and tg.get('id') == pausada['id'] and tg.get('contextId') == pausada['contextId'] and estado(g) == 'TASK_STATE_COMPLETED')
    ok('K8 GetTask: historico [pedido, pausa, invalida, pausa, escolha, conclusao]', papeis == ['ROLE_USER', 'ROLE_AGENT'] * 3, papeis)
    ok('K9 GetTask: mesmo artifact', artifact_reserva(tg) == art)
    rid, st, c = enviar('escolha=sala-fusca', pausada['id'], tp_a)
    ok('K10 Task concluida nao e retomada (-32004)', (c.get('error') or {}).get('code') == -32004, c.get('error'))

    # ---- T10 recusa ----
    print('== T10 Recusa')
    tid_r, tp_r = novo_trace()
    rid, st, c = enviar(pedido('sala-garagem', '03', '14:00', '15:00', 'Biff'), trace=tp_r)
    r_task = task(c)
    ok('R1 nova Task pausada (a mirante ja esta ocupada: so sobra a fusca)', estado(c) == 'TASK_STATE_INPUT_REQUIRED', texto(c))
    rid, st, c = enviar('escolha=recusar', r_task['id'], tp_r)
    ok('R2 TASK_STATE_CANCELED, sem artifact', estado(c) == 'TASK_STATE_CANCELED' and not task(c).get('artifacts'), texto(c))
    ok('R3 recusa nao e erro de execucao', 'error' not in c and 'falha' not in texto(c).lower(), texto(c))
    rid, st, c = enviar('escolha=sala-fusca', r_task['id'], tp_r)
    ok('R4 Task cancelada nao e retomada (-32004)', (c.get('error') or {}).get('code') == -32004)
    ok('R5 nenhuma reserva criada: sala-fusca 14-15 continua livre', livre('sala-fusca', '03', '14:00', '15:00') is True)
    linhas = recv(a.log_mcp, tid_r)
    ok('R6 no log: decline foi um tools/call com id novo no mesmo trace', len([x for x in linhas if x['metodo'] == 'tools/call']) == 2)

    # ---- T12 erro de dominio ----
    print('== T12 Erro de dominio propagado')
    rid, st, c = enviar(pedido('sala-inexistente', '03', '10:00', '11:00', 'Marty'))
    rid, g = get_task(task(c)['id'])
    hist = [''.join(p.get('text', '') for p in m.get('parts', [])) for m in task(g).get('history') or []]
    ok('D1 TASK_STATE_FAILED com a mensagem exata da tool', estado(c) == 'TASK_STATE_FAILED' and texto(c) == 'Sala inexistente: sala-inexistente', texto(c))
    ok('D2 a mensagem esta no historico (GetTask)', 'Sala inexistente: sala-inexistente' in hist, hist)
    st, c = mcp_wire('02-tools-call-livre.json', trocar=lambda p: p['arguments'].update(sala='sala-inexistente'))
    res = c.get('result') or {}
    ok('D3 direto no MCP: isError true, mesma mensagem, HTTP 200', st == 200 and res.get('isError') is True and res['content'][0]['text'] == 'Sala inexistente: sala-inexistente', f'http={st}')

    # ---- T15 capabilities ----
    print('== T15 Capability ausente')
    st, c = mcp_wire('06-erro-32021-sem-elicitation.json')
    err = c.get('error') or {}
    ok('E1 exemplo 06 (clientCapabilities {}): HTTP 400, -32021, data.requiredCapabilities', st == 400 and err.get('code') == -32021 and 'requiredCapabilities' in (err.get('data') or {}), f'http={st} code={err.get("code")} data={err.get("data")}')
    st, c = mcp_wire('06-erro-32021-sem-elicitation.json', trocar=lambda p: p['_meta'].pop('io.modelcontextprotocol/clientCapabilities'))
    err = c.get('error') or {}
    ok('E2 sem o campo clientCapabilities: HTTP 400, -32602', st == 400 and err.get('code') == -32602, f'http={st} code={err.get("code")} msg={err.get("message")!r}')

    # ---- T14 fase 1 ----
    print('== T14 Restart, fase 1: guardar um requestState valido (exemplo 03)')
    st, c = mcp_wire('03-tools-call-conflito-input-required.json', trocar=lambda p: p['arguments'].update(responsavel='Doc'))
    r = c.get('result') or {}
    chave = next(iter(r.get('inputRequests') or {'?': 0}))
    pathlib.Path(a.estado).write_text(json.dumps({'chave': chave, 'estado': r.get('requestState'), 'enum': r['inputRequests'][chave]['params']['requestedSchema']['properties']['sala']['enum']}), encoding='utf-8')
    ok('Z1 estado e chave guardados fora do repositorio (nao impressos)', r.get('resultType') == 'input_required', resumo_estado(r.get('requestState')) + f', chave {chave!r}, alternativas {r["inputRequests"][chave]["params"]["requestedSchema"]["properties"]["sala"]["enum"]}')

    # ---- T13 requestState adulterado (exemplo 03 + retry do exemplo 04) ----
    print('== T13 requestState adulterado (depois de T15 e T14: S5 ocupa a ultima alternativa das 14h)')
    st, c = mcp_wire('03-tools-call-conflito-input-required.json')
    r = c.get('result') or {}
    rs = r.get('requestState', '')
    chave = next(iter(r.get('inputRequests') or {'?': 0}))
    ok('S1 exemplo 03: input_required com requestState', st == 200 and r.get('resultType') == 'input_required' and rs.startswith('v1.'), resumo_estado(rs) + f', chave {chave!r}')
    i = len(rs) // 2
    adulterado = rs[:i] + ('A' if rs[i] != 'A' else 'B') + rs[i + 1:]

    def retry(p, estado_, escolha='sala-fusca'):
        p['inputResponses'] = {chave: {'action': 'accept', 'content': {'sala': escolha}}}
        p['requestState'] = estado_
    st, c = mcp_wire('04-tools-call-retry.json', trocar=lambda p: retry(p, adulterado))
    err = c.get('error') or {}
    ok('S2 um caractere trocado: erro JSON-RPC -32602', err.get('code') == -32602, f'http={st} code={err.get("code")} msg={err.get("message")!r}')
    ok('S3 a resposta nao ecoa o estado nem o segredo', rs not in json.dumps(c) and adulterado not in json.dumps(c) and (seg is None or seg not in json.dumps(c)))
    ok('S4 nenhuma reserva criada pelo retry adulterado (fusca 14-15 livre)', livre('sala-fusca', '03', '14:00', '15:00') is True)
    st, c = mcp_wire('04-tools-call-retry.json', trocar=lambda p: (retry(p, rs), p.update(arguments={'sala': 'sala-aquario', 'inicio': h('03', '09:00'), 'fim': h('03', '10:00'), 'responsavel': 'Biff'})))
    sc = (c.get('result') or {}).get('structuredContent') or {}
    ok('S5 argumentos adulterados com estado valido: vale o pedido selado', sc.get('reservado') is True and sc.get('sala') == 'sala-fusca' and sc.get('inicio') == h('03', '14:00') and sc.get('responsavel') == 'Marty', json.dumps(sc, ensure_ascii=False)[:160])
    print('   (S5 reservou a sala-fusca 14-15 para Marty, que e o efeito correto do estado valido)')

    # ---- T16 isolamento ----
    print('== T16 Duas Tasks pausadas, retomadas em ordem inversa (dia 04/11)')
    for sala in ['sala-garagem', 'sala-porao']:
        enviar(pedido(sala, '04', '10:00', '11:00', 'Ocupante'))
    tid_x, tp_x = novo_trace()
    tid_y, tp_y = novo_trace()
    _, _, ca = enviar(pedido('sala-garagem', '04', '10:00', '11:00', 'Alice'), trace=tp_x)
    ok('X1 Task A pausada', estado(ca) == 'TASK_STATE_INPUT_REQUIRED', texto(ca))
    _, _, cb = enviar(pedido('sala-porao', '04', '10:00', '11:00', 'Bob'), trace=tp_y)
    ok('X2 Task B pausada', estado(cb) == 'TASK_STATE_INPUT_REQUIRED', texto(cb))
    ta, tb = task(ca), task(cb)
    ok('X3 Tasks e contextos diferentes', ta['id'] != tb['id'] and ta['contextId'] != tb['contextId'])
    _, _, rb = enviar('escolha=sala-mirante', tb['id'], tp_y)
    _, _, ra = enviar('escolha=sala-fusca', ta['id'], tp_x)
    aa, ab = artifact_reserva(task(ra)), artifact_reserva(task(rb))
    ok('X4 B (retomada primeiro): mirante, Bob, 10-11', estado(rb) == 'TASK_STATE_COMPLETED' and ab and ab['sala'] == 'sala-mirante' and ab['responsavel'] == 'Bob', json.dumps(ab, ensure_ascii=False))
    ok('X5 A (retomada depois): fusca, Alice, 10-11', estado(ra) == 'TASK_STATE_COMPLETED' and aa and aa['sala'] == 'sala-fusca' and aa['responsavel'] == 'Alice', json.dumps(aa, ensure_ascii=False))
    ok('X6 reservas diferentes', aa and ab and aa['reserva'] != ab['reserva'])
    _, ga = get_task(ta['id']); _, gb = get_task(tb['id'])
    ha = json.dumps(task(ga).get('history')); hb = json.dumps(task(gb).get('history'))
    ok('X7 historicos isolados (nenhum cita o responsavel do outro)', 'Bob' not in ha and 'Alice' not in hb and 'Alice' in ha and 'Bob' in hb)
    la, lb = recv(a.log_mcp, tid_x), recv(a.log_mcp, tid_y)
    ida = {x['id'] for x in la if x['metodo'] == 'tools/call'}; idb = {x['id'] for x in lb if x['metodo'] == 'tools/call'}
    ok('X8 no log: cada Task no seu trace, 2 tools/call cada, nenhum id compartilhado', len(ida) == 2 and len(idb) == 2 and not (ida & idb), f'A={sorted(ida)} B={sorted(idb)}')

    # ---- T17 vazamento ----
    print('== T17 Vazamento nas superficies publicas do A2A')
    tudo = '\n'.join(publico)
    for termo in ['requestState', 'inputRequests', 'inputResponses', 'escolha_de_sala', 'continuacao', 'REQUEST_STATE_SECRET', '7301', '"v1.']:
        ok(f'V {termo!r} nao aparece em card, SendMessage, continuacoes, GetTask, historico e artifacts', termo not in tudo)
    ok('V o valor do segredo nao aparece em nenhuma resposta publica', seg is None or seg not in tudo, 'segredo lido de servidor-mcp/.env so para comparar' if seg else 'sem .env: conferencia do valor pulada')
    print(f'   ({len(publico)} respostas publicas inspecionadas)')


def fase_restart(a):
    print('== T14 Restart, fase 2: retry com o estado emitido ANTES do restart')
    s = json.loads(pathlib.Path(a.estado).read_text(encoding='utf-8'))

    def retry(p):
        p['arguments']['responsavel'] = 'Doc'
        p['inputResponses'] = {s['chave']: {'action': 'accept', 'content': {'sala': 'sala-fusca'}}}
        p['requestState'] = s['estado']
    st, c = mcp_wire('04-tools-call-retry.json', trocar=retry)
    r = c.get('result') or {}
    sc = r.get('structuredContent') or {}
    ok('Z2 resultType complete', st == 200 and r.get('resultType') == 'complete', f'http={st} resultType={r.get("resultType")} erro={c.get("error")}')
    ok('Z3 reserva concluida com o pedido reconstruido do estado (garagem->fusca, 14-15, Doc)', sc.get('reservado') is True and sc.get('sala') == 'sala-fusca' and sc.get('inicio') == h('03', '14:00') and sc.get('responsavel') == 'Doc', json.dumps(sc, ensure_ascii=False)[:200])
    print('   Nota: a agenda em memoria recomecou de dados/ no restart; o que sobreviveu foi a capacidade de validar e interpretar o requestState.')
    pathlib.Path(a.estado).unlink()
    print('   arquivo de estado temporario apagado')


ap = argparse.ArgumentParser()
ap.add_argument('fase', choices=['logs', 'manual', 'restart'])
ap.add_argument('--log-mcp')
ap.add_argument('--trace-id')
ap.add_argument('--estado')
a = ap.parse_args()
{'logs': fase_logs, 'manual': fase_manual, 'restart': fase_restart}[a.fase](a)
print(f'\nresumo: {len(falhas)} falha(s)' + (': ' + '; '.join(falhas) if falhas else ''))
sys.exit(1 if falhas else 0)
