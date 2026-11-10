# e2e-box

Testes e2e no app nativo Android **via adb**, com fluxos YAML no formato do Maestro.
Painel local em Next.js com espelho do celular, log ao vivo, fila de passos e gravador de fluxos.

## Rodar

```bash
pnpm install
pnpm dev            # http://127.0.0.1:3334
```

Pré-requisitos: `adb` (Android SDK platform-tools) e um Android com **depuração USB** ligada (ou um emulador).
O adb é procurado em `ADB_PATH`, `ANDROID_HOME`, `%LOCALAPPDATA%\Android\Sdk` e por fim no `PATH`.

## Agente no celular

Para ler a tela rápido, o e2e-box envia um agente pequeno (`agent/dist/e2e-box-agent.jar`, ~5KB) para
`/data/local/tmp` e o roda com `app_process` (sem instalar APK). Ele mantém a conexão de acessibilidade
aberta e responde em ~20ms, contra 1–3s do `uiautomator dump`; também digita texto **com acento** direto
no campo focado (sem ADBKeyboard). Sobe sozinho na primeira leitura de tela e é reenviado quando o jar muda.

- Com o agente, o motor espera a **tela estabilizar** (duas leituras iguais) depois de cada ação, em vez de
  pausas fixas. Sem ele (`E2E_BOX_NO_AGENT=1` ou se não subir), volta ao `uiautomator dump` e às pausas.
- Enquanto o agente está conectado, o `uiautomator dump` de fora não funciona (só um cliente por vez).
- Segurança: cada sessão sobe o seu agente (encerra os anteriores), com nome de socket e segredo
  aleatórios; o agente só aceita conexões de `shell`/root e os dois lados provam o segredo por
  HMAC antes de qualquer comando. Outro app do aparelho não lê a tela nem recebe o que é digitado.
- Só um processo roda fluxo por celular: painel e CLI derrubariam o agente um do outro. Quem chega depois recebe
  um aviso de quem está rodando, e o inspetor e o gravador ficam bloqueados nesse celular até acabar.
- Recompilar depois de mexer em `agent/src`: `node agent/build.mjs` (JDK 17+ e Android SDK com build-tools).

## Workspaces

`e2e-box.config.json` lista as pastas de fluxos. Vem com **Exemplos** (`./flows`), que abre as Configurações e roda
em qualquer Android.

Para o seu app, o ideal é versionar os fluxos no repo dele e clonar o e2e-box ao lado. O `+` da barra lateral sugere
as pastas vizinhas e detecta o `appId` de apps Expo/React Native, ou edite o arquivo:

```json
{ "id": "meu-app", "name": "Meu app", "dir": "../meu-app/.maestro", "appId": "com.empresa.meuapp" }
```

Usuário e senha de teste ficam em `e2e-box.local.json` (fora do git), por workspace; veja `e2e-box.local.example.json`.

Arquivos em subpastas aparecem como subfluxos (chamados por `runFlow`).

## Criando fluxos pela interface

1. `+` no workspace cria o arquivo.
2. No espelho, escolha o modo:
   - **inspecionar**: clicar mostra o elemento (texto, desc, id) e sugere passos (`tapOn`, `assertVisible`, `point`).
   - **● gravar**: cada toque/arraste vai para o device **e** vira um passo no YAML, na linha do cursor.
     - Rolagem vertical vira `scrollUntilVisible` até o elemento do próximo toque (ou `scroll` se não houver).
     - Texto que muda vira regex: saudação com nome (`"Olá .*"`) já entra assim; números (`"Agendas \(\d+\)"`) ficam como opção.
     - Tocar num campo de texto foca a caixa "digitar no device", e o que for digitado vira `inputText`.
     - Parar: botão **■ parar e salvar**, **■ REC** em cima da tela ou **Esc** (salva o YAML).
   - **controlar**: só controla o device.
3. Campo "digitar no device" gera `inputText`; botões voltar/fechar teclado/↵ geram `back`/`hideKeyboard`/`pressKey`.
4. `Ctrl+S` salva, `Ctrl+Enter` roda. Se faltar o `---` entre o cabeçalho e os passos, o e2e-box acrescenta.

O espelho usa **vídeo** (`screenrecord` em H.264, decodificado no navegador com WebCodecs, ~20–50 fps) e cai
para **print** (`screencap`, ~1 fps) se o navegador não suportar ou o vídeo falhar; o botão no rodapé do celular
alterna os dois. Só um vídeo por vez: a aba que abre o vídeo fica com ele, a outra passa para o print e retoma ao voltar a ela.

Cada execução fica em `runs/<data>/` com `report.json`; quando falha, também `falha.png` e `falha-hierarquia.xml`.

## Confiança nos testes

- **Passou sem checks**: se nenhum passo conferiu o resultado, o painel mostra "passou sem checks", em vez do verde, e a
  CLI avisa. Contam `assertVisible`, `assertNotVisible`, `assertTrue` e `extendedWaitUntil`; o que a pré-condição confere não conta.
- **Passos frágeis**: o editor aponta `tapOn: ""`, a raiz da tela (`id: action_bar_root`) e toques por `point`. Ao rodar, o
  motor lê o elemento sob o toque e o editor oferece trocar o passo por um seletor pelo texto.
- **Pré-condição**: `onFlowStart` no cabeçalho roda antes dos passos. Se falhar, o erro diz "Pré-condição não atendida" em vez de
  o fluxo sair tocando na tela errada. Exemplo: `onFlowStart: [{ runFlow: subflows/ir-para-home.yaml }]`.
- **Rodar um trecho**: com o cursor num passo, **▶ passo N** roda só ele e **▶ daqui** roda até o fim, na tela em que o
  celular está (sem `onFlowStart`). Trecho não muda o ponto do fluxo na lista.
- **Tela de execução**: clicar numa execução abre a linha do tempo, com um print por passo, o log de cada um e, na falha, o
  erro e o que estava na tela. Os prints ficam nas 30 execuções mais recentes; a CLI não os tira.
- **Instabilidade**: o botão **5x** roda o fluxo cinco vezes seguidas e mostra quantas passaram e em qual passo falhou.

## Vários celulares, cabo e rotação

- **Vários celulares**: cada um tem a sua execução. Escolha o aparelho no topo e rode; ao trocar, o painel mostra o
  log e os passos do outro, e a lista marca quem está `rodando`. O espelho mostra um celular por vez.
- **Celular desconectado**: o fluxo para na hora com "Celular desconectado" (sem esperar timeouts, sem `retry` e sem
  evidências). O painel espera o mesmo aparelho voltar, e o espelho e o agente religam sozinhos.
- **Tela girada**: o motor acompanha a rotação a cada passo (pontos em `%` e "dentro da tela") e o espelho reabre em
  paisagem, com os toques no lugar certo.

## CLI (CI / terminal)

```bash
pnpm e2e flows/configuracoes.yaml
pnpm e2e meu-app:login.yaml -e USUARIO=teste -v   # <workspace>:<arquivo>
pnpm e2e flows/              # todos os .yaml da raiz da pasta
pnpm e2e flows/ --all-devices  # em todos os celulares conectados, ao mesmo tempo
```

Sai com código 1 se algum fluxo falhar e 2 se não der para começar (sem device ou celular em uso).
`-d <serial>` escolhe o device; repita para vários, ou use `--all-devices`. Cada celular roda os fluxos em sequência,
e os celulares rodam em paralelo, com o serial no início de cada linha.

## Comandos suportados

| Comando | Observação |
|---|---|
| `launchApp` | `appId`, `clearState`, `stopApp`, `permissions` (concede as negadas) |
| `stopApp`, `killApp`, `clearState` | |
| `tapOn`, `doubleTapOn`, `longPressOn` | texto, `id`, `index`, `point: "50%,89%"`, `repeat`, `optional`, relativos (`below`, `above`, `leftOf`, `rightOf`, `childOf`, `containsChild`) |
| `inputText`, `inputRandom*`, `eraseText`, `copyTextFrom`, `pasteText` | acentos pelo agente; sem ele, pelo [ADBKeyboard](https://github.com/senzhk/ADBKeyBoard) se for o teclado ativo, ou sem acento (com aviso). Texto vindo de `${VAR}` aparece como `•••` no log |
| `pressKey`, `back`, `hideKeyboard` | Enter, Back, Home, Backspace, Tab, Escape, Volume… |
| `scroll`, `swipe`, `scrollUntilVisible` | `direction`, `start`/`end`, `from`, `timeout`, `visibilityPercentage` |
| `assertVisible`, `assertNotVisible`, `assertTrue`, `extendedWaitUntil` | espera até `lookupTimeoutMs` (7s) |
| `runFlow` | `file`, `commands`, `when: visible/notVisible/platform`, `env` |
| `repeat`, `retry` | `times`, `while`, `maxRetries` |
| `waitForAnimationToEnd`, `takeScreenshot`, `openLink` | |
| `wait: 1000` | extensão do e2e-box (pausa em ms) |

Variáveis: `${NOME}` vem do `env:` do cabeçalho, do `env` do workspace, do `runFlow` ou do campo env da interface / `-e` da CLI.
Os textos casam como no Maestro: regex que precisa casar o texto inteiro (sem diferenciar maiúsculas), contra `text`, `content-desc` e `hint`.

Ainda não suportados (são pulados com aviso): `evalScript`, `runScript`, `setLocation`, `travel`, `addMedia`, gravação de vídeo e comandos de IA.

Segurança: a API só aceita chamadas da própria página (Host local, Origin do app e JSON); workspaces ficam
na pasta que contém o e2e-box e subfluxos dentro do workspace.

## Licença

[MIT](LICENSE)
