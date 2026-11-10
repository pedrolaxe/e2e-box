# e2e-box

Runner e2e Android via adb com fluxos YAML no formato do Maestro.

- `src/lib/engine.ts`: executa os comandos; `hierarchy.ts`: parse do `uiautomator dump` e seletores; `adb.ts`: wrapper do adb; `flows.ts`: parse do YAML e workspaces; `hub.ts`: estado do servidor (singleton em `globalThis`), uma execução por device e eventos; `lock.ts`: trava por device entre processos (painel e CLI).
- `src/lib/agent.ts` + `agent/src/dev/e2ebox/Agent.java`: agente no celular (app_process, socket `e2e-box-agent` via adb forward) que lê a tela em ~20ms e digita acento. Mudou o Java? `node agent/build.mjs` e commite o `agent/dist/e2e-box-agent.jar`.
- `src/app/api/*`: rotas (SSE em `/api/events`, espelho em `/api/video` (H.264, decodificado em `src/components/h264.ts`) e `/api/screen` (print), gravador/inspetor em `/api/action`). `src/middleware.ts` barra chamadas de fora da página.
- Teste no celular real: o `back` pode sair do app e o próximo toque cair no launcher; confira a tela antes de tocar por coordenada.
- Pastas de fluxos no repo do app: `.e2e-box/` e `.maestro/` (`FLOW_DIRS` em `config.ts`). Sem `workspaces` na config, viram workspaces; a CLI sem alvo roda essas pastas. `config.yaml` na raiz delas é do Maestro, não fluxo (`isFlowFile`).
- Textos do painel: `src/lib/i18n.tsx` (pt-BR e en, `useI18n()`); idioma no cookie `e2e-box-lang`, lido no `layout.tsx` (`lang.ts`). Texto novo na interface entra nos dois idiomas. Log do motor, erros das rotas e CLI seguem em português.
- `bin/e2e-box.ts`: CLI (`pnpm e2e`). O lib usa imports relativos para a CLI rodar com `tsx`.
- Comando novo do Maestro: adicionar no `switch` de `execCommand` e na tabela do README.
- Porta 3334. Verificação: `pnpm typecheck`.
