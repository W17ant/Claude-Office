# Security Review

Data da revisão: 2026-11-09

## Escopo

Foi realizada uma varredura estática do projeto com foco em:

- chaves de API, tokens e outros segredos versionados;
- exposição de contexto local ou prompts ao Claude;
- endpoints sem autenticação;
- download e execução de binários durante o empacotamento;
- testes e mecanismos existentes de hardening.

## Achados e correções

| # | Severity | File | Lines | Vulnerability | Confidence |
|---|----------|------|-------|---------------|------------|
| 1 | MEDIUM | `server/index.js`, `scripts/chat-ai-watcher.sh` | 1973-2019, 184-209 | O endpoint `POST /chat` aceita mensagens sem autenticação. O watcher combina mensagens controláveis pelo chamador com persona, contexto local e contexto de desenvolvimento antes de enviar o prompt para `claude -p`. Isso permite prompt injection e possível extração textual de contexto sensível. | 8/10 |
| 2 | MEDIUM | `electron/after-pack.cjs` | 39-48 | O empacotamento baixa e executa um binário nativo remoto via `prebuild-install`, selecionado por versão do Electron e arquitetura, sem verificação explícita de checksum ou digest fixado pelo projeto. | 8/10 |

### Status das correções

- **Achado 1 corrigido:** `POST /chat` agora exige o token bearer. A UI e o watcher enviam o token; o watcher também exige autenticação para ler o contexto completo. Persona e contexto de desenvolvimento não são enviados ao Claude. O prompt delimita as mensagens como conteúdo não confiável e proíbe revelar contexto privado.
- **Achado 2 corrigido:** o hook de empacotamento exige `BETTER_SQLITE3_PREBUILD_SHA256` e compara o SHA-256 do binário nativo produzido antes de aceitar o pacote.

## Recomendações

1. Manter o watcher sem acesso a persona e contexto local; somente as mensagens explicitamente enviadas no chat devem chegar ao Claude.
2. Gerar e fornecer o SHA-256 correto para cada artefato nativo durante o empacotamento; o build falha sem esse valor.
3. Antes de publicar ou compartilhar o projeto, revisar também os arquivos fora do Git, variáveis de ambiente, credenciais do Claude CLI e configurações do provedor. Esses valores não podem ser avaliados por uma varredura do repositório.

## Resultado da busca por segredos

Não foram encontradas chaves reais ou tokens de API no conteúdo versionado examinado. Placeholders e exemplos foram tratados como não-segredos. A ausência de achados no repositório não garante que credenciais não estejam presentes no ambiente local, no histórico completo não acessível ou em arquivos ignorados pelo Git.

## Limitações

- A revisão foi estática e não inspecionou valores presentes somente no ambiente de execução, arquivos fora do repositório ou credenciais do Claude CLI.
- O histórico Git acessível não apresentou chaves reais na busca por padrões comuns.
- A suíte completa ainda não foi considerada limpa: alguns testes de permissões de arquivo falham no Windows porque o sistema não aplica os bits POSIX esperados, e os testes de scripts Linux dependem de comandos Unix ausentes. Os testes focados nas correções passaram.

## Validação das dependências npm

- `npm audit signatures`: 505 pacotes com assinaturas verificadas pelo registry e nenhum pacote com assinatura inválida ou ausente.
- O `package-lock.json` contém 586 artefatos resolvidos, todos em `https://registry.npmjs.org/`, com integridade registrada.
- `npm ci --ignore-scripts --dry-run` não reportou alterações no lockfile.
- Os únicos scripts de instalação encontrados foram os esperados para `better-sqlite3`, Electron e esbuild; não foi encontrado script suspeito no conjunto instalado.
- As atualizações compatíveis do lockfile removeram as vulnerabilidades críticas e altas de produção. `npm audit --omit=dev` agora reporta apenas 1 vulnerabilidade moderada transitiva em `qs`; o audit completo ainda inclui vulnerabilidades de ferramentas de desenvolvimento. Isso é risco de vulnerabilidade conhecido, não evidência de pacote malicioso.
