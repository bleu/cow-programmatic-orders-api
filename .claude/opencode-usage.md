# Usar OpenCode com a pasta .claude

O OpenCode procura comandos e agentes em `.opencode/`, não em `.claude/`. Para manter tudo em `.claude` e continuar usando esses comandos e agentes no OpenCode, use uma das opções abaixo.

## Opção 1: Variável de ambiente (recomendado)

Antes de iniciar o OpenCode, defina o diretório de config como a pasta `.claude` do projeto:

```bash
export OPENCODE_CONFIG_DIR="/Users/jefferson/Projects/Bleu/cow/cow-programmatic-orders-api/.claude"
opencode
```

Ou, a partir da raiz do projeto:

```bash
export OPENCODE_CONFIG_DIR="$PWD/.claude"
opencode
```

Assim o OpenCode usa `.claude/commands/` e `.claude/agents/` como se fossem `.opencode/commands/` e `.opencode/agents/`.

## Opção 2: Symlink (só no projeto)

Na raiz do repositório:

```bash
ln -s .claude .opencode
```

O OpenCode passará a encontrar comandos e agentes em `.opencode` (que aponta para `.claude`).  
**Atenção:** adicione `.opencode` ao `.gitignore` se não quiser commitar o symlink (ou use um script de setup no repo).

### Onde fica o symlink e como funciona

- O symlink é **um único “arquivo” na raiz do projeto**: o nome `.opencode` existe no disco, mas em vez de ser uma pasta com arquivos dentro, é um **ponteiro** que diz “o conteúdo está em `.claude`”.
- **Não há outra configuração**: o OpenCode não tem um arquivo que diz “use o symlink”. Por padrão ele sempre procura uma pasta chamada **`.opencode`** no projeto. Como criamos `.opencode` como link para `.claude`, ao abrir `.opencode/commands/` ele acaba lendo `.claude/commands/`.
- **Onde está**: na raiz do repo, ao lado de `package.json`, `.claude`, etc. Você pode ver com `ls -la` (aparece algo como `.opencode -> .claude`).

## Modelo: como escolher e trocar como escolher e trocar

### Abrir já com um modelo específico

1. **Pela linha de comando** (tem prioridade sobre o config):
   ```bash
   opencode --model anthropic/claude-sonnet-4-5
   # ou forma curta:
   opencode -m anthropic/claude-sonnet-4-5
   ```
   Formato: `provider/model` (ex.: `anthropic/claude-sonnet-4-5`, `opencode/gpt-5.1-codex`).

2. **Pelo config** (projeto ou global):
   - No projeto: edite `opencode.json` na raiz e defina `"model": "provider/model"`.
   - Global: `~/.config/opencode/opencode.json`.

Ordem de prioridade ao iniciar: (1) flag `--model`, (2) config do projeto/global, (3) último modelo usado, (4) primeiro da lista interna.

### Trocar de modelo no meio da sessão

- **`/models`** (ou atalho **Ctrl+x m**): abre a lista de modelos disponíveis para você escolher outro. Pode trocar a qualquer momento na TUI.
- **Ctrl+t**: alterna entre **variantes** do mesmo modelo (ex.: reasoning alto/baixo no Claude), não entre modelos diferentes.

### Ver modelos disponíveis no terminal

```bash
opencode models
opencode models anthropic   # só de um provider
opencode models --refresh   # atualizar cache
```

## Um formato só: OpenCode + Cursor + Claude Code

Mantemos **uma única pasta** (`.claude`) e **um único formato** de frontmatter nos agentes para funcionar nos três sem duas cópias.

### Por que `tools: Grep, Glob, LS` quebrava o OpenCode?

- **OpenCode** exige que `tools` seja um **objeto** (record), ex.: `tools: { write: false, edit: false }`, para ligar/desligar ferramentas. Ao ver `tools: Grep, Glob, LS` (string), o parser reclama: *"expected record, received string"* e o OpenCode não inicia.
- **Cursor** e **Claude Code** usam outra convenção: para eles `tools` é uma **lista de nomes** de ferramentas permitidas (ex.: string "Grep, Glob, LS" ou array em YAML). Por isso o mesmo arquivo funcionava neles.

### Formato único adotado: sem `tools` no frontmatter

- **Sem a chave `tools`**: OpenCode aceita e usa as ferramentas padrão; Cursor e Claude Code também usam o padrão deles. Nenhum dos três dá erro.
- A **descrição** e o **texto do agente** continuam orientando o uso (ex.: “You locate WHERE code lives… use Grep, Glob”). A restrição deixa de ser “só estas ferramentas” no config e passa a ser só na instrução; na prática o comportamento fica parecido.

### Impacto em Cursor e Claude Code

- **Remover `tools`** não quebra Cursor nem Claude Code: os agentes continuam disponíveis e usáveis.
- A única diferença: o subagente deixa de ter **restrição rígida** de ferramentas no config (ex.: “só Grep, Glob, LS”). Ele passa a ter o conjunto padrão de ferramentas de cada produto. O prompt ainda diz para preferir Grep/Glob/LS quando fizer sentido.
- Se no futuro Cursor ou Claude Code passarem a aceitar o formato de `tools` do OpenCode (objeto), dá para voltar a restringir por ferramenta mantendo um único formato.

## Instruções do projeto: CLAUDE.md / AGENTS.md (sem symlink)

Para as **instruções gerais do projeto** (o “claude.md” que orienta o modelo no repo), **não precisa de symlink**. O OpenCode já lê os dois nomes.

### Qual arquivo o OpenCode usa?

O OpenCode procura, **subindo a partir do diretório atual**, o primeiro que existir:

1. **`AGENTS.md`** (nome nativo do OpenCode)
2. **`CLAUDE.md`** (compatibilidade com Claude Code / Cursor)

Ou seja: pode ter **só um** na raiz do projeto. Tanto faz ser `AGENTS.md` ou `CLAUDE.md` — o OpenCode usa o que achar.

### Onde criar

- **Raiz do projeto** (recomendado para regras do repo todo): crie `CLAUDE.md` ou `AGENTS.md` na mesma pasta que tem `package.json`. Esse é o “arquivo base” de instruções do projeto.
- **Subpasta** (ex.: `hack/CLAUDE.md`): se existir um `CLAUDE.md` ou `AGENTS.md` dentro de uma pasta, o OpenCode pode usá-lo quando o contexto for essa pasta (depende de como ele faz o traverse). Na raiz é o que vale para o projeto inteiro.

### Resumo

| O que                     | Onde fica              | Precisa de symlink? |
|---------------------------|------------------------|----------------------|
| Comandos e agentes        | `.opencode/` ou `.claude/` | Sim (ou `OPENCODE_CONFIG_DIR`) — por isso o symlink `.opencode` → `.claude` |
| Instruções do projeto     | `CLAUDE.md` ou `AGENTS.md` na raiz | Não — OpenCode já lê os dois. Crie um arquivo e pronto. |
