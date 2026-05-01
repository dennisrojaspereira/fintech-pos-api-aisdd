# fintech-pos-api

API de Point-of-Sale para fintech, construída sob disciplina de **Spec-Driven Development (SDD)** com o pacote [`ai-sdd`](https://classic.yarnpkg.com/en/package/ai-sdd) de Leonardo Sampaio.

## Pré-requisitos

- Node.js >= 20
- npm 10+ (ou yarn 1.x clássico)

## Setup do ai-sdd

Rode no diretório do projeto (Windows/PowerShell ou bash):

```bash
# Instala os slash commands do ai-sdd para Claude Code
npx ai-sdd@latest

# Alternativas por agente:
# npx ai-sdd@latest --claude        (Claude Code)
# npx ai-sdd@latest --cursor        (Cursor IDE)
# npx ai-sdd@latest --gemini        (Gemini CLI)
# npx ai-sdd@latest --copilot       (GitHub Copilot)
```

Após o setup, os comandos abaixo ficam disponíveis:

| Comando | Fase |
|---|---|
| `/sdd:spec-init "<feature>"` | Cria o esqueleto da spec |
| `/sdd:spec-requirements <feature>` | Gera requisitos no formato EARS |
| `/sdd:spec-design <feature>` | Gera o design técnico |
| `/sdd:spec-tasks <feature>` | Quebra em tarefas executáveis |
| `/sdd:spec-impl <feature>` | Executa a implementação |

## Fluxo SDD em 4 fases

1. **Requirements** — clarifica o "o quê" e "por quê" antes de qualquer linha de código.
2. **Design** — define arquitetura, contratos, modelos de dados.
3. **Tasks** — fragmenta em pacotes pequenos, revisáveis e paraleláveis.
4. **Implementation** — codifica seguindo as tarefas aprovadas.

Cada fase tem **checkpoint de aprovação humana** antes de avançar.

## Estrutura prevista (após `npx ai-sdd`)

```
fintech-pos-api/
├── .sdd/                    # specs versionadas (criada pelo ai-sdd)
│   └── <feature>/
│       ├── spec.md
│       ├── design.md
│       └── tasks.md
├── .claude/commands/        # slash commands (Claude Code)
├── package.json
└── README.md
```
