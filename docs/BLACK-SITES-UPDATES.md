# Atualizações da Black Sites

Este repositório mantém as customizações da Black Sites e acompanha o DeskcommCRM oficial em `https://github.com/melgarafael/DeskcommCRM`.

## Como funciona

- A rotina `Sincronizar DeskcommCRM oficial` roda toda segunda-feira e também pode ser executada manualmente em GitHub Actions.
- Ela busca `upstream/main`, cria ou atualiza a branch `automation/sync-upstream` e abre um pull request.
- O merge nunca é automático: migrations, worker, imagens Docker e testes devem ser revisados antes de entrar em `main`.
- Se houver conflito, a rotina falha e preserva `main` intacta para resolução manual.
- O workflow de release com GitHub App permanece reservado ao repositório oficial; o fork não copia credenciais nem tenta executar esse corte.

## Sincronização local

```bash
git fetch upstream --tags
git switch feature/disparos-prospeccao
git merge upstream/main
pnpm typecheck && pnpm lint && pnpm build
git push origin feature/disparos-prospeccao
```

O remoto `origin` aponta para este repositório; `upstream` aponta para o projeto oficial. A instalação em produção deve consumir somente releases aprovadas deste repositório customizado.
