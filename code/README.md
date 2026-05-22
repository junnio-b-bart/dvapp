# DivideConta

App web responsivo para revisar faturas de cartao, selecionar os itens que sao seus e salvar uma fatura filtrada por mes.

## MVP

- Carteira de cartoes
- Cadastro de cartao com fechamento, vencimento e lembretes
- Upload de foto/PDF com processamento OCR simulado
- Lista editavel de transacoes extraidas
- Selecao dos meus itens com total fixo no rodape
- Resumo antes de salvar
- Historico mensal por cartao
- PWA basico para abrir no navegador do PC e celular

## Rodar localmente

```bash
npm install
npm run server
npm run dev
```

O backend local sobe em `http://localhost:8787` e o Vite encaminha `/api` para ele. Os perfis criados ficam em `data/users.json`, que nao entra no Git.

## Publicar no GitHub

Depois de criar um repositorio vazio no GitHub:

```bash
git remote add origin https://github.com/SEU_USUARIO/divideconta.git
git branch -M main
git push -u origin main
```

Para publicar como site, use Vercel, Netlify ou GitHub Pages. O projeto ja inclui um workflow em `.github/workflows/deploy-pages.yml` para publicar o `dist` no GitHub Pages quando houver push na branch `main`.

```bash
npm run build
```
