# Security Review

Data da revisão: 2026-11-09

## Escopo

Foi realizada uma varredura estática do projeto com foco em:

- chaves de API, tokens e outros segredos versionados;
- exposição de contexto local ou prompts ao Claude;
- endpoints sem autenticação;
- download e execução de binários durante o empacotamento;
- testes e mecanismos existentes de hardening.

## Achados

| # | Severity | File | Lines | Vulnerability | Confidence |
|---|----------|------|-------|---------------|------------|
| 1 | MEDIUM | `server/index.js`, `scripts/chat-ai-watcher.sh` | 1973-2019, 184-209 | O endpoint `POST /chat` aceita mensagens sem autenticação. O watcher combina mensagens controláveis pelo chamador com persona, contexto local e contexto de desenvolvimento antes de enviar o prompt para `claude -p`. Isso permite prompt injection e possível extração textual de contexto sensível. | 8/10 |
| 2 | MEDIUM | `electron/after-pack.cjs` | 39-48 | O empacotamento baixa e executa um binário nativo remoto via `prebuild-install`, selecionado por versão do Electron e arquitetura, sem verificação explícita de checksum ou digest fixado pelo projeto. | 8/10 |

## Recomendações

1. Exigir autenticação para mensagens consumidas pelo watcher ou restringir o endpoint a uma origem confiável. Tratar mensagens do chat como conteúdo não confiável, usando delimitadores e instruções explícitas para impedir que elas substituam as regras do agente. Não incluir persona, contexto local ou contexto de desenvolvimento que contenha dados sensíveis sem opt-in explícito.
2. Fixar e verificar o artefato nativo por checksum/digest, ou baixar binários previamente auditados e versionados em um pipeline confiável.
3. Antes de publicar ou compartilhar o projeto, revisar também os arquivos fora do Git, variáveis de ambiente, credenciais do Claude CLI e configurações do provedor. Esses valores não podem ser avaliados por uma varredura do repositório.

## Resultado da busca por segredos

Não foram encontradas chaves reais ou tokens de API no conteúdo versionado examinado. Placeholders e exemplos foram tratados como não-segredos. A ausência de achados no repositório não garante que credenciais não estejam presentes no ambiente local, no histórico completo não acessível ou em arquivos ignorados pelo Git.

## Limitações

- A revisão foi estática e não inspecionou valores presentes somente no ambiente de execução, arquivos fora do repositório ou credenciais do Claude CLI.
- O histórico Git acessível não apresentou chaves reais na busca por padrões comuns.
- Os testes não foram executados porque `vitest` não está instalado/disponível neste ambiente.
